import { mergeTokenUsage, TOKEN_USAGE_FIELDS } from "../../domain/usage";
import { localSettlementError } from "./settlementFailure";
import { observeContextEstimate } from "./contextEstimateObservability";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import type { ToolCallKind } from "../observability";
import { providerContextRejection } from "../providers/providerObservability";
import { providerRetryDelayMs, sleepWithSignal } from "../providers/providerRetry";
import type { ProviderAdapter, ProviderDroppedRoundRetry, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type {
  ModelToolCall,
  ProviderToolBridge,
  RunTool,
  ToolExecutionResult
} from "../tools/types";
import {
  continueToolLoop,
  reachedToolLoopBudget,
  type ToolLoopBudgets,
  type ToolLoopCall,
  type ToolLoopObservation,
  type ToolLoopOutcome,
  type ToolLoopProgress,
  type ToolLoopSettledCall,
  type ToolLoopSignal,
  type ToolLoopToolResult
} from "./toolLoop";
import { providerRequestContextRebuild } from "./runContextBudget";
import { canonicalJsonText } from "./contextCompactionContract";

/** A checkpointed decision that the next round is tool-free synthesis. Only
 * `budget_exhausted` is ever written; `no_progress` is derived from the
 * persisted calls of the previous round. */
export type ToolSynthesisMarker = "budget_exhausted" | "no_progress";

export type ProviderToolLoopContinuation = Readonly<{
  /** The previous round's batch exceeded the remaining call budget and was
   * neither persisted nor dispatched; this round answers without tools. */
  finalSynthesis?: ToolSynthesisMarker;
  providerResponseId: string | null;
  providerToolMessages: readonly unknown[];
  /** The run already consumed its one correction of a missing required call. */
  requiredToolCorrection?: true;
  /** Written immediately before the synthesis request is sent: a claimed
   * synthesis round without it was provably never dispatched. */
  synthesisDispatched?: true;
}>;

/** Why a round answers without tools. `calls` and `rounds` are an exactly
 * reached budget; the markers and `approval_required` also left planned calls
 * unexecuted. `approval_required`, like `no_progress`, is derived from
 * persisted calls: the previous round held only calls gated for the user's
 * approval and blocked repeats. `time`: the turn's time budget is used up
 * (known to live execution only; a batch it refused is checkpointed as
 * `budget_exhausted`). */
export type ToolSynthesisReason = ToolSynthesisMarker | "approval_required" | "calls" | "rounds" | "time";

export type ToolSynthesisDecision = Readonly<{
  /** The transient budget signal, when a budget ended tool use. */
  budget: NonNullable<ReturnType<typeof reachedToolLoopBudget>> | null;
  reason: ToolSynthesisReason;
}>;

/**
 * The one rule for a tool-free synthesis round, shared by live execution and
 * recovery: a checkpointed marker first, then a previous round awaiting the
 * user's approval, then one of only blocked repeats, then an exactly reached
 * budget. A run admitted without tools (`toolChoice: "none"`) is not
 * synthesis. A used-up time budget (`timeExhausted`, live execution only)
 * forces synthesis as well and is named as its cause unless the previous
 * round made no progress (only blocked repeats, or calls awaiting approval:
 * the approval, not the clock, is what the user acts on next).
 */
export function toolSynthesisDecision(input: Readonly<{
  /** The previous round awaits the user's approval (`roundAwaitsApproval`). */
  approvalRequired?: boolean;
  budgets: Pick<ToolLoopBudgets, "maxToolCalls" | "maxToolRounds">;
  continuation: Pick<ProviderToolLoopContinuation, "finalSynthesis">;
  initialToolChoice: ProviderRunRequest["toolChoice"];
  noProgress: boolean;
  progress: Pick<ToolLoopProgress, "toolCalls" | "toolRounds">;
  timeExhausted?: boolean;
}>): ToolSynthesisDecision | null {
  if (input.initialToolChoice === "none") return null;
  const reached = reachedToolLoopBudget(input.progress, input.budgets);
  if (input.timeExhausted === true && input.continuation.finalSynthesis !== "no_progress" && !input.noProgress &&
    input.approvalRequired !== true) {
    return { budget: null, reason: "time" };
  }
  if (input.continuation.finalSynthesis === "budget_exhausted") {
    return { budget: { kind: "calls", limit: input.budgets.maxToolCalls }, reason: "budget_exhausted" };
  }
  if (input.approvalRequired) return { budget: reached, reason: "approval_required" };
  if (input.continuation.finalSynthesis === "no_progress" || input.noProgress) {
    return { budget: reached, reason: "no_progress" };
  }
  return reached ? { budget: reached, reason: reached.kind } : null;
}

/** Server-owned and never persisted: built in the provider projection of
 * the synthesis request, by recovery the same way. */
export function toolSynthesisInstruction(reason: ToolSynthesisReason): string {
  const cause = reason === "no_progress"
    ? "repeated identical calls returned no new data"
    : reason === "approval_required" ? "a tool call waits for the user's approval in the chat"
    : reason === "time" ? "the time limit of this turn is close"
    : reason === "rounds" ? "the tool-round budget is exhausted" : "the tool-call budget is exhausted";
  const unexecuted = reason === "budget_exhausted" || reason === "no_progress" || reason === "approval_required"
    ? " Some planned tool calls were not executed."
    : reason === "time" ? " Planned tool calls may not have been executed." : "";
  return `Tool use is now disabled for this run: ${cause}.${unexecuted} Answer now using only the results already obtained, and state explicitly which parts were not verified or not completed.`;
}

/**
 * A tool reserved outside the budgets (a monitoring check's verdict). Its
 * first call never counts against them; any later call counts as an ordinary
 * one, so repeating it cannot extend the run. While it has not been called, a
 * round whose budget was exactly used up first offers it alone (other calls of
 * that round are refused into synthesis), so exhausting the business tools
 * cannot prevent it. `called`: a call of it already exists (recovery derives it).
 */
export type ToolLoopReservedCall = Readonly<{
  called: boolean;
  /** The round's ephemeral instruction, never persisted. */
  instruction: string;
  name: string;
}>;

/**
 * Whether this round offers only the outstanding reserved call instead of
 * tool-free synthesis: the decision was an exactly used budget (a refused
 * batch or a round without progress synthesizes at once). Shared by live
 * execution and recovery.
 */
export function reservedCallRound(
  decision: ToolSynthesisDecision | null,
  reserved: Pick<ToolLoopReservedCall, "called"> | undefined
): boolean {
  return decision !== null && reserved !== undefined && !reserved.called &&
    (decision.reason === "calls" || decision.reason === "rounds");
}

/** The instruction as the last provider tool message, in the bridge's form. */
export function toolSynthesisMessage(bridge: Pick<ProviderToolBridge, "provider">, text: string): unknown {
  return bridge.provider === "gemini"
    ? { type: "user_input", content: [{ type: "text", text }] }
    : bridge.provider === "anthropic"
      ? { role: "user", content: [{ type: "text", text }] }
      : { role: "user", content: text };
}

/** Removes the instruction again so no continuation, checkpoint or row keeps it. */
function withoutSynthesisMessage(messages: readonly unknown[], message: unknown): unknown[] {
  const text = canonicalJsonText(message);
  let index = messages.length - 1;
  while (index >= 0 && messages[index] !== message && canonicalJsonText(messages[index]) !== text) index -= 1;
  return index < 0 ? [...messages] : [...messages.slice(0, index), ...messages.slice(index + 1)];
}

/** A server-owned note on a settled result in the provider projection only. */
export function withProviderNote(result: ToolExecutionResult, note: string | undefined): ToolExecutionResult {
  return note ? { ...result, content: [...result.content, { type: "text", text: note }] } : result;
}

/**
 * Sends a dropped round again (PROVIDERS.md: Codex LB): the binding's
 * admission and the owner's guarded re-opening of the round. A request
 * counts as dropped only when the binding's decision recognizes its failure,
 * its usage was recorded as the round's partial usage and it accepted no
 * output other than text; the round's tool calls never exist before its
 * result, so none of them ran.
 */
export type ProviderToolLoopRoundRetry = Readonly<{
  policy: ProviderDroppedRoundRetry;
  /**
   * Re-opens the round immediately before its next request: the dropped
   * request's recorded usage leaves the round's usage (it stays one
   * operation of the run) and the text it published is withdrawn. False
   * keeps the drop as the round's failure.
   */
  reopen(input: Readonly<{ attempt: number; publishedText: boolean; round: number }>): Promise<boolean>;
  /** Seams of the shared provider backoff. */
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

/** The wait before the next request of a dropped round, or null to keep the
 * failure; every decision on a recognized drop is recorded. */
function droppedRoundRetryDelay(retry: ProviderToolLoopRoundRetry, input: Readonly<{
  acceptedOutput: boolean;
  attempt: number;
  error: unknown;
  signal: AbortSignal;
}>): number | null {
  const decision = retry.policy.decision(input.error);
  if (!decision) return null;
  const delayMs = !input.acceptedOutput && !input.signal.aborted && input.attempt < retry.policy.maxAttempts
    ? providerRetryDelayMs(input.attempt, decision.retryAfterMs, retry.random) : null;
  retry.policy.observe(delayMs === null
    ? { action: "stop", attempt: input.attempt, error: input.error }
    : { action: "retry", attempt: input.attempt, delayMs, error: input.error });
  return delayMs;
}

export type ProviderToolLoopResume = Readonly<{
  continuation: ProviderToolLoopContinuation;
  previousToolResults?: readonly ToolLoopSettledCall<ToolExecutionResult>[];
  progress?: ToolLoopProgress;
  seenCallIds?: readonly string[];
}>;

export type ProviderToolLoopInput = Readonly<{
  /**
   * Opt-in to the run's one bounded rebuild: a context-length rejection of a
   * round without any accepted output re-prepares that round under a
   * tightened budget and dispatches it once more. The owner allows it only
   * where every earlier rebuild is durably known (see `providerRequestContextRebuild`).
   */
  allowContextRebuild?: boolean;
  deferToolUntilBatchEnd?(call: ToolLoopCall): boolean;
  toolObservation?(call: ToolLoopCall): ToolLoopObservation | undefined;
  toolCallKind?(call: ToolLoopCall): ToolCallKind;
  adapter: ProviderAdapter;
  bridge: ProviderToolBridge;
  budgets: ToolLoopBudgets;
  executeTool(
    call: ModelToolCall,
    context: Readonly<{ ordinal: number; round: number; signal: AbortSignal }>
  ): Promise<ToolLoopToolResult<ToolExecutionResult>>;
  initialRequest: ProviderRunRequest;
  onToolArguments?(input: { round: number; event: import("../providers/types").ProviderToolArgumentEvent }): Promise<void>;
  onEvent?(event: ModelRunSseEvent): Promise<void> | void;
  onFinalSynthesis?(budget: NonNullable<ReturnType<typeof reachedToolLoopBudget>>): Promise<void> | void;
  /** Persist the refused round's synthesis decision (`finalSynthesis`) and
   * claim its successor before any synthesis I/O. */
  onFinalSynthesisTransition?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    round: number;
  }>): Promise<void> | void;
  /** Durably mark the claimed synthesis round dispatched, immediately before
   * each provider request of it. */
  beforeSynthesisDispatch?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    round: number;
  }>): Promise<void> | void;
  /** True only for a persisted call blocked as a repeat without progress. */
  isRepeatBlockedCall?(call: ToolLoopCall): boolean;
  /** True only for a persisted call gated for the user's approval. */
  isApprovalGatedCall?(call: ToolLoopCall): boolean;
  /** A server-owned repeat note for a settled result, in the projection only. */
  toolResultNoteForProvider?(entry: ToolLoopSettledCall<ToolExecutionResult>): string | undefined;
  onProviderResult?(input: Readonly<{
    request: ProviderRunRequest;
    result: ProviderRunResult;
    round: number;
  }>): Promise<void> | void;
  /** Persist the successful round and claim its successor before any retry I/O. */
  onRequiredToolCorrection?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    round: number;
  }>): Promise<void> | void;
  onSignal?(signal: ToolLoopSignal): Promise<void> | void;
  onToolBatchSettled?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolExecutionResult>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  onUsage?(
    usage: ModelRunUsage,
    request: ProviderRunRequest,
    /** `costUsd`: what the provider reported the round's call cost, when it did. */
    context: Readonly<{ completeness: "partial" | "terminal"; costUsd?: number; round: number }>
  ): Promise<void> | void;
  parallelToolCalls: boolean;
  prepareRequest?(request: ProviderRunRequest, round: number): Promise<ProviderRunRequest> | ProviderRunRequest;
  /**
   * The request the adapter actually dispatched for this round, without any
   * clarification tail. The owner may re-prepare a round while dispatching it
   * (for example after delivering a clarification); later rounds and the
   * durable continuation then carry that exact summary state and projection.
   */
  dispatchedRequest?(input: Readonly<{ request: ProviderRunRequest; round: number }>): ProviderRunRequest | undefined;
  /** Normalize a known provider alias against the tools advertised in this round. */
  normalizeToolCallName?(name: string, advertisedToolNames: ReadonlySet<string>): string;
  projectToolResultForProvider?(
    result: ToolExecutionResult,
    context: Readonly<{ round: number }>
  ): ToolExecutionResult;
  beforeProviderRound?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    request: ProviderRunRequest;
    round: number;
  }>): Promise<void> | void;
  persistToolBatch?(input: Readonly<{
    calls: readonly ToolLoopCall[];
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  /** A tool reserved outside the budgets; see `ToolLoopReservedCall`. */
  reservedCall?: ToolLoopReservedCall;
  /** The turn's time budget is used up: the next round is tool-free
   * synthesis and a batch returned from now on is refused into it. */
  timeBudgetExhausted?(): boolean;
  /** Present only for a binding that admits sending a dropped round again. */
  roundRetry?: ProviderToolLoopRoundRetry;
  afterToolBatch?(input: Readonly<{
    continuation: ProviderToolLoopContinuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolExecutionResult>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  resume?: ProviderToolLoopResume;
  signal?: AbortSignal;
  tools: readonly RunTool[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A context-length rejection that arrived before any billed usage: an unpaid
 * refusal for which no usage is invented. A refused request may still report
 * zero or unknown counts (the follow-up executor forwards an unknown partial
 * report for every failed dispatch); only a positive count bills.
 */
export function unpaidContextRejection(error: unknown, usage: ModelRunUsage | null) {
  return usage !== null && TOKEN_USAGE_FIELDS.some((field) => (usage[field] ?? 0) > 0)
    ? null : providerContextRejection(error);
}

const undispatchedRoundFailures = new WeakSet<object>();

/** Marks a round failure raised while no answer request of that round was in
 * flight (for example Stop or a compaction failure before a clarified
 * dispatch). Such a round has no provider usage to report. */
export function beforeAnswerDispatch<T>(error: T): T {
  if (typeof error === "object" && error !== null) undispatchedRoundFailures.add(error);
  return error;
}

/** False only for a failure marked by `beforeAnswerDispatch`. */
export function answerDispatchStarted(error: unknown): boolean {
  return typeof error !== "object" || error === null || !undispatchedRoundFailures.has(error);
}

/** Only a `required` round names the tool it is forced to obtain; later
 * rounds never inherit the name from the request they were derived from. */
export function withRoundForcedTool(
  request: ProviderRunRequest,
  forcedToolName: string | undefined
): ProviderRunRequest {
  const round: ProviderRunRequest = { ...request };
  delete round.forcedToolName;
  return request.toolChoice === "required" && forcedToolName ? { ...round, forcedToolName } : round;
}

export function providerToolLoopContinuationAfterResult(
  bridge: ProviderToolBridge,
  continuation: ProviderToolLoopContinuation,
  result: ProviderRunResult
): ProviderToolLoopContinuation {
  const calls = result.toolCalls ?? [];
  const withResults = continuationForRound(bridge, continuation, []);
  return {
    ...withResults,
    providerResponseId: result.providerResponseId ?? withResults.providerResponseId,
    providerToolMessages: [
      ...withResults.providerToolMessages,
      ...bridge.serializeAssistantToolCalls({
        calls,
        ...(result.providerToolCallMessage !== undefined
          ? { providerMessage: result.providerToolCallMessage }
          : {})
      })
    ]
  };
}

export const REQUIRED_TOOL_CALL_FAILURE = Object.freeze({
  code: "required_tool_call_missing",
  fatal: true,
  message: "The model did not call the required tool."
});

/** App-level obligation, independent of the tool choice sent on the wire. */
export function missingRequiredToolCall(
  request: ProviderRunRequest,
  calls: readonly ModelToolCall[]
): boolean {
  return request.toolChoice === "required" && (request.forcedToolName
    ? !calls.some(call => call.name === request.forcedToolName)
    : calls.length === 0);
}

export function requiredToolCorrectionContinuation(
  bridge: ProviderToolBridge,
  continuation: ProviderToolLoopContinuation,
  result: ProviderRunResult,
  toolName?: string
): ProviderToolLoopContinuation {
  const text = toolName
    ? `You must call the ${toolName} tool before answering. Call it now with valid arguments. Do not provide a final answer yet.`
    : "You must call an available tool before answering. Call the appropriate tool now with valid arguments. Do not provide a final answer yet.";
  const assistantMessage = bridge.provider === "gemini"
    ? { type: "model_output", content: [{ type: "text", text: result.finalText }] }
    : { role: "assistant", content: result.finalText };
  const next = providerToolLoopContinuationAfterResult(bridge, continuation, {
    ...result,
    providerToolCallMessage: result.providerToolCallMessage ?? assistantMessage
  });
  return {
    ...next,
    providerToolMessages: [...next.providerToolMessages, bridge.provider === "gemini"
      ? { type: "user_input", content: [{ type: "text", text }] }
      : { role: "user", content: text }],
    requiredToolCorrection: true
  };
}

function errorToolResult(call: ToolLoopCall, code: string, message: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ text: `${code}: ${message}`, type: "text" }],
    name: call.name,
    status: "error"
  };
}

function settledExecutionResult(
  entry: ToolLoopSettledCall<ToolExecutionResult>
): ToolExecutionResult {
  return entry.result.status === "complete"
    ? entry.result.value
    : errorToolResult(entry.call, entry.result.error.code, entry.result.error.message);
}

function continuationForRound(
  bridge: ProviderToolBridge,
  continuation: ProviderToolLoopContinuation,
  previousToolResults: readonly ToolLoopSettledCall<ToolExecutionResult>[],
  projectToolResultForProvider?: ProviderToolLoopInput["projectToolResultForProvider"],
  toolResultNoteForProvider?: ProviderToolLoopInput["toolResultNoteForProvider"]
): ProviderToolLoopContinuation {
  if (previousToolResults.length === 0) return continuation;
  return {
    ...continuation,
    providerToolMessages: [
      ...continuation.providerToolMessages,
      ...previousToolResults.map((entry) => {
        const result = settledExecutionResult(entry);
        return bridge.appendToolResult(
          undefined,
          withProviderNote(projectToolResultForProvider?.(result, { round: entry.round }) ?? result,
            toolResultNoteForProvider?.(entry))
        );
      })
    ]
  };
}

export async function runProviderToolLoop(
  input: ProviderToolLoopInput
): Promise<ToolLoopOutcome<ProviderRunResult>> {
  const initialContinuation: ProviderToolLoopContinuation = {
    providerResponseId: null,
    providerToolMessages: []
  };
  let preparedRequest = input.initialRequest;
  const reserved = input.reservedCall;
  let reservedCalled = reserved?.called ?? false;

  return continueToolLoop({
    deferToolUntilBatchEnd: input.deferToolUntilBatchEnd,
    toolObservation: input.toolObservation,
    toolCallKind: input.toolCallKind,
    afterToolBatch: input.afterToolBatch,
    budgets: input.budgets,
    ...(reserved ? {
      budgetExemptCallMade: reserved.called,
      isBudgetExempt: (call: ToolLoopCall) => call.name === reserved.name
    } : {}),
    executeTool: (call, context) => input.executeTool({
      arguments: isRecord(call.arguments) ? call.arguments : {},
      id: call.id,
      name: call.name
    }, context),
    initialContinuation,
    onToolBatchSettled: input.onToolBatchSettled,
    onSignal: input.onSignal,
    persistToolBatch: input.persistToolBatch,
    refuseToolBatch: ({ continuation, round }) => input.onFinalSynthesisTransition?.({ continuation, round }),
    ...(input.timeBudgetExhausted ? { timeBudgetExhausted: input.timeBudgetExhausted } : {}),
    resume: input.resume ? {
      continuation: input.resume.continuation,
      ...(input.resume.previousToolResults
        ? { previousToolResults: input.resume.previousToolResults }
        : {}),
      ...(input.resume.progress ? { progress: input.resume.progress } : {}),
      ...(input.resume.seenCallIds ? { seenCallIds: input.resume.seenCallIds } : {})
    } : undefined,
    async runProviderRound({ continuation, emitText, previousToolResults, progress, round, signal }) {
      const effectiveContinuation = continuationForRound(
        input.bridge,
        continuation,
        previousToolResults,
        input.projectToolResultForProvider,
        input.toolResultNoteForProvider
      );
      const gated = (entry: ToolLoopSettledCall<ToolExecutionResult>) => input.isApprovalGatedCall?.(entry.call) === true;
      const decision = toolSynthesisDecision({
        approvalRequired: previousToolResults.some(gated) && previousToolResults.every(entry =>
          gated(entry) || input.isRepeatBlockedCall?.(entry.call) === true),
        budgets: input.budgets,
        continuation,
        initialToolChoice: input.initialRequest.toolChoice,
        noProgress: previousToolResults.length > 0 && input.isRepeatBlockedCall !== undefined &&
          previousToolResults.every(entry => input.isRepeatBlockedCall!(entry.call)),
        progress,
        timeExhausted: input.timeBudgetExhausted?.() === true
      });
      // An exactly used budget first offers an outstanding reserved call
      // alone; synthesis follows once it was made or refused.
      const reservedRound = reservedCallRound(decision, reserved && { called: reservedCalled });
      const synthesis = reservedRound ? null : decision;
      const budget = synthesis?.budget ?? null;
      const required = progress.toolRounds === 0 && input.initialRequest.toolChoice === "required";
      const toolChoice = synthesis || input.initialRequest.toolChoice === "none"
        ? "none"
        : required && !continuation.requiredToolCorrection
          ? "required"
          : "auto";
      // The instruction is budgeted with the request it ends, then removed
      // from everything the round persists.
      const synthesisMessage = synthesis
        ? toolSynthesisMessage(input.bridge, toolSynthesisInstruction(synthesis.reason))
        : reservedRound && reserved ? toolSynthesisMessage(input.bridge, reserved.instruction) : null;
      const requestedRound = withRoundForcedTool({
        ...preparedRequest,
        parallelToolCalls: input.parallelToolCalls,
        providerToolMessages: [...effectiveContinuation.providerToolMessages,
          ...(synthesisMessage ? [synthesisMessage] : [])],
        toolChoice,
        tools: [...input.tools]
      }, input.initialRequest.forcedToolName);
      const persistedMessages = (messages: readonly unknown[]) => synthesisMessage
        ? withoutSynthesisMessage(messages, synthesisMessage) : [...messages];
      let roundInput = requestedRound;
      let rejected: Readonly<{ error: unknown }> | null = null;
      let preparedContinuation!: ProviderToolLoopContinuation;
      let roundRequest!: ProviderRunRequest;
      let advertisedToolNames!: Set<string>;
      let emittedText: string;
      let lastReportedUsage: ModelRunUsage | null;
      let next: IteratorResult<ModelRunSseEvent, ProviderRunResult>;
      // The round's physical requests; a dropped one may be sent again as is.
      let attempt = 1;
      let redispatch = false;
      for (;;) {
        if (!redispatch) {
          let preparedRound: ProviderRunRequest;
          try {
            preparedRound = await input.prepareRequest?.(roundInput, round) ?? roundInput;
          } catch (error) {
            // A rebuild whose irreducible request exceeds even the tightened
            // budget fails as the provider refusal it answered.
            if (rejected && typeof error === "object" && error !== null && "code" in error &&
              error.code === "context_too_large") throw rejected.error;
            throw error;
          }
          // A planner may replace old settled observations in the provider-facing
          // projection. Carry that exact projection into the durable continuation;
          // otherwise recovery would resurrect the bulky pre-mask transcript.
          preparedContinuation = {
            ...effectiveContinuation,
            providerResponseId: effectiveContinuation.providerResponseId,
            providerToolMessages: preparedRound.providerToolMessages
              ? persistedMessages(preparedRound.providerToolMessages)
              : effectiveContinuation.providerToolMessages
          };
          // Request/context preparation cannot restore tool authority after its
          // accepted limit. Keep declarations and signed result context intact.
          roundRequest = toolChoice === "none" ? { ...preparedRound, toolChoice } : preparedRound;
          // Keep a committed summary and its exact recent context for subsequent
          // rounds. Rebuilding from the admission source would buy the same
          // compaction again after every tool call.
          preparedRequest = roundRequest;
          advertisedToolNames = new Set(roundRequest.tools?.map((tool) => tool.name));
          if (!rejected) {
            await input.beforeProviderRound?.({
              continuation: preparedContinuation,
              request: roundRequest,
              round
            });
            if (budget) await input.onFinalSynthesis?.(budget);
          }
        }
        redispatch = false;

        if (continuation.finalSynthesis === "budget_exhausted") {
          try {
            await input.beforeSynthesisDispatch?.({ continuation: { ...continuation, synthesisDispatched: true }, round });
          } catch (error) {
            throw beforeAnswerDispatch(error);
          }
        }
        // Text, tool arguments and any event other than the provider's own
        // lifecycle summary are accepted output of this round.
        let acceptedOutput = false;
        const stream = input.adapter.stream(roundRequest, { signal,
          ...(input.onToolArguments && toolChoice !== "none" && advertisedToolNames.has("create_artifact")
            ? { onToolArguments: (event: import("../providers/types").ProviderToolArgumentEvent) => {
                acceptedOutput = true;
                return input.onToolArguments!({ round, event });
              } } : {}) });
        emittedText = "";
        lastReportedUsage = null;
        let dropped: Readonly<{ delayMs: number; error: unknown }> | null = null;
        try {
          next = await stream.next();
          while (!next.done) {
            if (next.value.type === "token") {
              // An unsatisfied required call cannot publish an answer, even
              // when its compatible wire policy allows ordinary text.
              if (!required) await emitText(next.value.data.delta);
              emittedText += next.value.data.delta;
            } else if (next.value.type === "usage") {
              lastReportedUsage = mergeTokenUsage(lastReportedUsage ?? {}, next.value.data);
            } else {
              if (next.value.type !== "artifact" || next.value.data.artifactType !== "summary") acceptedOutput = true;
              try { await input.onEvent?.(next.value); }
              catch (error) { throw localSettlementError("publication", error); }
            }
            next = await stream.next();
          }
          break;
        } catch (error) {
          // A context-length rejection before any accepted output or billed
          // usage of this round is an unpaid refusal: no usage is invented.
          const rejection = !acceptedOutput && emittedText === "" ? unpaidContextRejection(error, lastReportedUsage) : null;
          // Only a dispatched answer request has partial usage; a failure before
          // dispatch must not persist a phantom round with unavailable usage.
          let usageRecorded = false;
          if (!rejection && (lastReportedUsage !== null || answerDispatchStarted(error))) {
            try {
              await input.onUsage?.(lastReportedUsage ?? {}, roundRequest, {
                completeness: "partial",
                round
              });
              usageRecorded = true;
            } catch {
              // Usage persistence is secondary once the provider round has
              // already failed and must not replace its causal classification.
            }
          }
          // One bounded rebuild re-plans this round's prepared request (its
          // masks, trims and any bought notes stay) under a tightened budget;
          // settled tools are never executed again. A second rejection fails.
          const rebuild = rejection && !rejected && input.allowContextRebuild === true
            ? providerRequestContextRebuild({ bridge: input.bridge, rejection, request: roundRequest, round }) : null;
          if (rebuild) {
            rejected = { error };
            roundInput = { ...roundRequest, contextCompactionRebuild: rebuild };
          } else {
            // A dropped request whose usage the round recorded may be sent
            // again; none of the round's tool calls exists before its result.
            const delayMs = input.roundRetry && usageRecorded
              ? droppedRoundRetryDelay(input.roundRetry, { acceptedOutput, attempt, error, signal }) : null;
            if (delayMs === null) throw error;
            dropped = { delayMs, error };
          }
        } finally {
          await stream.return(undefined as never).catch(() => undefined);
        }
        if (dropped) {
          // Stop and the run's deadlines end the wait with their own reason.
          await (input.roundRetry!.sleep ?? sleepWithSignal)(dropped.delayMs, signal);
          if (!(await input.roundRetry!.reopen({ attempt: attempt + 1, publishedText: !required && emittedText !== "", round }))) {
            throw dropped.error;
          }
          attempt += 1;
          redispatch = true;
          // Send what the dropped request carried: notes bought for a
          // clarification delivered while dispatching it stay, never bought
          // again, and the round's accepted tool limit still holds.
          const carried = input.dispatchedRequest?.({ request: roundRequest, round }) ?? roundRequest;
          roundRequest = toolChoice === "none" ? { ...carried, toolChoice } : carried;
        }
      }
      const result = { ...next.value, usage: mergeTokenUsage(lastReportedUsage ?? {}, next.value.usage) };
      observeContextEstimate(input.bridge, roundRequest, result.usage);
      const dispatchedRequest = input.dispatchedRequest?.({ request: roundRequest, round }) ?? roundRequest;
      preparedRequest = dispatchedRequest;
      const dispatchedContinuation: ProviderToolLoopContinuation = dispatchedRequest === roundRequest ||
        !dispatchedRequest.providerToolMessages
        ? preparedContinuation
        : {
            ...preparedContinuation,
            providerResponseId: preparedContinuation.providerResponseId,
            providerToolMessages: persistedMessages(dispatchedRequest.providerToolMessages)
          };
      let publicationFailed = false;
      let publicationError: unknown;
      try {
        await input.onProviderResult?.({ request: roundRequest, result, round });
      } catch (error) {
        publicationFailed = true;
        publicationError = error;
      }
      try {
        await input.onUsage?.(result.usage, roundRequest, {
          completeness: "terminal",
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          round
        });
      } catch (error) {
        if (!publicationFailed) throw localSettlementError("accounting", error);
        // Preserve the publication failure as the causal stop after making the
        // best effort to attribute the provider-reported usage.
      }
      if (publicationFailed) throw localSettlementError("publication", publicationError);
      const calls = result.toolCalls ?? [];
      if (result.synthesisToolCallForbidden || roundRequest.toolChoice === "none" && calls.length > 0) {
        if (!required && result.finalText.startsWith(emittedText)) {
          const remainingText = result.finalText.slice(emittedText.length);
          if (remainingText) await emitText(remainingText);
        }
        return {
          error: {
            ...TOOL_SYNTHESIS_FAILURE,
            fatal: true
          },
          status: "error" as const
        };
      }
      const normalizedCalls = calls.map((call) => {
        const name = input.normalizeToolCallName?.(call.name, advertisedToolNames) ?? call.name;
        return name === call.name ? call : { ...call, name };
      });
      const normalizedResult = normalizedCalls.some((call, index) => call !== calls[index])
        ? { ...result, toolCalls: normalizedCalls }
        : result;
      if (required && missingRequiredToolCall(input.initialRequest, normalizedCalls)) {
        if (calls.length > 0 || continuation.requiredToolCorrection || synthesis) {
          return { error: REQUIRED_TOOL_CALL_FAILURE, status: "error" as const };
        }
        const correction = requiredToolCorrectionContinuation(
          input.bridge, dispatchedContinuation, normalizedResult, input.initialRequest.forcedToolName
        );
        try { await input.onRequiredToolCorrection?.({ continuation: correction, round }); }
        catch (error) { throw localSettlementError("publication", error); }
        return { continuation: correction, status: "continue" as const };
      }
      if (calls.length === 0) return { final: result, status: "complete" as const };
      // Validate the entire batch against this provider round before persisting
      // or executing any call. Discovery can add authority only to a later
      // request, even when a provider omits/ignores its optional parallel flag.
      const unsupportedCall = normalizedCalls.find((call) => !advertisedToolNames.has(call.name));
      if (unsupportedCall) {
        return {
          error: {
            code: "unsupported_tool_call",
            fatal: true,
            message: `The model requested a tool that was not available in this step: ${unsupportedCall.name}.`,
            toolName: unsupportedCall.name
          },
          status: "error" as const
        };
      }
      // Executed or refused with its batch, the reserved call is no longer
      // outstanding: the round after an exhausted budget then synthesizes.
      if (reserved && normalizedCalls.some((call) => call.name === reserved.name)) reservedCalled = true;
      return {
        calls: normalizedCalls,
        continuation: providerToolLoopContinuationAfterResult(
          input.bridge,
          dispatchedContinuation,
          normalizedResult
        ),
        parallelToolCalls: roundRequest.parallelToolCalls === true,
        status: "tool_calls" as const,
        // Over the remaining call budget the batch is dropped: synthesis
        // resends this round's own transcript (with the previous round's
        // results) without its assistant items, so every bridge keeps its
        // call/output pairing and no output is invented. It is the transcript
        // before this round's preparation: a reference that preparation made
        // while the reader was callable would be unreadable without tools, so
        // synthesis is re-planned from the real results (notes or an explicit
        // overflow, never a reference it cannot read).
        synthesisContinuation: { ...effectiveContinuation, finalSynthesis: "budget_exhausted" as const }
      };
    },
    signal: input.signal
  });
}

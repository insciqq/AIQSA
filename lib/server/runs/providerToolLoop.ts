import { mergeTokenUsage, TOKEN_USAGE_FIELDS } from "../../domain/usage";
import { localSettlementError } from "./settlementFailure";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import { providerContextRejection } from "../providers/providerObservability";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
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

export type ProviderToolLoopContinuation = Readonly<{
  providerResponseId: string | null;
  providerToolMessages: readonly unknown[];
}>;

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
  onProviderResult?(input: Readonly<{
    request: ProviderRunRequest;
    result: ProviderRunResult;
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
    context: Readonly<{ completeness: "partial" | "terminal"; round: number }>
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
  projectToolResultForProvider?: ProviderToolLoopInput["projectToolResultForProvider"]
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
          projectToolResultForProvider?.(result, { round: entry.round }) ?? result
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

  return continueToolLoop({
    deferToolUntilBatchEnd: input.deferToolUntilBatchEnd,
    toolObservation: input.toolObservation,
    afterToolBatch: input.afterToolBatch,
    budgets: input.budgets,
    executeTool: (call, context) => input.executeTool({
      arguments: isRecord(call.arguments) ? call.arguments : {},
      id: call.id,
      name: call.name
    }, context),
    initialContinuation,
    onToolBatchSettled: input.onToolBatchSettled,
    onSignal: input.onSignal,
    persistToolBatch: input.persistToolBatch,
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
        input.projectToolResultForProvider
      );
      const budget = reachedToolLoopBudget(progress, input.budgets);
      const toolChoice = budget || input.initialRequest.toolChoice === "none"
        ? "none"
        : progress.toolRounds === 0 && input.initialRequest.toolChoice === "required"
          ? "required"
          : "auto";
      const requestedRound = withRoundForcedTool({
        ...preparedRequest,
        parallelToolCalls: input.parallelToolCalls,
        providerToolMessages: [...effectiveContinuation.providerToolMessages],
        toolChoice,
        tools: [...input.tools]
      }, input.initialRequest.forcedToolName);
      let roundInput = requestedRound;
      let rejected: Readonly<{ error: unknown }> | null = null;
      let preparedContinuation: ProviderToolLoopContinuation;
      let roundRequest: ProviderRunRequest;
      let advertisedToolNames: Set<string>;
      let emittedText: string;
      let lastReportedUsage: ModelRunUsage | null;
      let next: IteratorResult<ModelRunSseEvent, ProviderRunResult>;
      for (;;) {
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
          providerResponseId: effectiveContinuation.providerResponseId,
          providerToolMessages: preparedRound.providerToolMessages
            ? [...preparedRound.providerToolMessages]
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
        try {
          next = await stream.next();
          while (!next.done) {
            if (next.value.type === "token") {
              await emitText(next.value.data.delta);
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
          if (!rejection && (lastReportedUsage !== null || answerDispatchStarted(error))) {
            try {
              await input.onUsage?.(lastReportedUsage ?? {}, roundRequest, {
                completeness: "partial",
                round
              });
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
          if (!rebuild) throw error;
          rejected = { error };
          roundInput = { ...roundRequest, contextCompactionRebuild: rebuild };
        } finally {
          await stream.return(undefined as never).catch(() => undefined);
        }
      }
      const result = { ...next.value, usage: mergeTokenUsage(lastReportedUsage ?? {}, next.value.usage) };
      const dispatchedRequest = input.dispatchedRequest?.({ request: roundRequest, round }) ?? roundRequest;
      preparedRequest = dispatchedRequest;
      const dispatchedContinuation: ProviderToolLoopContinuation = dispatchedRequest === roundRequest ||
        !dispatchedRequest.providerToolMessages
        ? preparedContinuation
        : {
            providerResponseId: preparedContinuation.providerResponseId,
            providerToolMessages: [...dispatchedRequest.providerToolMessages]
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
          round
        });
      } catch (error) {
        if (!publicationFailed) throw localSettlementError("accounting", error);
        // Preserve the publication failure as the causal stop after making the
        // best effort to attribute the provider-reported usage.
      }
      if (publicationFailed) throw localSettlementError("publication", publicationError);
      const calls = result.toolCalls ?? [];
      if (roundRequest.toolChoice === "none" && calls.length > 0) {
        if (result.finalText.startsWith(emittedText)) {
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
      if (calls.length === 0) return { final: result, status: "complete" as const };
      const normalizedCalls = calls.map((call) => {
        const name = input.normalizeToolCallName?.(call.name, advertisedToolNames) ?? call.name;
        return name === call.name ? call : { ...call, name };
      });
      const normalizedResult = normalizedCalls.some((call, index) => call !== calls[index])
        ? { ...result, toolCalls: normalizedCalls }
        : result;
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
      return {
        calls: normalizedCalls,
        continuation: providerToolLoopContinuationAfterResult(
          input.bridge,
          dispatchedContinuation,
          normalizedResult
        ),
        parallelToolCalls: roundRequest.parallelToolCalls === true,
        status: "tool_calls" as const
      };
    },
    signal: input.signal
  });
}

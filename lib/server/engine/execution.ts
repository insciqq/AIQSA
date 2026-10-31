import { registerMcpGuardUsage } from "../mcp/guardUsage";
import { randomUUID } from "node:crypto";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { SCHEDULED_TASK_RUN_DEADLINE_MINUTES } from "../../contracts/scheduledTasks";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { logEvent, runWithContext } from "../observability";
import { gatewayRoutingLane } from "../providers/gatewayRouting";
import type { ProviderHistoryItem } from "../providers/history";
import { isProviderDeadlineExceededError } from "../providers/network";
import { assertPersonalContextEgressSafe } from "../providers/personalContext";
import { codexLbConnection, effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import { observedFailure, providerHttpFailureMessage } from "../providers/providerObservability";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED } from "../providers/responseFailure";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllers, runSettlements } from "../runs/activeRunControllerRegistry";
import { contextCompactionArtifact } from "../runs/contextCompactionEvents";
import { liveRunPhaseStatus } from "../runs/liveToolStatus";
import { setRunProviderWait } from "../runs/providerWaits";
import { serializeChatUpdate } from "../runs/chatUpdateWire";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { reportedAnswerCost, usageAttributionsWithEstimatedCost } from "../runs/usagePricing";
import { withPinnedHostedSearchIdentity } from "../runs/searchArtifactIdentity";
import { ToolCallRepeatHistory } from "../runs/toolCallRepeatGuard";
import { toolRunBudgetsForRequest } from "../runs/toolBudgets";
import { toolCallBounds, turnSoftDeadlineMs } from "../runs/turnDeadline";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import type { ToolObservationService } from "../toolObservations/service";
import { logRunPersistence, settleRunWrite } from "../runs/runObservability";
import { MANAGE_SECRET_TOOL_NAME, manageSecretValues } from "../tools/manageSecret";
import { reservedToolCallForRequest } from "../tools/reservedToolCall";
import { invalidProviderToolArguments, type ModelToolCall, type RunTool } from "../tools/types";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import { browserLiveRelay, type BrowserLiveRunHandle } from "../workspace/browserLive";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { getAuthConfig } from "../auth/config";
import type { BrowserHandoffMode } from "../tools/browserHandoff";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { createAnswerStream } from "./answerStream";
import { engineItemRules, turnEndedAfter } from "./compaction";
import { compactionModelCall } from "./compactionCalls";
import { buildRunConversation, subagentCatalogItem, turnContextIndex, turnContextItem, withStoppedNativeAnswers } from "./conversation";
import { detachedCompactions } from "./detachedCompactions";
import { createRunEventSink } from "./events";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "./faults";
import { ANSWER_NOW_INSTRUCTION, runAgentLoop, type LoopToolChoice } from "./loop";
import { callModel } from "./modelCall";
import { contextStatusArtifact, nativeContextStatus } from "./contextStatus";
import { createRunContext, windowOutputParams, type RunContext } from "./runContext";
import { SUBAGENT_RUN_NO_ANSWER, type NativeRunStore } from "./runStore";
import { withNativeSystemPrompt } from "./systemPrompt";
import {
  APPROVED_CALL_IN_FLIGHT_OUTPUT, runToolBatch, ToolBatchInactiveError, transcriptRecord, type ToolBatchDeps, type ToolBatchState
} from "./toolBatch";
import type { ToolCallStore } from "./toolCallStore";
import { buildToolRegistry, engineMcpBindings, type ToolRegistryServices } from "./toolRegistry";
import { saveToolResultText, type SavedToolResultReader } from "./toolResults";
import {
  modelResponseItems, projectTranscript, type TranscriptItem, type TranscriptProjectionOptions, type TranscriptTarget, type TranscriptUserItem
} from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";
import { createTranscriptWriter, type TranscriptWriter } from "./transcriptWriter";
import { createAgentUnknownEffects, unknownEffectsOf, withHiddenRunEffects, withRetiredEffects } from "./unknownEffects";
import { createUsageLedger } from "./usage";
import { takeNativeRunInterruption, WORKSPACE_STOPPED_INTERRUPTION } from "./runInterruption";
import { withSubagentTools } from "./subagents/callTools";
import {
  currentUserMessageText,
  prepareRunSubagents,
  userAuthoredFollowup,
  type RunSubagents,
  type SubagentBackgroundParts,
  type SubagentEngineDeps,
  type SubagentRegistryHost,
  type SubagentRunPorts
} from "./subagents/runSubagents";
import { renderSubagentTypeCatalog } from "../subagents/typeCatalog";
import type { WorkspaceAgent } from "../subagents/guestProtocol";
import { READ_AIQSA_GUIDE_TOOL_NAME } from "../tools/aiqsaGuide";

/**
 * The native engine's execution of one accepted run: the run's SSE response
 * the chat already renders, the agent loop over the run's transcript, and
 * answer-first settlement (the answer is published before Workspace hand-off,
 * completion and usage, none of which can take it back). Stop is the shared
 * handler: it cancels the run's row and aborts this run's controller.
 */
export const NATIVE_TURN_LIMITS = Object.freeze({
  /** A run without a Workspace answers within this long; before it, the turn stops calling tools and answers
   * (`turnSoftDeadlineMs`). */
  turnMs: 60 * 60_000
});

export class EngineFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineFailure";
  }
}

export const CONTEXT_TOO_LARGE_MESSAGE =
  "This conversation no longer fits the model's context window. Start a new chat, or continue in a new chat from this answer.";

export type NativeEngineDeps = SubagentEngineDeps & Readonly<{
  /** The approved call an approval continuation sends, while its approval may still continue. */
  approvedCall(input: Readonly<{ approvalId: string; chatId: string; userId: string }>): Promise<Readonly<{
    providerCallId: string; toolName: string }> | null>;
  /** The test faults of one run (a new set per run). */
  faults?: () => EngineTestFaults;
  /** The run's accepted MCP runtime binding rows. */
  mcpBindingRows(runId: string): Promise<readonly Readonly<{ id: string; runtimeGenerationFingerprint: string;
    runtimeGenerationId: string | null }>[]>;
  now?: () => number;
  observations(): Promise<Pick<ToolObservationService, "withReservation">>;
  runs: NativeRunStore;
  savedResults: SavedToolResultReader;
  toolCalls: ToolCallStore;
  transcripts: TranscriptRepository;
}>;

export type NativeRunServices = Omit<ToolRegistryServices, "repository" | "savedResults" | "workspace" | "mcpRuntime">;

export type NativeRunExecutionInput = Readonly<{
  adapter: ProviderAdapter;
  /** The run continues the turn an approval stopped: it sends the approved call first. */
  approvalContinuation?: Readonly<{ approvalId: string }>;
  chatTitleGenerator?: ChatTitleGenerator;
  created: Readonly<{ acceptedAt?: Date; assistantMessageId: string; runId: string; userMessageId: string }>;
  engine: NativeEngineDeps;
  mcpRuntime?: ToolRegistryServices["mcpRuntime"];
  prepared: MaterializedPreparedRunData;
  repository: RunRepository;
  /**
   * A scheduled task's occurrence: its context is flat (`agent_docs/RUN_CONTRACTS.md`), so the
   * previous result it carries brings that answer's own items and never a compaction of what came before.
   */
  scheduled?: true;
  services: NativeRunServices;
  /**
   * The sub-agent ports of other slices this run gets (background turns, custom types, the browser identity);
   * an absent one is unavailable, so a Telegram turn or scheduled occurrence gives no background port.
   */
  subagents?: SubagentRunPorts;
  /** A Telegram turn: its chat shows no live browser, so a handoff points to the web chat. */
  telegram?: true;
  userId: string;
  workspace?: WorkspaceCoordinator;
}>;

/** The main agent's key among a run's agent fences; a sub-agent's is its thread id (a UUID, never this). */
const MAIN_AGENT_FENCE = "main";

/** The web chat's address a Telegram turn's handoff points to; the chat id is its only parameter. */
function webChatUrl(chatId: string): string {
  try {
    return new URL(`/c/${encodeURIComponent(chatId)}`, getAuthConfig().appBaseUrl).toString();
  } catch {
    return `/c/${encodeURIComponent(chatId)}`;
  }
}

/** The Responses family streams on the native engine (Codex LB included), always in the foreground. */
export function nativeRequestParams(adapterKind: string, params: Record<string, unknown>): Record<string, unknown> {
  return adapterKind === "openai_responses_compatible" || adapterKind === "openai_responses_native"
    ? { ...params, background: false, stream: true }
    : params;
}

/**
 * Routes that can compact natively and take their own compaction items back:
 * OpenAI's Responses API and Codex LB (`compaction/native.ts`). Other
 * compatible Responses gateways are not known to. Runs compact with a summary
 * on these routes too unless `COMPACTION_LIFECYCLE.native` is on (`runContext.ts`).
 */
export function nativeCompactionRoute(snapshot: Readonly<{ connection?: Parameters<typeof codexLbConnection>[0];
  model: Readonly<{ adapterKind: string }> }>): boolean {
  const kind = snapshot.model.adapterKind;
  return kind === "openai_responses_native" || kind === "openai_responses_compatible" && codexLbConnection(snapshot.connection);
}

/**
 * Anthropic thinking replays within the current turn only (`TranscriptTarget.reasoningScope`): earlier turns' blocks
 * were produced under an earlier run's system prompt, which carries its date and time, so the renderer would drop
 * them anyway (`anthropicMessagesHistory.ts`), and on the models that keep them each would be billed as input on every
 * request.
 */
function reasoningReplayScope(snapshot: Readonly<{ model: Readonly<{ adapterKind: string }> }>):
  TranscriptTarget["reasoningScope"] {
  return snapshot.model.adapterKind === "anthropic_messages" ? "current_turn" : undefined;
}

/** A response's items for adapters that report none. */
function fallbackHistory(result: ProviderRunResult): ProviderHistoryItem[] {
  return [
    ...(result.finalText ? [{ text: result.finalText, type: "assistant_text" as const }] : []),
    ...(result.toolCalls ?? []).map((call) => ({ arguments: JSON.stringify(call.arguments), callId: call.id, name: call.name,
      type: "tool_call" as const }))
  ];
}

function parsedArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown>
      : invalidProviderToolArguments();
  } catch {
    return invalidProviderToolArguments();
  }
}

/**
 * Which of these earlier user messages of the chat are turns the server
 * wrote (`systemTurnKind`) and scheduled task prompts. When they cannot be
 * read, every one counts as the server's, so no turn the engine cannot tell
 * apart releases an unknown effect.
 */
/**
 * The user-role turns the server wrote on the branch (approval continuations, sub-agent wake-ups), never the user's speech.
 * Unreadable, every one of them counts as the server's, so none is taken for the user's words.
 */
async function systemWrittenTurns(repository: Pick<RunRepository, "loadSystemTurnMessageIds">,
  input: Readonly<{ chatId: string; messageIds: readonly string[]; userId: string }>): Promise<ReadonlySet<string>> {
  if (input.messageIds.length === 0) return new Set();
  try {
    return await repository.loadSystemTurnMessageIds?.(input) ?? new Set();
  } catch (error) {
    logEvent("service_operation", { action: "degrade", code: "server_turns_unavailable", error, outcome: "degraded", stage: "read",
      subsystem: "database" });
    return new Set(input.messageIds);
  }
}

async function serverWrittenTurns(repository: Pick<RunRepository, "loadScheduledPromptMessageIds" | "loadSystemTurnMessageIds">,
  input: Readonly<{ chatId: string; messageIds: readonly string[]; userId: string }>): Promise<ReadonlySet<string>> {
  if (input.messageIds.length === 0) return new Set();
  try {
    const [systemTurns, prompts] = await Promise.all([
      repository.loadSystemTurnMessageIds?.(input) ?? Promise.resolve(new Set<string>()),
      repository.loadScheduledPromptMessageIds?.(input) ?? Promise.resolve(new Set<string>())
    ]);
    return new Set([...systemTurns, ...prompts]);
  } catch (error) {
    logEvent("service_operation", { action: "degrade", code: "server_turns_unavailable", error, outcome: "degraded", stage: "read",
      subsystem: "database" });
    return new Set(input.messageIds);
  }
}

function maxOutputTokens(request: ProviderRunRequest): number {
  const value = request.params.maxOutputTokens ?? request.params.maxTokens ?? request.modelCapabilities.defaultMaxOutputTokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The failure a terminal error shows: a stable code and a message without values. */
function failurePayload(error: unknown, workspaceRun: boolean): Readonly<{ code: string; message: string }> {
  if (error instanceof EngineFailure) return { code: error.code, message: error.message };
  if (error instanceof WorkspaceRuntimeError) return { code: error.code, message: "The Workspace could not complete this turn." };
  const failure = observedFailure(error);
  if (failure.code === PROVIDER_CONTEXT_LENGTH_EXCEEDED) return { code: "context_too_large", message: CONTEXT_TOO_LARGE_MESSAGE };
  if (isProviderDeadlineExceededError(error)) {
    return { code: "provider_request_timed_out", message: "The model provider did not answer in time. The answer so far is kept." };
  }
  return {
    code: failure.code !== "unknown" ? failure.code : "provider_stream_failed",
    message: providerHttpFailureMessage(error) ?? (workspaceRun
      ? "The answer could not be completed. Its Workspace files and the answer so far are kept."
      : "The answer could not be completed. The answer so far is kept.")
  };
}

/**
 * The content-free cause of a run's failed or cancelled execution record:
 * Admin Health reads run deadlines by `reason`, and provider failures by
 * their status and reviewed error code.
 */
function failureCauseFields(input: Readonly<{ cancelled: boolean; failure: unknown; stopped: boolean; timedOut: boolean;
  turnMs: number; workspaceRun: boolean }>) {
  if (input.cancelled) return { reason: "cancelled" as const, ...(input.stopped ? { abort_source: "stop" as const } : {}) };
  if (input.timedOut) {
    return { abort_source: input.workspaceRun ? "workspace_deadline" as const : "unknown" as const, reason: "deadline" as const,
      timeout_ms: input.turnMs };
  }
  const observed = observedFailure(input.failure);
  return {
    reason: observed.reason,
    ...(observed.httpStatus !== undefined ? { httpStatus: observed.httpStatus } : {}),
    ...(observed.provider_error_code ? { provider_error_code: observed.provider_error_code } : {}),
    ...(observed.abort_source === "provider_deadline"
      ? { abort_source: "provider_deadline" as const, ...(observed.timeout_ms !== undefined ? { timeout_ms: observed.timeout_ms } : {}) }
      : {})
  };
}

export function createNativeRunExecutionResponse(input: NativeRunExecutionInput): Response {
  return runWithContext({ run_id: input.created.runId, user_id: input.userId }, () => nativeRunResponse(input));
}

function nativeRunResponse(input: NativeRunExecutionInput): Response {
  const runId = input.created.runId;
  const normalizedRequest = input.prepared.normalizedRequest;
  const engine = input.engine;
  const now = engine.now ?? Date.now;
  const faults = engine.faults?.() ?? NO_ENGINE_TEST_FAULTS;
  const stop = new AbortController();
  activeRunControllers.set(runId, stop);
  let resolveSettled: () => void = () => undefined;
  runSettlements.set(runId, new Promise<void>((resolve) => { resolveSettled = resolve; }));
  const scope = { assistantMessageId: input.created.assistantMessageId, chatId: normalizedRequest.chatId, runId, userId: input.userId };
  const snapshot = input.prepared.providerAdmissionPlan.answer.snapshot;
  const workspace = normalizedRequest.workspace;
  const startedAt = now();
  const turnMs = workspace ? workspace.turnTimeoutSeconds * 1_000 : NATIVE_TURN_LIMITS.turnMs;
  // A scheduled task's run is stopped at its occurrence's deadline after admission, which comes before a long turn's
  // own: its tool time ends that much earlier, so it answers before the scheduler stops it.
  const scheduledTurnMs = Math.min(turnMs, SCHEDULED_TASK_RUN_DEADLINE_MINUTES * 60_000);
  // The longest one request of the answer model may take, which its rounds apply and the deadlines below leave room for.
  const answerTimeoutMs = effectiveProviderResponseTimeoutMs(snapshot.connection,
    snapshot.model.adapterKind === "fake" ? null : snapshot.model);
  // Until when work that may take `workMs` once started may still start: the turn's soft deadline for it, and a
  // scheduled run's occurrence's.
  const admittedAt = input.created.acceptedAt?.getTime() ?? startedAt;
  const bounds = toolCallBounds(normalizedRequest, answerTimeoutMs);
  const startsUntil = (workMs: number) => Math.min(startedAt + turnSoftDeadlineMs(turnMs, workMs, bounds.answer),
    input.scheduled ? admittedAt + turnSoftDeadlineMs(scheduledTurnMs, workMs, bounds.answer) : Infinity);
  // Past its tool time the turn answers without tools, which is what ends an answer without tool limits. Rounds leave
  // room for a common call or a round under way, then the answer; a call whose own bound is longer (a slow MCP server,
  // Search source or image model) must also fit before the deadline as it starts, so a slow source the run never
  // calls never shortens its tool time.
  const toolTimeEndsAt = startsUntil(bounds.round);
  // Asked before each round.
  const toolTimeLeft = () => now() < toolTimeEndsAt;
  // Asked as each call of a batch starts, so a call queued behind slower ones, or one that would outlast the answer's
  // reserve, never starts.
  const callTimeLeft = (tool: Pick<RunTool, "capability" | "name">) => toolTimeLeft() && now() < startsUntil(bounds.call(tool));
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new EngineFailure(RUN_TIME_LIMIT_FAILURE.code, RUN_TIME_LIMIT_FAILURE.message)),
    turnMs);
  deadlineTimer.unref?.();
  const signal = AbortSignal.any([stop.signal, deadline.signal]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = createRunEventSink({ controller, repository: input.repository, runId });
      const stopKeepalive = sink.startKeepalive();
      const usage = createUsageLedger({
        faults, price: (attributions) => usageAttributionsWithEstimatedCost(input.repository, attributions), scope, store: engine.runs
      });
      const releaseGuardUsage = registerMcpGuardUsage(runId, usage.add);
      let answerPublished = false;
      let firstOutput = true;
      const answer = createAnswerStream({
        onFirstOutput() {
          if (!firstOutput) return;
          firstOutput = false;
          void input.repository.markRunAnswerStarted({ at: new Date(), runId }).catch(() => undefined);
          const acceptedAt = input.created.acceptedAt;
          if (acceptedAt) logEvent("run_execution", { adapterKind: snapshot.model.adapterKind, connectionId: snapshot.connectionId,
            duration_ms: Math.max(0, Date.now() - acceptedAt.getTime()), outcome: "completed", providerFamily: snapshot.providerFamily,
            providerModelId: snapshot.providerModelId, run_id: runId, stage: "first_output" });
        },
        save: (text) => input.repository.appendAssistantText(scope.assistantMessageId, text, { runId }),
        send: sink.send
      });
      const onWorkspaceActivity = (entry: ThreadWorkspaceActivityEntry) => sink.publish(workspaceActivityEvent(entry));
      const chatUpdate = async () => {
        const update = await input.repository.getChatUpdateForRun({ assistantMessageId: scope.assistantMessageId, chatId: scope.chatId,
          userId: input.userId, userMessageId: input.created.userMessageId }).catch(() => null);
        if (update) sink.send({ data: serializeChatUpdate(update), type: "chat_update" });
      };
      const emittedCards = new Set<string>();
      const emitApprovalCards = async () => {
        const cards = await input.repository.loadRunMcpApprovalCards?.({ runId, userId: input.userId }).catch(() => []) ?? [];
        for (const card of cards) {
          if (emittedCards.has(card.approvalId)) continue;
          emittedCards.add(card.approvalId);
          sink.send({ data: { artifactType: "mcp_approval", payload: card }, type: "artifact" });
        }
      };
      logEvent("run_execution", { run_id: runId, stage: "execution", outcome: "started" });
      let runRecords: TranscriptWriter | null = null;
      let runContext: RunContext | null = null;
      let live: BrowserLiveRunHandle | null = null;
      let runSubagents: RunSubagents | null = null;
      try {
        const control = await input.repository.getRunControlForUser(runId, input.userId);
        if (!control || !["in_progress", "queued", "streaming"].includes(control.status)) {
          throw new EngineFailure("model_run_not_active", "The answer is no longer running.");
        }
        // The live browser of an interactive web run (`browserLive.ts`): its owner watches it and answers handoffs.
        const coordinator = input.workspace;
        if (workspace && coordinator?.browserLive && !input.scheduled && !input.telegram) {
          const holds = coordinator.holdsWorkspace;
          // A run gone without `end` (a crash) leaves the shared channel once it no longer holds the Workspace.
          live = browserLiveRelay().register({ ...(holds ? { attached: () => holds({ runId, userId: input.userId }) } : {}),
            channel: (request) => coordinator.browserLive!({ request, runId }), chatId: scope.chatId,
            runId, signInRemembered: () => coordinator.browserSaveBack?.({ runId, userId: input.userId }) ?? Promise.resolve(false),
            userId: input.userId });
        }
        sink.send({ data: { modelId: normalizedRequest.modelId, provider: normalizedRequest.provider, runId, status: "streaming" },
          type: "run_start" });
        // "Worked for" is the whole run, known once the answer is published:
        // until then the live answer shows no duration, never a client guess.
        sink.send({ data: { artifactType: "work_duration", payload: { workDurationMs: null } }, type: "artifact" });
        sink.send({ data: { assistantMessageId: scope.assistantMessageId, userMessageId: input.created.userMessageId },
          type: "message_start" });
        const followupOps = input.prepared.followupAdmission ? input.repository.followups : undefined;
        if (followupOps) await chatUpdate();

        // The conversation: the frozen branch with earlier native answers as their items.
        const contextMessages = normalizedRequest.context?.messages ?? [{ content: normalizedRequest.content,
          id: "current-user-message", role: "user" as const }];
        const answerIds = contextMessages.filter((message) => message.role === "assistant" && message.purpose === undefined)
          .map((message) => message.id);
        // The branch's own turns: what an answer the context left out (stopped without text) is found before.
        const branchTurnIds = [...new Set([input.created.userMessageId, ...contextMessages
          .filter((message) => message.role === "user" && message.purpose === undefined && message.contextTurnId === undefined)
          .map((message) => message.id)])];
        const nativeRuns = new Map(await engine.transcripts.nativeRunsForAnswers({ assistantMessageIds: answerIds,
          chatId: scope.chatId, userId: input.userId }));
        // A scheduled run's flat context is its prompt and previous shown result only.
        const beforeTurns = input.scheduled ? [] : (await engine.transcripts.nativeRunsBeforeTurns({ chatId: scope.chatId,
          userId: input.userId, userMessageIds: branchTurnIds })).filter((run) => !nativeRuns.has(run.assistantMessageId));
        // A recorded answer review's stopped step stays off the branch; its calls still count for the effect guard below.
        const stoppedRuns = beforeTurns.filter((run) => !run.reviewStep);
        const hiddenSteps = beforeTurns.filter((run) => run.reviewStep);
        for (const run of stoppedRuns) nativeRuns.set(run.assistantMessageId, run.runId);
        // The run's own message is last in the branch, under the id a send gives it there.
        const conversationMessages = withStoppedNativeAnswers(contextMessages, stoppedRuns.map((run) =>
          run.nextUserMessageId === input.created.userMessageId ? { ...run, nextUserMessageId: contextMessages.at(-1)!.id } : run));
        const runItems = await engine.transcripts.loadRuns({ chatId: scope.chatId,
          runIds: [...nativeRuns.values(), ...hiddenSteps.map((run) => run.runId)], userId: input.userId });
        // A scheduled run's flat context takes only its previous result's own work: never a compaction of what came before
        // it, nor user input that entered that answer (a follow-up).
        const answerItems = (answer: readonly TranscriptItem[]) => input.scheduled
          ? answer.filter((item) => item.kind !== "compaction" && item.kind !== "user") : answer;
        const nativeAnswers = new Map([...nativeRuns].map(([messageId, nativeRunId]) => [messageId,
          answerItems(runItems.get(nativeRunId) ?? [])]));
        const continuationTurns = await engine.transcripts.approvalContinuationTurns({ chatId: scope.chatId,
          messageIds: contextMessages.filter((message) => message.role === "user").map((message) => message.id) });
        const conversationFor = (mode: "continuation" | "input") => buildRunConversation({ continuationTurns,
          current: { messageId: input.created.userMessageId, mode }, messages: conversationMessages, nativeAnswers });
        let conversation = conversationFor(input.approvalContinuation ? "continuation" : "input");
        // An approval continuation sends the approved call itself, then continues the stopped turn with its result.
        let approvedCall: ModelToolCall | null = null;
        if (input.approvalContinuation) {
          const approved = await engine.approvedCall({ approvalId: input.approvalContinuation.approvalId, chatId: scope.chatId,
            userId: input.userId });
          const callItem = approved ? [...conversation.items].reverse().find((item) => item.kind === "tool_call" &&
            item.callId === approved.providerCallId && item.name === approved.toolName) : undefined;
          // Only the latest turn continues: once the user wrote again, a compaction may have cut past the call.
          if (callItem?.kind === "tool_call" && !turnEndedAfter(conversation.items, callItem.id)) {
            approvedCall = { arguments: parsedArguments(callItem.arguments), id: callItem.callId, name: callItem.name };
          } else {
            // The old core stopped that turn, or the user wrote again since: the server's turn is the instruction, and
            // the call it allows is made again.
            conversation = conversationFor("input");
          }
        }
        const items: TranscriptItem[] = [...conversation.items];
        const writer = createTranscriptWriter({ append: (from, added) => engine.transcripts.append(scope, from, added),
          firstSequence: await engine.transcripts.nextSequence(scope), runId });
        runRecords = writer;
        /** The sequence each compaction recorded after the run took, kept for a repeated write. */
        const detachedSequences = new Map<string, number>();
        // Effects of the branch's earlier calls that are still unknown. Only the user's own words count as them speaking, never
        // a turn the server wrote: an approval continuation, a scheduled task's prompt or a sub-agent wake-up turn, which the
        // current message's own record tells (it may start behind a document or Workspace hand-off).
        const currentServerTurn = await serverWrittenTurns(input.repository, { chatId: scope.chatId,
          messageIds: [input.created.userMessageId], userId: input.userId });
        const serverInput = Boolean(input.approvalContinuation) || input.scheduled === true ||
          currentServerTurn.has(input.created.userMessageId);
        // The old core's answers are text, so the calls of its runs whose outcome stayed unknown are added for the guard alone.
        const retiredEffects = await engine.transcripts.retiredRunEffects({ assistantMessageIds: answerIds, chatId: scope.chatId,
          userId: input.userId, userMessageIds: branchTurnIds });
        const effectItems = withHiddenRunEffects(withRetiredEffects(conversation.items, contextMessages, retiredEffects),
          hiddenSteps.map((run) => ({ beforeItemId: `msg-${run.nextUserMessageId}`, items: runItems.get(run.runId) ?? [] })));
        // Only an earlier turn after the branch's first call could release an effect, so only those are looked up.
        const firstCall = effectItems.findIndex((item) => item.kind === "tool_call");
        const laterItems = new Set(firstCall < 0 ? [] : effectItems.slice(firstCall).map((item) => item.id));
        const laterTurns = contextMessages.slice(0, -1)
          .filter((message) => message.role === "user" && laterItems.has(`msg-${message.id}`)).map((message) => message.id);
        const serverWritten = await serverWrittenTurns(input.repository, { chatId: scope.chatId, messageIds: laterTurns,
          userId: input.userId });
        const serverTurns = new Set([...continuationTurns, ...serverWritten].map((messageId) => `msg-${messageId}`));
        // A sub-agent's callback delivered into a turn is the server's, never the user speaking. Each agent of the run
        // keeps its own fence and sees every other's (`createAgentUnknownEffects`): one agent's outcome never settles
        // another's unknown effect.
        const agentFences = createAgentUnknownEffects();
        const unknownEffects = unknownEffectsOf(effectItems, (item) => item.followup === true && item.callback !== true ||
          (item.id === conversation.currentInputId ? !serverInput : item.id.startsWith("msg-") && !serverTurns.has(item.id)),
        agentFences.agent(MAIN_AGENT_FENCE));
        // An effect a sub-agent of this branch left unknown is respected by the main agent and every other sub-agent, read
        // from the threads' records into each thread's own fence and never put in any context.
        const branchRunIds = conversationMessages.flatMap((message) => message.role === "assistant" && nativeRuns.has(message.id)
          ? [nativeRuns.get(message.id)!] : []);
        if (engine.subagentThreads) {
          // Background turns ran in runs of their own, which the branch's answers started.
          const backgroundRuns = await engine.subagentThreads.backgroundRunIds({ chatId: scope.chatId, parentRunIds: branchRunIds,
            userId: input.userId });
          const threadEffects = await engine.subagentThreads.threadEffectItems({ chatId: scope.chatId,
            runIds: [...branchRunIds, ...backgroundRuns], userId: input.userId });
          for (const thread of threadEffects) unknownEffectsOf(thread.items, () => false, agentFences.agent(thread.threadId));
          // Every earlier thread effect precedes the user's current message, which is them speaking since.
          if (threadEffects.length > 0 && conversation.currentInputId && !serverInput) unknownEffects.userSpoke();
        }

        let base = input.prepared.providerRequest;
        if (conversation.currentInputId && input.services.images) {
          base = await input.services.images.withConversationPixels(base, input.userId, signal,
            async () => sink.send(liveRunPhaseStatus({ phase: "files" })));
        }
        // An approval continuation has no input of its own: nothing rides on it.
        if (!conversation.currentInputId) base = { ...base, attachments: [] };
        assertPersonalContextEgressSafe(base);
        // The Workspace files a scheduled task's monthly rotation carried arrive before the first request,
        // so nothing the run calls meets an empty project; for any other run this does nothing.
        if (workspace && input.workspace?.prepareCarryover) {
          await input.workspace.prepareCarryover({ onActivity: onWorkspaceActivity, runId, signal, userId: input.userId, workspace });
        }

        const mcpBindings = engineMcpBindings(input.prepared.mcpBindings ?? [], await engine.mcpBindingRows(runId));
        const delivered: string[] = [];
        const browserHandoff: BrowserHandoffMode | undefined = !workspace ? undefined
          : input.scheduled ? { kind: "unattended" }
            : input.telegram ? { chatUrl: webChatUrl(scope.chatId), kind: "telegram" }
              : { kind: "interactive", live, toolTimeLeftMs: () => toolTimeEndsAt - now() };
        const registryInput = {
          ...(browserHandoff ? { browserHandoff } : {}),
          chatId: scope.chatId,
          loadMcpBindingRows: () => engine.mcpBindingRows(runId),
          mcpBindings,
          onUsage: (attribution: RunUsageAttribution) => usage.add(attribution),
          ...(input.telegram ? { telegram: true as const } : {}),
          runId,
          services: { ...input.services, mcpRuntime: input.mcpRuntime, repository: input.repository, savedResults: engine.savedResults,
            workspace: input.workspace },
          userId: input.userId
        };
        /** A sub-agent's handoff mode: the run's, naming the sub-agent, with a background turn's own live membership. */
        const subagentHandoff = (agent: WorkspaceAgent, host: SubagentRegistryHost | undefined):
          Readonly<{ browserHandoff: BrowserHandoffMode }> | null => {
          if (!browserHandoff || agent.kind !== "subagent") return null;
          if (browserHandoff.kind !== "interactive") return { browserHandoff };
          return { browserHandoff: { ...browserHandoff, agent: { id: agent.threadId, name: agent.name },
            ...(host ? { live: host.live, toolTimeLeftMs: host.toolTimeLeftMs } : {}) } };
        };
        const mainRegistry = await buildToolRegistry({ ...registryInput, agent: { kind: "main" }, followupTexts: () => delivered,
          onEvent: (event) => sink.publish(event), onWorkspaceActivity, request: base });
        const budgets = toolRunBudgetsForRequest(normalizedRequest);
        const toolState: ToolBatchState = { calls: 0 };
        const saveResult: ToolBatchDeps["saveResult"] = async (save) => saveToolResultText({ outcome: save.outcome,
          producer: { runId, toolCallId: save.toolCallId, userId: input.userId }, service: await engine.observations(),
          signal: save.signal, source: save.source, ...(save.sourceBinding ? { sourceBinding: save.sourceBinding } : {}),
          text: save.text });
        // A background turn's own run (`backgroundRunner.ts`): it answers no message, so its records name none.
        const backgroundScope = (backgroundRunId: string) => ({ assistantMessageId: SUBAGENT_RUN_NO_ANSWER, chatId: scope.chatId,
          runId: backgroundRunId, userId: input.userId });
        const threadStore = engine.subagentThreads;
        const backgroundParts: SubagentBackgroundParts | undefined = threadStore ? {
          live: (backgroundRunId) => {
            const liveCoordinator = input.workspace;
            if (!workspace || !liveCoordinator?.browserLive || input.scheduled || input.telegram) return null;
            const holds = liveCoordinator.holdsWorkspace;
            return browserLiveRelay().register({ ...(holds ? { attached: () => holds({ runId: backgroundRunId, userId: input.userId }) } : {}),
              channel: (request) => liveCoordinator.browserLive!({ request, runId: backgroundRunId }), chatId: scope.chatId,
              runId: backgroundRunId, signInRemembered: () => liveCoordinator.browserSaveBack?.({ runId: backgroundRunId, userId: input.userId }) ??
                Promise.resolve(false), userId: input.userId });
          },
          recordDetachedCompaction: (backgroundRunId, { item, sequence, thread }) =>
            engine.runs.recordDetachedCompaction(backgroundScope(backgroundRunId), { item, sequence, status: null, thread }),
          saveResult: (backgroundRunId) => async (save) => saveToolResultText({ outcome: save.outcome,
            producer: { runId: backgroundRunId, toolCallId: save.toolCallId, userId: input.userId }, service: await engine.observations(),
            signal: save.signal, source: save.source, ...(save.sourceBinding ? { sourceBinding: save.sourceBinding } : {}),
            text: save.text }),
          threadRunIds: (threadId) => threadStore.threadRunIds({ chatId: scope.chatId, parentRunIds: [...branchRunIds, runId], threadId,
            userId: input.userId }),
          usage: (backgroundRunId) => createUsageLedger({ faults,
            price: (attributions) => usageAttributionsWithEstimatedCost(input.repository, attributions), scope: backgroundScope(backgroundRunId),
            store: engine.runs })
        } : undefined;
        // A sub-agent gets the user's latest own message as the only authority for irreversible actions: never a turn the
        // server wrote, such as a wake-up quoting sub-agents' reports, which are untrusted data.
        const subagentServerTurns = new Set([...continuationTurns, ...await systemWrittenTurns(input.repository, { chatId: scope.chatId,
          messageIds: contextMessages.filter((message) => message.role === "user").map((message) => message.id), userId: input.userId })]);
        // Sub-agents (`call_subagent`): the main agent's registry only, on the run's own frozen bindings (`subagents/`).
        const subagents = await prepareRunSubagents({
          ...(backgroundParts ? { backgroundParts } : {}),
          admittedRequest: base, adapter: input.adapter, answerTimeoutMs,
          branchRunIds,
          // One page-reader session for the answer: its cap and cache count every agent's reads (integrator decision).
          // A background turn's registry acts as its own run (its Workspace attachment, calls and usage), over the
          // parent's MCP bindings by reference; each sub-agent's handoff names it, from its own run's live membership.
          buildRegistry: (agentInput) => buildToolRegistry({ ...registryInput,
            agent: agentInput.agent,
            ...(subagentHandoff(agentInput.agent, agentInput.host) ?? {}),
            ...(agentInput.host ? { onUsage: agentInput.host.onUsage, runId: agentInput.host.runId } : {}),
            ...(mainRegistry.fetchUrlSession ? { fetchUrlSession: mainRegistry.fetchUrlSession } : {}),
            followupTexts: agentInput.followupTexts,
            // A sub-agent's outputs stay its own; the answer shows its steps under its call.
            onEvent: async () => undefined, onWorkspaceActivity: agentInput.onWorkspaceActivity, request: agentInput.request,
            services: { ...registryInput.services, ...(input.services.selfService
              ? { selfService: { ...input.services.selfService, tools: [READ_AIQSA_GUIDE_TOOL_NAME] } } : {}) } }),
          budgets, callTimeLeft, chatId: scope.chatId, deadline: deadline.signal, deadlineAt: startedAt + turnMs, engine, faults,
          followupTexts: () => delivered,
          modelConfiguration: input.prepared.providerAdmissionPlan.answer.modelConfiguration, now,
          onWorkspaceLifecycle: onWorkspaceActivity,
          // Every follow-up the user wrote into this answer, delivered to the main agent or not yet: a sub-agent gets each once.
          userFollowups: async () => {
            const batch = followupOps ? await followupOps.load({ runId, userId: input.userId }) : null;
            return (batch?.entries ?? []).filter((entry) => entry.delivery !== "undelivered" && userAuthoredFollowup(entry))
              .map((entry) => ({ id: entry.id, text: entry.text }));
          },
          // Background turns are web chats' only: a Telegram turn or a scheduled occurrence waits for its sub-agents.
          backgroundAllowed: !input.telegram && !input.scheduled,
          ports: input.subagents, runContextItems: conversation.items.filter((item) => item.kind === "user" && item.runContext === true),
          runId, saveResult, scope, secrets: input.services.secrets, signal, snapshot, toolState, toolTimeLeft,
          unknownEffects: (threadId) => agentFences.agent(threadId), usage,
          userMessage: currentUserMessageText(contextMessages, subagentServerTurns)
        });
        runSubagents = subagents;
        const registry = subagents ? withSubagentTools(mainRegistry, subagents.tools) : mainRegistry;
        // Every request of the run carries one system prompt for its tools, the same across the chat's turns; what holds
        // only for this run rides in with its input (`systemPrompt.ts`).
        const native = await withNativeSystemPrompt({ now: new Date(startedAt), request: base, scope: { runId, userId: input.userId },
          secrets: input.services.secrets, snapshot, ...(subagents ? { subagents: subagents.prompt } : {}), tools: registry.definitions() });
        base = native.request;
        // The user's custom sub-agents and default ride in run context like the Skills index, never in the system prompt.
        const subagentCatalog = subagents ? renderSubagentTypeCatalog(subagents.catalog, subagents.defaultType) : null;
        items.splice(turnContextIndex(items, conversation.currentInputId), 0,
          ...(subagentCatalog ? [subagentCatalogItem(subagentCatalog)] : []), turnContextItem(native.turnContext));
        // The run reads its items whole; the transcript keeps what later turns may read, written behind the answer.
        const record = (added: readonly TranscriptItem[]) => writer.record(added.map((item) => transcriptRecord(registry, item)));
        const append = async (added: readonly TranscriptItem[]) => {
          if (added.length === 0) return;
          items.push(...added);
          // Bookkeeping: the writer retries and logs, and the turn goes on with its items.
          void record(added).catch(() => undefined);
        };
        // A response's tool calls are on record before any of them is sent.
        const appendCalls = async (added: readonly TranscriptItem[]) => {
          if (added.length === 0) return;
          items.push(...added);
          await record(added);
        };
        // The run's one report reserved outside the budgets, when its registry offers it.
        const reservedReport = reservedToolCallForRequest(normalizedRequest);
        const reserved = reservedReport && registry.resolve(reservedReport.name) ? reservedReport : null;
        const batchDeps: ToolBatchDeps = {
          chatId: scope.chatId,
          history: new ToolCallRepeatHistory(),
          maxToolCalls: budgets.maxToolCalls,
          onEvent: (event) => sink.publish(event),
          onLiveEvent: sink.send,
          registry,
          ...(reserved ? { reservedToolName: reserved.name } : {}),
          runId,
          saveResult,
          signal,
          store: engine.toolCalls,
          toolTimeLeft: callTimeLeft,
          unknownEffects,
          userId: input.userId
        };

        if (approvedCall && input.approvalContinuation) {
          const approvalId = input.approvalContinuation.approvalId;
          // Auto admitted no MCP tool: the server first loads the approved one from the run's frozen catalog, by its own
          // `find_tools` call through the same epoch, binding rows and registry as the model's, recorded in round 0 but no
          // part of the conversation. Exactly the approved call is sent then; one whose tool did not load is refused.
          const load = registry.resolve(approvedCall.name) ? undefined
            : registry.mcpLoadCall?.(approvedCall.name, `aiqsa_approved_load_${approvalId}`);
          if (load) await runToolBatch(batchDeps, toolState, { calls: [load], round: 0 });
          const unavailable = !registry.resolve(approvedCall.name);
          // On record before it may be sent, as a model's calls are: the call's earlier result said "not sent", so an
          // interruption before its own result lands must leave its effect unknown, and an equivalent call later needs the
          // user's decision again, whatever the server's consent. Its own result, recorded later, supersedes this one.
          if (!unavailable) {
            await appendCalls([{ callId: approvedCall.id, id: randomUUID(), inFlight: true, kind: "tool_result",
              name: approvedCall.name, outcome: "unknown", output: APPROVED_CALL_IN_FLIGHT_OUTPUT }]);
          }
          const batch = await runToolBatch(batchDeps, toolState, {
            approved: { approvalId, callId: approvedCall.id, ...(unavailable ? { unavailable: true as const } : {}) },
            calls: [approvedCall], firstOrdinal: load ? 1 : 0, round: 0
          });
          await append(batch.results);
          if (batch.approvals.length > 0 || normalizedRequest.mcpApproval?.guard) await emitApprovalCards();
        }

        const reasoningScope = reasoningReplayScope(snapshot);
        const target: TranscriptTarget = { model: normalizedRequest.modelId, provider: snapshot.connectionId,
          ...(nativeCompactionRoute(snapshot) ? { nativeCompaction: true } : {}), ...(reasoningScope ? { reasoningScope } : {}) };
        // How the run's requests render the transcript: its input with its attachments, and the Workspace previews it viewed.
        const projection: TranscriptProjectionOptions = {
          ...(conversation.currentInputId ? { currentInputId: conversation.currentInputId } : {}),
          ...(registry.images ? { images: registry.images } : {})
        };
        const params = nativeRequestParams(snapshot.model.adapterKind, windowOutputParams(base.params,
          { contextWindow: base.modelCapabilities.contextWindow, maxOutputTokens: maxOutputTokens(base) }));
        const timeoutMs = answerTimeoutMs;
        let pending: ModelRunSseEvent[] = [];
        let followupRevision = 0;
        const recordModelUsage = (reported: ModelRunUsage, costUsd: number | undefined) => usage.add({ ...reportedAnswerCost(costUsd),
          modelId: normalizedRequest.modelId, operationCount: 1, provider: normalizedRequest.provider,
          providerModelId: snapshot.providerModelId, purpose: "chat_answer", usage: reported } satisfies RunUsageAttribution);
        // Gateway routing lanes (`gatewayRouting.ts`): the loop's rounds share the chat's, one run at a time; this run's
        // compactions, which run beside the loop and may outlive the run, have their own.
        const loopRouting = gatewayRoutingLane({ chatId: scope.chatId, name: "loop" });
        const compactionRouting = gatewayRoutingLane({ chatId: scope.chatId, name: `compaction:${runId}` });
        // Measurement and compaction before every request (`runContext.ts`); compaction calls are the answer model's.
        const context = createRunContext({
          append,
          compactionCall: (latest) => compactionModelCall({ adapter: input.adapter, deadlineAt: startedAt + turnMs, now,
            onUsage: recordModelUsage, routing: compactionRouting, timeoutMs }, latest),
          // One still running after the answer finishes detached; the run records its item, marker and usage then,
          // the item at a sequence no record of the run takes.
          detached: { chatId: scope.chatId, live: () => engine.transcripts.runLive(scope),
            record: (item, status) => {
              const sequence = detachedSequences.get(item.id) ?? writer.reserve(1);
              detachedSequences.set(item.id, sequence);
              return engine.runs.recordDetachedCompaction(scope, { item, sequence, status });
            }, registry: detachedCompactions, settleUsage: async () => { await usage.settle(); }, userId: input.userId },
          insert: (added) => { items.push(...added); },
          items,
          now,
          // Server-minted, so recorded as it is: the provider projection never keeps capacity statuses.
          onStatus: (status) => sink.record(contextCompactionArtifact(status)),
          projection,
          record: (item) => transcriptRecord(registry, item),
          rules: engineItemRules(input.approvalContinuation ? conversation.currentInputId : null),
          runId,
          signal,
          target,
          tooLarge: () => new EngineFailure("context_too_large", CONTEXT_TOO_LARGE_MESSAGE),
          window: base.modelCapabilities.contextWindow
            ? { contextWindow: base.modelCapabilities.contextWindow, maxOutputTokens: maxOutputTokens(base) } : null
        });
        runContext = context;
        // The chat header's context status (`contextStatus.ts`): the engine's own measure at every request boundary, written
        // beside the request rather than before it, and once more after the answer. Writes are serialized: the last is the
        // latest snapshot.
        let statusWrite: Promise<void> = Promise.resolve();
        const recordContextStatus = (phase: "after_answer" | "request") => {
          const measured = context.measured();
          if (!measured) return statusWrite;
          const event = contextStatusArtifact(nativeContextStatus({ maxOutputTokens: maxOutputTokens(base), phase,
            request: measured.request, tokens: measured.tokens }));
          statusWrite = statusWrite.then(() => sink.record(event));
          return statusWrite;
        };
        // A request the provider rejected for its size is compacted and sent once more.
        const sendOnceMore = async (request: ProviderRunRequest, send: (sent: ProviderRunRequest) => Promise<ProviderRunResult>) => {
          try {
            return await send(request);
          } catch (error) {
            const retry = await context.overflow(request, error);
            if (!retry) throw error;
            pending = [];
            answer.discardAttempt();
            return send(retry);
          }
        };
        const outcome = await runAgentLoop({
          append,
          appendCalls,
          callModel: (request) => sendOnceMore(request, (sent) => callModel({
            adapter: input.adapter,
            deadlineAt: startedAt + turnMs,
            faults,
            now,
            onDiscard: async () => {
              pending = [];
              answer.discardAttempt();
            },
            onEvent: async (event) => {
              const pinned = withPinnedHostedSearchIdentity(event, normalizedRequest);
              if (pinned.type === "token") answer.push(pinned.data.delta);
              // Kept outputs of an attempt are saved once it completed; the rest are live only.
              else if (projectRunOutputArtifactEvent(pinned)) pending.push(pinned);
              else if (pinned.type !== "usage") sink.send(pinned);
            },
            onProviderWait: (wait) => {
              setRunProviderWait(runId, wait);
              sink.send(liveRunPhaseStatus({ phase: "model", ...(wait ? { wait } : {}) }));
            },
            onUsage: recordModelUsage,
            routing: loopRouting,
            signal,
            timeoutMs
          }, sent)),
          closeFollowups: async () => {
            if (!followupOps) return true;
            const batch = await followupOps.load({ runId, userId: input.userId });
            if (!batch) return true;
            followupRevision = batch.revision;
            if (batch.entries.some((entry) => entry.delivery === "accepted")) return false;
            return followupOps.close({ revision: batch.revision, runId, userId: input.userId });
          },
          deliverFollowups: async (): Promise<readonly TranscriptUserItem[]> => {
            if (!followupOps) return [];
            const batch = await followupOps.load({ runId, userId: input.userId });
            const accepted = batch?.entries.filter((entry) => entry.delivery === "accepted") ?? [];
            if (!batch || accepted.length === 0) return [];
            // Only the user's own follow-ups are their speech and link authority; a sub-agent's callback is untrusted data.
            const fromUser = accepted.filter((entry) => entry.origin === undefined || entry.origin === "user");
            await answer.flush();
            if (!await followupOps.deliver({ budgetTokens: 8_192, precedingText: answer.text, revision: batch.revision, runId,
              userId: input.userId })) return [];
            followupRevision = batch.revision;
            delivered.push(...fromUser.map((entry) => entry.text));
            if (fromUser.length > 0) unknownEffects.userSpoke();
            // The answer starts over after the user's follow-up, as the delivered record shows.
            answer.restart();
            sink.send({ data: { round: batch.revision }, type: "message_reset" });
            await chatUpdate();
            return accepted.map((entry) => ({ ...(entry.origin === "subagent_callback" ? { callback: true as const } : {}),
              followup: true as const, id: randomUUID(), kind: "user" as const, text: entry.text }));
          },
          maxToolRounds: budgets.maxToolRounds,
          prepareRequest: async ({ answerNow, reserved: reservedRound, toolChoice }: Readonly<{ answerNow?: true;
            reserved?: true; round: number; toolChoice: LoopToolChoice }>) => {
            const tools = [...registry.definitions()];
            const request: ProviderRunRequest = {
              ...base,
              history: projectTranscript(items, target, projection),
              params,
              parallelToolCalls: true,
              previousProviderResponseId: undefined,
              providerToolMessages: undefined,
              toolChoice,
              tools
            };
            // Compaction at the request boundary; a request that cannot fit even then fails visibly.
            const prepared = await context.prepare(request);
            void recordContextStatus("request");
            // A reserved round's or an answer-now round's instruction rides on its request only, never on the transcript.
            const instruction = reservedRound && reserved ? reserved.instruction : answerNow ? ANSWER_NOW_INSTRUCTION : null;
            return instruction
              ? { ...prepared, history: [...(prepared.history ?? []), { text: instruction, type: "user" as const }] }
              : prepared;
          },
          ...(reserved ? { reservedCall: { name: reserved.name, outstanding: () => toolState.reservedCalled !== true } } : {}),
          // The response keeps its request's anchor, so the chat's next run measures its first request from it (issue #62).
          responseItems: (result) => modelResponseItems({ estimate: estimateApproxTokens,
            history: result.history ?? fallbackHistory(result), nextId: randomUUID, origin: target,
            requestAnchor: context.requestAnchor(result.usage), usage: result.usage }),
          roundEnd: async (result) => {
            for (const event of pending) await sink.publish(event);
            pending = [];
            answer.completeRound(result.finalText);
            context.observe(result.usage);
          },
          roundStart: async (round) => {
            answer.beginRound();
            // After tool work the next request reads its results: a model wait, named as such.
            if (round > 1) sink.send(liveRunPhaseStatus({ phase: "model" }));
          },
          runTools: async (calls, round) => {
            await answer.flush();
            const batch = await runToolBatch(batchDeps, toolState, { calls, round });
            // A value the user had saved as a secret is not repeated in the answer, whatever the model writes (issue #52).
            answer.mask(calls.flatMap((call) => call.name === MANAGE_SECRET_TOOL_NAME ? manageSecretValues(call.arguments) : []));
            if (batch.approvals.length > 0 || normalizedRequest.mcpApproval?.guard) await emitApprovalCards();
            return batch;
          },
          signal,
          toolTimeLeft
        });
        if (outcome.kind === "approval") logEvent("run_execution", { run_id: runId, stage: "execution", outcome: "completed",
          code: "waiting_approval" });
        // A turn that ended with no answer at all is a failure the user can retry, never an empty completion.
        if (outcome.kind === "empty") {
          throw new EngineFailure("model_answer_empty", "The model returned no answer. Send your request again.");
        }

        // Answer first: the text is published before hand-off, completion and usage.
        signal.throwIfAborted();
        await answer.flush();
        if (!await engine.runs.publishAnswer(scope, { followupRevision, text: answer.text })) {
          signal.throwIfAborted();
          throw new EngineFailure("run_answer_not_published", "The answer could not be saved. Send your request again.");
        }
        answerPublished = true;
        sink.send({ data: { assistantMessageId: scope.assistantMessageId, runId }, type: "answer_complete" });
        // The whole run's duration, read as a reload reads it; bookkeeping that never reaches the answer.
        const workDurationMs = await Promise.resolve().then(() => engine.runs.workDurationMs(scope)).catch(() => null);
        if (workDurationMs !== null) sink.send({ data: { artifactType: "work_duration", payload: { workDurationMs } }, type: "artifact" });
        // Answer first: a finished compaction is kept now, a running one goes on detached and never holds the run.
        await context.afterAnswer();
        await recordContextStatus("after_answer");
        // The transcript is on record (or given up) before the run completes and the next turn can read it.
        await writer.flush();
        if (input.chatTitleGenerator && answer.text) {
          await input.chatTitleGenerator.schedule({ answerText: answer.text, chatId: scope.chatId, runId, userId: input.userId,
            userMessageId: input.created.userMessageId }).catch(() => undefined);
        }
        // The live browser ends before the Workspace hands off: no view or streamer outlives the turn.
        await live?.end("run_finished");
        if (workspace && input.workspace) {
          const handoff = await input.workspace.handoff({ onActivity: onWorkspaceActivity, runId, signal, userId: input.userId, workspace });
          if (handoff.status !== "ready") throw new EngineFailure("workspace_operation_stale", "The Workspace could not hand off this turn.");
        }
        // The terminal write's own record: Admin Health counts settled runs from it.
        const completion = await settleRunWrite(() => engine.runs.complete(scope)).catch((writeError: unknown) => {
          logRunPersistence(runId, "complete", "unconfirmed", writeError);
          throw writeError;
        });
        logRunPersistence(runId, "complete", completion.value ? "confirmed" : "not_applied", undefined, completion.timing);
        logEvent("run_execution", { adapterKind: snapshot.model.adapterKind, connectionId: snapshot.connectionId,
          duration_ms: Math.max(0, now() - startedAt), outcome: "completed", providerFamily: snapshot.providerFamily,
          providerModelId: snapshot.providerModelId, run_id: runId, stage: "completion" });
        releaseGuardUsage();
        await usage.settle();
        await chatUpdate();
        sink.send({ data: { runId, status: "complete" }, type: "done" });
      } catch (error) {
        // A shared Workspace that stopped under the run ends it interrupted, with Continue, never cancelled.
        const interrupted = takeNativeRunInterruption(runId);
        const cancelled = !interrupted && (stop.signal.aborted || error instanceof ToolBatchInactiveError && !deadline.signal.aborted);
        const failure = interrupted ? new EngineFailure(WORKSPACE_STOPPED_INTERRUPTION.code, WORKSPACE_STOPPED_INTERRUPTION.message)
          : deadline.signal.aborted && !cancelled ? deadline.signal.reason : error;
        const payload = failurePayload(failure, Boolean(workspace));
        logEvent("run_execution", { adapterKind: snapshot.model.adapterKind, code: cancelled ? "model_run_cancelled" : payload.code,
          connectionId: snapshot.connectionId, duration_ms: Math.max(0, now() - startedAt), error,
          outcome: cancelled ? "cancelled" : "failed", providerFamily: snapshot.providerFamily, providerModelId: snapshot.providerModelId,
          run_id: runId, stage: answerPublished ? "completion" : "execution",
          ...failureCauseFields({ cancelled, failure, stopped: stop.signal.aborted, timedOut: deadline.signal.aborted, turnMs,
            workspaceRun: Boolean(workspace) }) });
        answer.stop();
        // Its sub-agents end with it and keep what they recorded; their turns settle before the run's records do.
        await runSubagents?.runner.stopAll(deadline.signal.aborted && !cancelled ? "deadline" : "parent_stopped");
        await runContext?.close();
        await live?.end("run_finished");
        if (workspace && input.workspace) {
          await input.workspace.settle({ onActivity: onWorkspaceActivity,
            outcome: cancelled ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed", runId, userId: input.userId, workspace })
            .catch(() => undefined);
        }
        // What the turn did stays on record for Continue and later turns.
        await runRecords?.flush();
        if (cancelled) {
          // Stop settled the run before its last streamed text was saved: the answer keeps what the user saw.
          if (!answerPublished && answer.text) {
            await engine.runs.saveStoppedText(scope, answer.text).catch((saveError: unknown) => {
              logEvent("service_operation", { action: "degrade", code: "answer_text_unsaved", error: saveError, outcome: "degraded",
                run_id: runId, stage: "write", subsystem: "database" });
            });
          }
          releaseGuardUsage();
          await usage.settle();
          await chatUpdate();
          sink.send({ data: { runId, status: "cancelled" }, type: "done" });
          return;
        }
        await answer.flush();
        const failed = await settleRunWrite(() => input.repository.failRun(runId, scope.assistantMessageId, payload,
          { recoveryTerminal: true })).then(({ timing, value }) => {
          logRunPersistence(runId, "fail", value ? "confirmed" : "not_applied", undefined, timing);
          return value;
        }, (writeError: unknown) => {
          logRunPersistence(runId, "fail", "unconfirmed", writeError);
          return false;
        });
        releaseGuardUsage();
        await usage.settle();
        if (failed) sink.send({ data: payload, type: "error" });
        else await chatUpdate();
      } finally {
        setRunProviderWait(runId, null);
        void live?.end("run_finished");
        // Its background turns keep their host for a grace, so one still attaching starts (`backgroundRunner.ts`).
        runSubagents?.releaseBackgroundHost();
        takeNativeRunInterruption(runId);
        releaseGuardUsage();
        stopKeepalive();
        clearTimeout(deadlineTimer);
        if (activeRunControllers.get(runId) === stop) activeRunControllers.delete(runId);
        runSettlements.delete(runId);
        resolveSettled();
        try {
          controller.close();
        } catch {
          // The browser already left.
        }
      }
    }
  });

  return new Response(stream, {
    headers: { "cache-control": "no-cache, no-transform", connection: "keep-alive", "content-type": "text/event-stream" }
  });
}

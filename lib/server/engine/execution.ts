import { randomUUID } from "node:crypto";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import { logEvent, runWithContext } from "../observability";
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
import { serializeChatUpdate } from "../runs/runExecution";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { reportedAnswerCost, usageAttributionsWithEstimatedCost } from "../runs/runFinalization";
import { withPinnedHostedSearchIdentity } from "../runs/searchArtifactIdentity";
import { ToolCallRepeatHistory } from "../runs/toolCallRepeatGuard";
import { toolRunBudgetsForRequest } from "../runs/toolBudgets";
import { workspaceTurnSoftDeadlineMs } from "../runs/workspaceTurnDeadline";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import type { ToolObservationService } from "../toolObservations/sourceAdapters";
import { reservedToolCallForRequest } from "../tools/reservedToolCall";
import { invalidProviderToolArguments, type ModelToolCall } from "../tools/types";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { createAnswerStream } from "./answerStream";
import { engineItemRules, turnEndedAfter } from "./compaction";
import { compactionModelCall } from "./compactionCalls";
import { buildRunConversation } from "./conversation";
import { detachedCompactions } from "./detachedCompactions";
import { createRunEventSink } from "./events";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "./faults";
import { runAgentLoop, type LoopToolChoice } from "./loop";
import { callModel } from "./modelCall";
import { createRunContext, type RunContext } from "./runContext";
import type { NativeRunStore } from "./runStore";
import { withNativeSystemPrompt } from "./systemPrompt";
import { runToolBatch, ToolBatchInactiveError, transcriptRecord, type ToolBatchDeps, type ToolBatchState } from "./toolBatch";
import type { ToolCallStore } from "./toolCallStore";
import { buildToolRegistry, engineMcpBindings, type ToolRegistryServices } from "./toolRegistry";
import { saveToolResultText, type SavedToolResultReader } from "./toolResults";
import { modelResponseItems, projectTranscript, type TranscriptItem, type TranscriptTarget, type TranscriptUserItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";
import { createTranscriptWriter, type TranscriptWriter } from "./transcriptWriter";
import { unknownEffectsOf } from "./unknownEffects";
import { createUsageLedger } from "./usage";

/**
 * The native engine's execution of one accepted run: the run's SSE response
 * the chat already renders, the agent loop over the run's transcript, and
 * answer-first settlement (the answer is published before Workspace hand-off,
 * completion and usage, none of which can take it back). Stop is the shared
 * handler: it cancels the run's row and aborts this run's controller.
 */
export const NATIVE_TURN_LIMITS = Object.freeze({
  /** A run without a Workspace answers within this long. */
  turnMs: 60 * 60_000,
  /** Before its deadline the turn stops calling tools and answers. */
  answerReserveMs: 5 * 60_000
});

export class EngineFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineFailure";
  }
}

export const CONTEXT_TOO_LARGE_MESSAGE =
  "This conversation no longer fits the model's context window. Start a new chat, or continue in a new chat from this answer.";

export type NativeEngineDeps = Readonly<{
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
  userId: string;
  workspace?: WorkspaceCoordinator;
}>;

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
 * wrote: answer review steps and approval continuations (`systemTurnKind`)
 * and scheduled task prompts. When they cannot be read, every one counts as
 * the server's, so no turn the engine cannot tell apart releases an unknown
 * effect.
 */
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
  const toolTimeEndsAt = startedAt + (workspace
    ? workspaceTurnSoftDeadlineMs(workspace.turnTimeoutSeconds, workspace.syncToolTimeoutSeconds)
    : turnMs - NATIVE_TURN_LIMITS.answerReserveMs);
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
      try {
        const control = await input.repository.getRunControlForUser(runId, input.userId);
        if (!control || !["in_progress", "queued", "streaming"].includes(control.status)) {
          throw new EngineFailure("model_run_not_active", "The answer is no longer running.");
        }
        sink.send({ data: { modelId: normalizedRequest.modelId, provider: normalizedRequest.provider, runId, status: "streaming" },
          type: "run_start" });
        sink.send({ data: { assistantMessageId: scope.assistantMessageId, userMessageId: input.created.userMessageId },
          type: "message_start" });
        const followupOps = input.prepared.followupAdmission ? input.repository.followups : undefined;
        if (followupOps) await chatUpdate();

        // The conversation: the frozen branch with earlier native answers as their items.
        const contextMessages = normalizedRequest.context?.messages ?? [{ content: normalizedRequest.content,
          id: "current-user-message", role: "user" as const }];
        const answerIds = contextMessages.filter((message) => message.role === "assistant" && message.purpose === undefined)
          .map((message) => message.id);
        const nativeRuns = await engine.transcripts.nativeRunsForAnswers({ assistantMessageIds: answerIds, chatId: scope.chatId,
          userId: input.userId });
        const runItems = await engine.transcripts.loadRuns({ chatId: scope.chatId, runIds: [...nativeRuns.values()], userId: input.userId });
        // A scheduled run's flat context takes only its previous result's own work: never a compaction of what came before
        // it, nor user input that entered that answer (a follow-up).
        const answerItems = (answer: readonly TranscriptItem[]) => input.scheduled
          ? answer.filter((item) => item.kind !== "compaction" && item.kind !== "user") : answer;
        const nativeAnswers = new Map([...nativeRuns].map(([messageId, nativeRunId]) => [messageId,
          answerItems(runItems.get(nativeRunId) ?? [])]));
        const continuationTurns = await engine.transcripts.approvalContinuationTurns({ chatId: scope.chatId,
          messageIds: contextMessages.filter((message) => message.role === "user").map((message) => message.id) });
        const conversationFor = (mode: "continuation" | "input") => buildRunConversation({ continuationTurns,
          current: { messageId: input.created.userMessageId, mode }, messages: contextMessages, nativeAnswers });
        let conversation = conversationFor(input.approvalContinuation ? "continuation" : "input");
        // An approval continuation sends the approved call itself, then continues the stopped turn with its result.
        let approvedCall: ModelToolCall | null = null;
        if (input.approvalContinuation) {
          const approved = await engine.approvedCall({ approvalId: input.approvalContinuation.approvalId, chatId: scope.chatId,
            userId: input.userId });
          const callItem = approved ? [...conversation.items].reverse().find((item) => item.kind === "tool_call" &&
            item.callId === approved.providerCallId && item.name === approved.toolName) : undefined;
          // Only the latest turn continues: once the user wrote again, a compaction may have cut past the call. The run sends
          // the call only with its tool admitted: an Auto run admits no MCP tool and loads it anew (`find_tools`).
          if (callItem?.kind === "tool_call" && !turnEndedAfter(conversation.items, callItem.id) &&
            resolveMcpRunTool(input.prepared.providerRequest.mcp, callItem.name)) {
            approvedCall = { arguments: parsedArguments(callItem.arguments), id: callItem.callId, name: callItem.name };
          } else {
            // The old core stopped that turn, the user wrote again since, or the tool is not loaded yet: the server's turn
            // is the instruction, and the call it allows is made again.
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
        // a turn the server wrote: an approval continuation, an answer review step or a scheduled task's prompt.
        const serverInput = Boolean(input.approvalContinuation) || input.scheduled === true ||
          normalizedRequest.answerReviewStep !== undefined;
        // Only an earlier turn after the branch's first call could release an effect, so only those are looked up.
        const firstCall = conversation.items.findIndex((item) => item.kind === "tool_call");
        const laterItems = new Set(firstCall < 0 ? [] : conversation.items.slice(firstCall).map((item) => item.id));
        const laterTurns = contextMessages.slice(0, -1)
          .filter((message) => message.role === "user" && laterItems.has(`msg-${message.id}`)).map((message) => message.id);
        const serverWritten = await serverWrittenTurns(input.repository, { chatId: scope.chatId, messageIds: laterTurns,
          userId: input.userId });
        const serverTurns = new Set([...continuationTurns, ...serverWritten].map((messageId) => `msg-${messageId}`));
        const unknownEffects = unknownEffectsOf(conversation.items, (item) => item.followup === true ||
          (item.id === conversation.currentInputId ? !serverInput : item.id.startsWith("msg-") && !serverTurns.has(item.id)));

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
        const registry = await buildToolRegistry({
          chatId: scope.chatId,
          followupTexts: () => delivered,
          loadMcpBindingRows: () => engine.mcpBindingRows(runId),
          mcpBindings,
          onEvent: (event) => sink.publish(event),
          onUsage: (attribution) => usage.add(attribution),
          onWorkspaceActivity,
          request: base,
          runId,
          services: { ...input.services, mcpRuntime: input.mcpRuntime, repository: input.repository, savedResults: engine.savedResults,
            workspace: input.workspace },
          userId: input.userId
        });
        // Every request of the run carries one system prompt for its tools (`systemPrompt.ts`).
        base = await withNativeSystemPrompt({ now: new Date(startedAt), request: base, scope: { runId, userId: input.userId },
          secrets: input.services.secrets, snapshot, tools: registry.definitions() });
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
        const budgets = toolRunBudgetsForRequest(normalizedRequest);
        const toolState: ToolBatchState = { calls: 0 };
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
          saveResult: async (save) => saveToolResultText({ outcome: save.outcome,
            producer: { runId, toolCallId: save.toolCallId, userId: input.userId }, service: await engine.observations(),
            signal: save.signal, source: save.source, text: save.text }),
          signal,
          store: engine.toolCalls,
          unknownEffects,
          userId: input.userId
        };

        if (approvedCall && input.approvalContinuation) {
          const batch = await runToolBatch(batchDeps, toolState, {
            approved: { approvalId: input.approvalContinuation.approvalId, callId: approvedCall.id }, calls: [approvedCall], round: 0
          });
          await append(batch.results);
          if (batch.approvals.length > 0) await emitApprovalCards();
        }

        const target: TranscriptTarget = { model: normalizedRequest.modelId, provider: snapshot.connectionId,
          ...(nativeCompactionRoute(snapshot) ? { nativeCompaction: true } : {}) };
        const params = nativeRequestParams(snapshot.model.adapterKind, base.params);
        const timeoutMs = effectiveProviderResponseTimeoutMs(snapshot.connection,
          snapshot.model.adapterKind === "fake" ? null : snapshot.model);
        let pending: ModelRunSseEvent[] = [];
        let followupRevision = 0;
        const recordModelUsage = (reported: ModelRunUsage, costUsd: number | undefined) => usage.add({ ...reportedAnswerCost(costUsd),
          modelId: normalizedRequest.modelId, operationCount: 1, provider: normalizedRequest.provider,
          providerModelId: snapshot.providerModelId, purpose: "chat_answer", usage: reported } satisfies RunUsageAttribution);
        // Measurement and compaction before every request (`runContext.ts`); compaction calls are the answer model's.
        const context = createRunContext({
          append,
          compactionCall: (latest) => compactionModelCall({ adapter: input.adapter, deadlineAt: startedAt + turnMs, now,
            onUsage: recordModelUsage, timeoutMs }, latest),
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
          projection: conversation.currentInputId ? { currentInputId: conversation.currentInputId } : {},
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
            onUsage: recordModelUsage,
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
            await answer.flush();
            if (!await followupOps.deliver({ budgetTokens: 8_192, precedingText: answer.text, revision: batch.revision, runId,
              userId: input.userId })) return [];
            followupRevision = batch.revision;
            delivered.push(...accepted.map((entry) => entry.text));
            unknownEffects.userSpoke();
            // The answer starts over after the user's follow-up, as the delivered record shows.
            answer.restart();
            sink.send({ data: { round: batch.revision }, type: "message_reset" });
            await chatUpdate();
            return accepted.map((entry) => ({ followup: true as const, id: randomUUID(), kind: "user" as const, text: entry.text }));
          },
          maxToolRounds: budgets.maxToolRounds,
          prepareRequest: async ({ reserved: reservedRound, toolChoice }: Readonly<{ reserved?: true; round: number;
            toolChoice: LoopToolChoice }>) => {
            const tools = [...registry.definitions()];
            const request: ProviderRunRequest = {
              ...base,
              history: projectTranscript(items, target, { ...(conversation.currentInputId ? { currentInputId: conversation.currentInputId } : {}) }),
              params,
              parallelToolCalls: true,
              previousProviderResponseId: undefined,
              providerToolMessages: undefined,
              toolChoice,
              tools
            };
            // Compaction at the request boundary; a request that cannot fit even then fails visibly.
            const prepared = await context.prepare(request);
            // The reserved round's instruction rides on its request only, never on the transcript.
            return reservedRound && reserved
              ? { ...prepared, history: [...(prepared.history ?? []), { text: reserved.instruction, type: "user" as const }] }
              : prepared;
          },
          ...(reserved ? { reservedCall: { name: reserved.name, outstanding: () => toolState.reservedCalled !== true } } : {}),
          responseItems: (result) => modelResponseItems({ estimate: estimateApproxTokens,
            history: result.history ?? fallbackHistory(result), nextId: randomUUID, origin: target, usage: result.usage }),
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
            if (batch.approvals.length > 0) await emitApprovalCards();
            return batch;
          },
          signal,
          toolTimeLeft: () => now() < toolTimeEndsAt
        });
        if (outcome.kind === "approval") logEvent("run_execution", { run_id: runId, stage: "execution", outcome: "completed",
          code: "waiting_approval" });

        // Answer first: the text is published before hand-off, completion and usage.
        signal.throwIfAborted();
        await answer.flush();
        if (!await engine.runs.publishAnswer(scope, { followupRevision, text: answer.text })) {
          signal.throwIfAborted();
          throw new EngineFailure("run_answer_not_published", "The answer could not be saved. Send your request again.");
        }
        answerPublished = true;
        sink.send({ data: { assistantMessageId: scope.assistantMessageId, runId }, type: "answer_complete" });
        // Answer first: a finished compaction is kept now, a running one goes on detached and never holds the run.
        await context.afterAnswer();
        // The transcript is on record (or given up) before the run completes and the next turn can read it.
        await writer.flush();
        if (input.chatTitleGenerator && answer.text) {
          await input.chatTitleGenerator.schedule({ answerText: answer.text, chatId: scope.chatId, runId, userId: input.userId,
            userMessageId: input.created.userMessageId }).catch(() => undefined);
        }
        if (workspace && input.workspace) {
          const handoff = await input.workspace.handoff({ onActivity: onWorkspaceActivity, runId, signal, userId: input.userId, workspace });
          if (handoff.status !== "ready") throw new EngineFailure("workspace_operation_stale", "The Workspace could not hand off this turn.");
        }
        await engine.runs.complete(scope);
        logEvent("run_execution", { adapterKind: snapshot.model.adapterKind, connectionId: snapshot.connectionId,
          duration_ms: Math.max(0, now() - startedAt), outcome: "completed", providerFamily: snapshot.providerFamily,
          providerModelId: snapshot.providerModelId, run_id: runId, stage: "completion" });
        await usage.settle();
        await chatUpdate();
        sink.send({ data: { runId, status: "complete" }, type: "done" });
      } catch (error) {
        const cancelled = stop.signal.aborted || error instanceof ToolBatchInactiveError && !deadline.signal.aborted;
        const failure = deadline.signal.aborted && !cancelled ? deadline.signal.reason : error;
        const payload = failurePayload(failure, Boolean(workspace));
        logEvent("run_execution", { adapterKind: snapshot.model.adapterKind, code: cancelled ? "model_run_cancelled" : payload.code,
          connectionId: snapshot.connectionId, duration_ms: Math.max(0, now() - startedAt), error,
          outcome: cancelled ? "cancelled" : "failed", providerFamily: snapshot.providerFamily, providerModelId: snapshot.providerModelId,
          run_id: runId, stage: answerPublished ? "completion" : "execution" });
        answer.stop();
        await runContext?.close();
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
          await usage.settle();
          await chatUpdate();
          sink.send({ data: { runId, status: "cancelled" }, type: "done" });
          return;
        }
        await answer.flush();
        const failed = await input.repository.failRun(runId, scope.assistantMessageId, payload, { recoveryTerminal: true })
          .catch(() => false);
        await usage.settle();
        if (failed) sink.send({ data: payload, type: "error" });
        else await chatUpdate();
      } finally {
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

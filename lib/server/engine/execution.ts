import { randomUUID } from "node:crypto";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { logEvent, runWithContext } from "../observability";
import type { ProviderHistoryItem } from "../providers/history";
import { isProviderDeadlineExceededError } from "../providers/network";
import { assertPersonalContextEgressSafe } from "../providers/personalContext";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import { observedFailure, providerHttpFailureMessage } from "../providers/providerObservability";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED } from "../providers/responseFailure";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllers, runSettlements } from "../runs/activeRunControllerRegistry";
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
import { invalidProviderToolArguments, type ModelToolCall } from "../tools/types";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { createAnswerStream } from "./answerStream";
import { measureContext, contextAnchor, type ContextAnchor } from "./contextMeasure";
import { buildRunConversation } from "./conversation";
import { createRunEventSink } from "./events";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "./faults";
import { runAgentLoop, type LoopToolChoice } from "./loop";
import { callModel } from "./modelCall";
import type { NativeRunStore } from "./runStore";
import { runToolBatch, ToolBatchInactiveError, transcriptRecord, type ToolBatchDeps } from "./toolBatch";
import type { ToolCallStore } from "./toolCallStore";
import { buildToolRegistry, engineMcpBindings, type ToolRegistryServices } from "./toolRegistry";
import { saveToolResultText, type SavedToolResultReader } from "./toolResults";
import { modelResponseItems, projectTranscript, type TranscriptItem, type TranscriptTarget, type TranscriptUserItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";
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
        const nativeAnswers = new Map([...nativeRuns].map(([messageId, nativeRunId]) => [messageId, runItems.get(nativeRunId) ?? []]));
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
          if (callItem?.kind === "tool_call") {
            approvedCall = { arguments: parsedArguments(callItem.arguments), id: callItem.callId, name: callItem.name };
          } else {
            // The old core stopped that turn: the server's turn is the instruction, and the call it allows is made again.
            conversation = conversationFor("input");
          }
        }
        const items: TranscriptItem[] = [...conversation.items];
        let sequence = await engine.transcripts.nextSequence(scope);

        let base = input.prepared.providerRequest;
        if (conversation.currentInputId && input.services.images) {
          base = await input.services.images.withConversationPixels(base, input.userId, signal,
            async () => sink.send(liveRunPhaseStatus({ phase: "files" })));
        }
        // An approval continuation has no input of its own: nothing rides on it.
        if (!conversation.currentInputId) base = { ...base, attachments: [] };
        assertPersonalContextEgressSafe(base);

        const mcpBindings = engineMcpBindings(input.prepared.mcpBindings ?? [], await engine.mcpBindingRows(runId));
        const delivered: string[] = [];
        const registry = await buildToolRegistry({
          chatId: scope.chatId,
          followupTexts: () => delivered,
          loadMcpBindings: async () => engineMcpBindings(input.prepared.mcpBindings ?? [], await engine.mcpBindingRows(runId)),
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
        // The run reads its items whole; the transcript keeps what later turns may read.
        const append = async (added: readonly TranscriptItem[]) => {
          if (added.length === 0) return;
          items.push(...added);
          await engine.transcripts.append(scope, sequence, added.map((item) => transcriptRecord(registry, item)));
          sequence += added.length;
        };
        const budgets = toolRunBudgetsForRequest(normalizedRequest);
        const toolState = { calls: 0 };
        const batchDeps: ToolBatchDeps = {
          chatId: scope.chatId,
          history: new ToolCallRepeatHistory(),
          maxToolCalls: budgets.maxToolCalls,
          onEvent: (event) => sink.publish(event),
          onLiveEvent: sink.send,
          registry,
          runId,
          saveResult: async (save) => saveToolResultText({ outcome: save.outcome,
            producer: { runId, toolCallId: save.toolCallId, userId: input.userId }, service: await engine.observations(),
            signal: save.signal, source: save.source, text: save.text }),
          signal,
          store: engine.toolCalls,
          userId: input.userId
        };

        if (approvedCall) {
          const batch = await runToolBatch(batchDeps, toolState, { calls: [approvedCall], round: 0 });
          await append(batch.results);
          if (batch.approvals.length > 0) await emitApprovalCards();
        }

        const target: TranscriptTarget = { model: normalizedRequest.modelId, provider: snapshot.connectionId };
        const params = nativeRequestParams(snapshot.model.adapterKind, base.params);
        const timeoutMs = effectiveProviderResponseTimeoutMs(snapshot.connection,
          snapshot.model.adapterKind === "fake" ? null : snapshot.model);
        let anchor: ContextAnchor | null = null;
        let requestItems = 0;
        let pending: ModelRunSseEvent[] = [];
        let followupRevision = 0;
        const outcome = await runAgentLoop({
          append,
          callModel: (request) => callModel({
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
            onUsage: (reported: ModelRunUsage, costUsd) => usage.add({ ...reportedAnswerCost(costUsd), modelId: normalizedRequest.modelId,
              operationCount: 1, provider: normalizedRequest.provider, providerModelId: snapshot.providerModelId, purpose: "chat_answer",
              usage: reported } satisfies RunUsageAttribution),
            signal,
            timeoutMs
          }, request),
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
            // The answer starts over after the user's follow-up, as the delivered record shows.
            answer.restart();
            sink.send({ data: { round: batch.revision }, type: "message_reset" });
            await chatUpdate();
            return accepted.map((entry) => ({ followup: true as const, id: randomUUID(), kind: "user" as const, text: entry.text }));
          },
          maxToolRounds: budgets.maxToolRounds,
          prepareRequest: async ({ toolChoice }: Readonly<{ round: number; toolChoice: LoopToolChoice }>) => {
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
            // The compaction seam: until it exists, a request that cannot fit fails visibly.
            const measure = measureContext({ anchor, estimate: estimateApproxTokens,
              fixedTokens: estimateApproxTokens([base.prompt, tools]), items, target });
            const window = base.modelCapabilities.contextWindow ?? 0;
            if (window > 0 && measure.tokens + maxOutputTokens(base) > window) {
              throw new EngineFailure("context_too_large", CONTEXT_TOO_LARGE_MESSAGE);
            }
            requestItems = items.length;
            return request;
          },
          responseItems: (result) => modelResponseItems({ estimate: estimateApproxTokens,
            history: result.history ?? fallbackHistory(result), nextId: randomUUID, origin: target, usage: result.usage }),
          roundEnd: async (result) => {
            for (const event of pending) await sink.publish(event);
            pending = [];
            answer.completeRound(result.finalText);
            anchor = contextAnchor({ itemCount: requestItems, target, usage: result.usage }) ?? anchor;
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
        if (workspace && input.workspace) {
          await input.workspace.settle({ onActivity: onWorkspaceActivity,
            outcome: cancelled ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed", runId, userId: input.userId, workspace })
            .catch(() => undefined);
        }
        if (cancelled) {
          // Stop already settled the run; its text so far stays with the answer.
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

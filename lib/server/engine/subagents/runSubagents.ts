import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../../contracts/workspace";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { logEvent } from "../../observability";
import { codexLbConnection } from "../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../../providers/types";
import type { RunModelConfiguration } from "../../runs/runRepositoryContract";
import type { ToolRunBudgets } from "../../runs/toolBudgets";
import type { WorkspaceAgent } from "../../subagents/guestProtocol";
import type { BrowserAgentIdentity, SubagentBackgroundControl, SubagentBinding, SubagentTypeResolver } from "../../subagents/ports";
import type { RunTool } from "../../tools/types";
import type { RunSecretSource } from "../../workspace/secrets/runSecrets";
import type { EngineTestFaults } from "../faults";
import type { SubagentPromptFacts } from "../prompts";
import { windowOutputParams } from "../runContext";
import type { NativeRunStore } from "../runStore";
import type { ToolBatchDeps, ToolBatchState } from "../toolBatch";
import type { ToolCallStore } from "../toolCallStore";
import type { EngineTool, ToolRegistry } from "../toolRegistry";
import type { TranscriptItem, TranscriptTarget } from "../transcript";
import type { TranscriptRepository } from "../transcriptRepository";
import type { UsageLedger } from "../usage";
import { subagentEngineTools, type SubagentCallDeps } from "./callTools";
import { decodeSubagentModels, type FrozenSubagentModels, type SubagentParentModel } from "./modelCatalog";
import { parentSubagentRoute, type SubagentModelCatalog, type SubagentModelRoute, type SubagentRouteResult } from "./modelRoutes";
import { createSubagentRunner, type HostedSubagentRunner } from "./runner";
import type { SubagentThreadStore } from "./threadStore";

/**
 * Sub-agents of one native run: the `call_subagent` and `stop_subagent`
 * registry entries of its main agent and the runner of their foreground
 * turns, over the run's own frozen bindings, registry builder, stores and
 * ledger. A run gets none without the thread store (tests and entry points
 * that do not wire it), when its tools are off, or when it is a monitoring
 * check, which reports alone.
 */

/** The ports other slices implement, given to a run by its entry point; absent ones are unavailable (`callTools.ts`). */
export type SubagentRunPorts = Readonly<{
  background?: SubagentBackgroundControl;
  browserIdentity?: BrowserAgentIdentity;
  types?: SubagentTypeResolver;
}>;

/** What the engine itself keeps for sub-agents (`defaultEngine.ts`). */
export type SubagentEngineDeps = Readonly<{
  /** Routes of frozen models other than the parent's; absent, only the parent's model runs sub-agents. */
  subagentModels?: SubagentModelCatalog;
  subagentThreads?: SubagentThreadStore;
}>;

export type RunSubagents = Readonly<{
  prompt: SubagentPromptFacts;
  runner: HostedSubagentRunner;
  tools: readonly EngineTool[];
}>;

/** A follow-up the user wrote (not a sub-agent's callback or the main agent's message). */
export function userAuthoredFollowup(entry: object): boolean {
  const origin = (entry as { origin?: unknown }).origin;
  return origin === undefined || origin === "user";
}

/** The user's current message: the run's own, or for a turn the server wrote (an approval continuation) the latest user one. */
export function currentUserMessageText(messages: readonly ProviderConversationMessage[], serverTurns: ReadonlySet<string>): string {
  const user = [...messages].reverse().find((message) => message.role === "user" && message.purpose === undefined &&
    message.followupOf === undefined && !serverTurns.has(message.id));
  return user ? textFromContentBlocks(user.content) : "";
}

function maxOutputTokens(request: Pick<ProviderRunRequest, "modelCapabilities" | "params">): number {
  const value = request.params.maxOutputTokens ?? request.params.maxTokens ?? request.modelCapabilities.defaultMaxOutputTokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** As `nativeRequestParams` in `execution.ts`: the Responses family streams in the foreground. */
function streamedParams(adapterKind: string, params: Record<string, unknown>): Record<string, unknown> {
  return adapterKind === "openai_responses_compatible" || adapterKind === "openai_responses_native"
    ? { ...params, background: false, stream: true } : params;
}

/** How a route's requests render, sized and replayed as the parent's are (`execution.ts`). */
export function subagentRequestShape(route: SubagentModelRoute) {
  const kind = route.snapshot.model.adapterKind;
  const outputs = maxOutputTokens(route.request);
  const target: TranscriptTarget = { model: route.request.modelId, provider: route.snapshot.connectionId,
    ...(kind === "openai_responses_native" || kind === "openai_responses_compatible" && codexLbConnection(route.snapshot.connection)
      ? { nativeCompaction: true } : {}),
    ...(kind === "anthropic_messages" ? { reasoningScope: "current_turn" as const } : {}) };
  return { maxOutputTokens: outputs, params: streamedParams(kind, windowOutputParams({ ...route.request.params },
    { contextWindow: route.request.modelCapabilities.contextWindow, maxOutputTokens: outputs })), target };
}

export type PrepareRunSubagentsInput = Readonly<{
  adapter: ProviderAdapter;
  /** The run's admitted request before its native system prompt. */
  admittedRequest: ProviderRunRequest;
  answerTimeoutMs: number;
  assistantRun: boolean;
  /** The native runs of the branch's earlier answers, in branch order. */
  branchRunIds: readonly string[];
  buildRegistry(input: Readonly<{ agent: WorkspaceAgent; followupTexts(): readonly string[];
    onWorkspaceActivity(entry: ThreadWorkspaceActivityEntry): Promise<void>; request: ProviderRunRequest }>): Promise<ToolRegistry>;
  budgets: ToolRunBudgets;
  callTimeLeft(tool: Pick<RunTool, "capability" | "name">): boolean;
  chatId: string;
  deadline: AbortSignal;
  deadlineAt: number;
  engine: SubagentEngineDeps & Readonly<{ runs: Pick<NativeRunStore, "recordDetachedCompaction">; toolCalls: ToolCallStore;
    transcripts: Pick<TranscriptRepository, "append" | "loadRuns" | "nextSequence" | "runLive"> }>;
  faults?: EngineTestFaults;
  followupTexts(): readonly string[];
  modelConfiguration: RunModelConfiguration;
  now(): number;
  onWorkspaceLifecycle(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  pendingUserFollowups(): Promise<readonly Readonly<{ id: string; text: string }>[]>;
  ports?: SubagentRunPorts;
  runContextItems: readonly TranscriptItem[];
  runId: string;
  saveResult: ToolBatchDeps["saveResult"];
  scope: Readonly<{ assistantMessageId: string; chatId: string; runId: string; userId: string }>;
  secrets?: RunSecretSource;
  signal: AbortSignal;
  snapshot: ProviderExecutionSnapshot;
  toolState: ToolBatchState;
  toolTimeLeft(): boolean;
  usage: Pick<UsageLedger, "add" | "settle">;
  userMessage: string;
}>;

/** The run's sub-agents, or null when it offers none. */
export async function prepareRunSubagents(input: PrepareRunSubagentsInput): Promise<RunSubagents | null> {
  const store = input.engine.subagentThreads;
  const request = input.admittedRequest;
  if (!store || request.toolMode === "none" || request.monitoringVerdictTool === true) return null;
  const catalog: FrozenSubagentModels | null = input.assistantRun ? null : decodeSubagentModels(request.subagentModels);
  const snapshot = input.snapshot;
  const parentEntry = catalog?.models.find((entry) => entry.connectionId === snapshot.connectionId &&
    entry.providerModelId === snapshot.providerModelId);
  const parent: SubagentParentModel = {
    connectionId: snapshot.connectionId,
    effort: request.reasoningEffort ?? null,
    efforts: parentEntry?.reasoningEfforts ?? request.modelCapabilities.reasoningEfforts ?? [],
    providerModelId: snapshot.providerModelId,
    upstreamModelId: snapshot.model.upstreamModelId
  };
  const route = async (binding: SubagentBinding, signal?: AbortSignal): Promise<SubagentRouteResult> => {
    if (binding.provider === snapshot.connectionId && binding.providerModelId === snapshot.providerModelId) {
      return parentSubagentRoute({ adapter: input.adapter, effort: binding.reasoningEffort, modelConfiguration: input.modelConfiguration,
        request, snapshot, timeoutMs: input.answerTimeoutMs });
    }
    const entry = catalog?.models.find((candidate) => candidate.connectionId === binding.provider &&
      candidate.providerModelId === binding.providerModelId);
    if (!entry || !input.engine.subagentModels) return { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false };
    return input.engine.subagentModels.route({ chatId: input.chatId, effort: binding.reasoningEffort, entry, runId: input.runId,
      ...(signal ? { signal } : {}), userId: input.scope.userId });
  };
  const runner = createSubagentRunner({
    buildRegistry: input.buildRegistry,
    branchRunIds: input.branchRunIds,
    ...(input.ports?.browserIdentity ? { browserIdentity: input.ports.browserIdentity } : {}),
    callTimeLeft: input.callTimeLeft,
    chatId: input.chatId,
    deadlineAt: input.deadlineAt,
    deadlineSignal: input.deadline,
    ...(input.faults ? { faults: input.faults } : {}),
    followupTexts: input.followupTexts,
    maxToolCalls: input.budgets.maxToolCalls,
    maxToolRounds: input.budgets.maxToolRounds,
    now: input.now,
    onWorkspaceLifecycle: input.onWorkspaceLifecycle,
    pendingUserFollowups: input.pendingUserFollowups,
    recordDetachedCompaction: ({ item, sequence, thread }) =>
      input.engine.runs.recordDetachedCompaction(input.scope, { item, sequence, status: null, thread }),
    request,
    requestShape: subagentRequestShape,
    route,
    runContextItems: input.runContextItems,
    saveResult: input.saveResult,
    ...(input.secrets ? { secrets: input.secrets } : {}),
    setTurnState: ({ state, turnId }) => store.setActiveState({ chatId: input.chatId, state, turnId, userId: input.scope.userId }),
    settleTurn: ({ result, turnId }) => store.settle({ chatId: input.chatId, result, turnId, userId: input.scope.userId }),
    settleUsage: async () => { await input.usage.settle(); },
    signal: input.signal,
    toolCalls: input.engine.toolCalls,
    toolState: input.toolState,
    toolTimeLeft: input.toolTimeLeft,
    transcripts: input.engine.transcripts,
    usage: (attribution) => input.usage.add(attribution),
    userId: input.scope.userId
  });
  const deps: SubagentCallDeps = {
    assistantRun: input.assistantRun,
    ...(input.ports?.background ? { background: input.ports.background } : {}),
    branchRunIds: [...input.branchRunIds, input.runId],
    catalog,
    chatId: input.chatId,
    deadlineAt: () => new Date(input.deadlineAt),
    parent,
    runId: input.runId,
    runner,
    store,
    ...(input.ports?.types && !input.assistantRun ? { types: input.ports.types } : {}),
    userMessage: input.userMessage,
    userId: input.scope.userId
  };
  let types: SubagentPromptFacts["types"] = [];
  if (deps.types) {
    try {
      types = await deps.types.catalog({ userId: input.scope.userId });
    } catch (error) {
      // The context goes without the list; a call naming a type is still checked at the call.
      logEvent("service_operation", { action: "degrade", code: "subagent_types_unreadable", error, outcome: "degraded", run_id: input.runId,
        stage: "read", subsystem: "database" });
    }
  }
  // A model is listed by its upstream id, or by its catalog id where two connections serve the same one.
  const models = catalog?.models ?? [];
  const shared = (entry: (typeof models)[number]) => models.filter((other) => other.upstreamModelId === entry.upstreamModelId).length > 1;
  const prompt: SubagentPromptFacts = {
    models: models.map((entry) => ({ efforts: entry.reasoningEfforts, id: shared(entry) ? entry.providerModelId : entry.upstreamModelId,
      name: entry.displayName })),
    types
  };
  return { prompt, runner, tools: subagentEngineTools(deps) };
}

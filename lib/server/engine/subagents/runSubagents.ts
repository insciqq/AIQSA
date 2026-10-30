import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import { workspaceRunOutputDirectory } from "../../../domain/workspace";
import type { ThreadWorkspaceActivityEntry } from "../../../contracts/workspace";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { logEvent } from "../../observability";
import { codexLbConnection } from "../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../../providers/types";
import type { RunModelConfiguration, RunUsageAttribution } from "../../runs/runRepositoryContract";
import type { ToolRunBudgets } from "../../runs/toolBudgets";
import type { WorkspaceAgent } from "../../subagents/guestProtocol";
import type {
  BrowserAgentIdentity,
  SubagentBackgroundControl,
  SubagentBinding,
  SubagentRunner,
  SubagentTurnInput,
  SubagentTypeResolver
} from "../../subagents/ports";
import type { RunTool } from "../../tools/types";
import type { BrowserLiveRunHandle } from "../../workspace/browserLive";
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
import type { UnknownEffects } from "../unknownEffects";
import type { UsageLedger } from "../usage";
import { subagentEngineTools, type SubagentCallDeps } from "./callTools";
import { decodeSubagentModels, type FrozenSubagentModels, type SubagentParentModel } from "./modelCatalog";
import { modelEffortOptions, parentSubagentRoute, type SubagentModelCatalog, type SubagentModelRoute, type SubagentRouteResult } from "./modelRoutes";
import { registerSubagentBackgroundHost, withForegroundTurnStops } from "./backgroundRunner";
import { createSubagentRunner, WORKSPACE_TURN_GUIDANCE_PREFIX, type HostedSubagentRunner, type SubagentHost } from "./runner";
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
  /** The user's custom sub-agents for the run's context (`renderSubagentTypeCatalog`), never the system prompt. */
  catalog: SubagentPromptFacts["types"];
  prompt: SubagentPromptFacts;
  /** Keeps the run's background host for the turns it admitted (`backgroundRunner.ts`); called once the run ended. */
  releaseBackgroundHost(): void;
  runner: HostedSubagentRunner;
  tools: readonly EngineTool[];
}>;

/** What a background turn's own run uses instead of its parent's: its id, ledger, tool time and live-browser membership. */
export type SubagentRegistryHost = Readonly<{
  live: BrowserLiveRunHandle | null;
  onUsage(attribution: RunUsageAttribution): void;
  runId: string;
  toolTimeLeftMs(): number;
}>;

/** The parts of a background turn's run its entry point provides (`execution.ts`). */
export type SubagentBackgroundParts = Readonly<{
  /** The run's membership in the chat's live browser, for its handoffs; null where no live browser is shown. */
  live(runId: string): BrowserLiveRunHandle | null;
  /** Records a compaction of the run's thread that finished after its turn. */
  recordDetachedCompaction(runId: string, input: Parameters<SubagentHost["recordDetachedCompaction"]>[0]): Promise<boolean>;
  /** Saves a long result of the run's own calls for a later read. */
  saveResult(runId: string): ToolBatchDeps["saveResult"];
  /** The runs holding a thread's items on the branch (`SubagentThreadStore.threadRunIds`). */
  threadRunIds(threadId: string): Promise<readonly string[]>;
  /** The run's own usage ledger. */
  usage(runId: string): Pick<UsageLedger, "add" | "settle">;
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
    /** A background turn's own run; absent, the parent run's. */
    host?: SubagentRegistryHost;
    onWorkspaceActivity(entry: ThreadWorkspaceActivityEntry): Promise<void>; request: ProviderRunRequest }>): Promise<ToolRegistry>;
  /** Background turns' own runs; absent, background turns cannot run here. */
  backgroundParts?: SubagentBackgroundParts;
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
  /** Background turns are offered (web chats); never in a Telegram turn or a scheduled occurrence. */
  backgroundAllowed: boolean;
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
  /** A thread's view of the run's agent fences (`createAgentUnknownEffects`): its own, and every other agent's to find. */
  unknownEffects(threadId: string): UnknownEffects;
  usage: Pick<UsageLedger, "add" | "settle">;
  /** Every follow-up the user wrote into this answer (delivered to the main agent or not yet), oldest first. */
  userFollowups(): Promise<readonly Readonly<{ id: string; text: string }>[]>;
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
    // The parent's own model's options, as its route checks them; its admitted effort itself is never checked again.
    efforts: parentEntry?.reasoningEfforts ?? modelEffortOptions({ adapterKind: input.modelConfiguration.adapterKind,
      capabilities: input.modelConfiguration.capabilities, defaultParams: input.modelConfiguration.defaultParams,
      providerFamily: snapshot.providerFamily, reasoningModePath: Boolean(input.modelConfiguration.reasoningRequestMapping?.modePath),
      upstreamModelId: snapshot.model.upstreamModelId }),
    providerModelId: snapshot.providerModelId,
    upstreamModelId: snapshot.model.upstreamModelId
  };
  /**
   * The route of a binding from the run's frozen catalog. A background turn's own run (`hostRunId`) reads the binding
   * its parent's call recorded, while that turn's run is active, so it outlives its parent's answer (`modelRoutes.ts`).
   */
  const routeFor = (hostRunId: string | null) => async (binding: SubagentBinding, signal?: AbortSignal): Promise<SubagentRouteResult> => {
    if (binding.provider === snapshot.connectionId && binding.providerModelId === snapshot.providerModelId) {
      return parentSubagentRoute({ adapter: input.adapter, effort: binding.reasoningEffort, modelConfiguration: input.modelConfiguration,
        request, snapshot, timeoutMs: input.answerTimeoutMs });
    }
    const entry = catalog?.models.find((candidate) => candidate.connectionId === binding.provider &&
      candidate.providerModelId === binding.providerModelId);
    if (!entry || !input.engine.subagentModels) return { code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false };
    return input.engine.subagentModels.route({ chatId: input.chatId, effort: binding.reasoningEffort, entry,
      ...(hostRunId ? { hostRunId } : {}), runId: input.runId, ...(signal ? { signal } : {}), userId: input.scope.userId });
  };
  const route = routeFor(null);
  const foregroundHost: SubagentHost = {
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
    userFollowups: input.userFollowups,
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
    ...(input.backgroundParts ? { threadRunIds: input.backgroundParts.threadRunIds } : {}),
    toolCalls: input.engine.toolCalls,
    toolState: input.toolState,
    toolTimeLeft: input.toolTimeLeft,
    unknownEffects: input.unknownEffects,
    transcripts: input.engine.transcripts,
    usage: (attribution) => input.usage.add(attribution),
    userId: input.scope.userId
  };
  // Its foreground turns are listed for the thread Stop and Stop all, which reach them like background ones.
  const runner = withForegroundTurnStops(createSubagentRunner(foregroundHost));
  // Background turns this run admits run on a host of their own over the same frozen bindings (`backgroundRunner.ts`).
  const parts = input.backgroundParts;
  const port = input.ports?.background;
  const host = parts && port && input.backgroundAllowed
    ? registerSubagentBackgroundHost(input.runId, (turn) => backgroundSubagentRunner(input, { ...foregroundHost,
      route: routeFor(turn.hostRunId) }, parts, turn))
    : null;
  // Only a run that asked for a background start keeps its host past its end (`SubagentBackgroundHostRegistration`).
  const background: SubagentBackgroundControl | undefined = port && host ? { availability: port.availability.bind(port),
    deliver: port.deliver.bind(port), start: (start) => {
      host.use();
      return port.start(start);
    }, stop: port.stop.bind(port) } : port;
  const releaseBackgroundHost = () => host?.release();
  const deps: SubagentCallDeps = {
    assistantRun: input.assistantRun,
    backgroundAllowed: input.backgroundAllowed,
    ...(background ? { background } : {}),
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
  // The custom sub-agents ride in run context, so the system prompt stays the same when the user edits them.
  return { catalog: types, prompt: { ...prompt, types: [] }, releaseBackgroundHost, runner, tools: subagentEngineTools(deps) };
}

/**
 * The request of a background turn's own run: its parent's, with the run's own output directory, which its Workspace
 * binding names (`bindSubagentRunWorkspace`), in its Workspace and in the turn guidance a sub-agent keeps.
 */
export function backgroundSubagentRequest(request: ProviderRunRequest, runId: string): ProviderRunRequest {
  const workspace = request.workspace;
  if (!workspace) return request;
  const outputDirectory = workspaceRunOutputDirectory(runId);
  const guidance = request.prompt.turnGuidance?.map((part) => part.startsWith(WORKSPACE_TURN_GUIDANCE_PREFIX)
    ? part.split(workspace.outputDirectory).join(outputDirectory) : part);
  return { ...request, prompt: { ...request.prompt, ...(guidance ? { turnGuidance: guidance } : {}) },
    workspace: { ...workspace, outputDirectory } };
}

/**
 * One background turn on its parent run's host: the parent's bindings, registry builder and routes, with the turn's
 * own run, signal, deadline, tool budget, usage ledger and live-browser membership. The control settles the turn
 * (`SubagentBackgroundControl`), so the runner's own settlement does nothing; the ledger is written and the
 * membership ends once the turn ended.
 */
function backgroundSubagentRunner(input: PrepareRunSubagentsInput, parent: SubagentHost, parts: SubagentBackgroundParts,
  turn: SubagentTurnInput): SubagentRunner {
  const runId = turn.hostRunId;
  const deadlineAt = turn.deadlineAt.getTime();
  // Room for the report after the last tool call, as the parent's tool time leaves room for its answer.
  const toolTimeEndsAt = deadlineAt - Math.min(input.answerTimeoutMs, Math.max(0, deadlineAt - input.now()) / 2);
  const toolTimeLeft = () => input.now() < toolTimeEndsAt;
  const ledger = parts.usage(runId);
  const live = parts.live(runId);
  const registryHost: SubagentRegistryHost = { live, onUsage: (attribution) => ledger.add(attribution), runId,
    toolTimeLeftMs: () => toolTimeEndsAt - input.now() };
  const hosted = createSubagentRunner({
    ...parent,
    // The thread's turns of the parent run itself are on its branch too.
    branchRunIds: [...input.branchRunIds, input.runId],
    buildRegistry: (agentInput) => input.buildRegistry({ ...agentInput, host: registryHost }),
    callTimeLeft: () => toolTimeLeft(),
    deadlineAt,
    deadlineSignal: AbortSignal.timeout(Math.max(0, deadlineAt - input.now())),
    // The main agent's answer may have ended: the turn's Workspace rows stay its own.
    onWorkspaceLifecycle: async () => undefined,
    recordDetachedCompaction: (record) => parts.recordDetachedCompaction(runId, record),
    request: backgroundSubagentRequest(parent.request, runId),
    saveResult: parts.saveResult(runId),
    settleTurn: async () => true,
    settleUsage: async () => { await ledger.settle(); },
    signal: turn.signal,
    threadRunIds: parts.threadRunIds,
    toolState: { calls: 0 },
    toolTimeLeft,
    usage: (attribution) => ledger.add(attribution),
    userFollowups: async () => []
  });
  const ended = async () => {
    await ledger.settle();
    await live?.end("run_finished").catch(() => undefined);
  };
  const begin = async (kind: "continue" | "start") => {
    const handle = kind === "start" ? await hosted.start(turn) : await hosted.continue(turn);
    void hosted.wait(handle).then(ended, ended);
    return handle;
  };
  return {
    start: () => begin("start"),
    continue: () => begin("continue"),
    wait: (handle, signal) => hosted.wait(handle, signal),
    deliver: (handle, message) => hosted.deliver(handle, message),
    stop: (handle, reason) => hosted.stop(handle, reason)
  };
}

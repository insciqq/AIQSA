import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { ArtifactService } from "../artifacts/service";
import type { ImageGenerationService } from "../images/service";
import { mcpFindToolsTool } from "../mcp/discovery";
import { executeDurableMcpDiscovery } from "../mcp/durableDiscovery";
import type { McpRunPlanBinding, McpRunPlanResult, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { McpToolAccessFilter } from "../mcp/toolAccess";
import { mcpDispatchError } from "../mcp/dispatchStatus";
import { dispatchMcpTool, mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool, type McpToolRuntimeCall } from "../mcp/toolExecutor";
import type { McpApprovalRequest } from "../mcp/writeApproval";
import { memorySearchTool } from "../memory/search/contract";
import type { MemorySearchService } from "../memory/search/runtime";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { ProviderRunRequest } from "../providers/types";
import { mcpApprovalRequestForCall } from "../runs/mcpApprovalGate";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { toolRunBudgetsForRequest } from "../runs/toolBudgets";
import { createSearchPlanToolRouter, searchExecutionsFromToolResult, searchUsageAttribution } from "../search/toolExecutor";
import type { SkillToolService } from "../skills/toolService";
import { deliverSkillWorkspaceBundle } from "../skills/workspaceDelivery";
import { memorySearchActivityEvent, skillToolActivityFacts, toolActivityDescriptors } from "../tools/activityDescriptors";
import { ANALYZE_IMAGE_TOOL_NAME, analyzeImageTools } from "../tools/analyzeImage";
import { artifactTool, readArtifactTool } from "../tools/artifact";
import { checkpointOutputsToolForRequest } from "../tools/checkpointOutputs";
import { createFetchUrlSession, type FetchUrlSessionDeps } from "../tools/fetchUrl";
import { FETCH_URL_TOOL_NAME, fetchUrlActivityFacts, fetchUrlToolsForRequest, isFetchUrlPlan } from "../tools/fetchUrlPlan";
import { imageGenerationTool } from "../tools/imageGeneration";
import type { liveToolCallStatus } from "../runs/liveToolStatus";
import { executeCreateScheduledTask, isScheduledTaskCreateCall, scheduledTaskToolsForRequest } from "../tools/scheduledTaskCreation";
import {
  executeManageScheduledTask,
  isScheduledTaskManageCall,
  scheduledTaskManagementToolsForRequest
} from "../tools/scheduledTaskManagement";
import { acceptsSkillTool, skillToolsForRequest } from "../tools/skill";
import { executeSaveSkill, isSkillSaveCall, runSkillSaveCommitter, skillSaveToolsForRequest } from "../tools/skillSave";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import type { ToolObservationSource } from "../toolObservations/contract";
import type { VisionAnalysisService } from "../vision/service";
import { defaultWorkspaceCheckpoints } from "../workspace/checkpoints";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { defaultSkillSaveWorkspaceReader } from "../workspace/skillSaveCapture";
import { workspaceToolNameFromNamespaced } from "../workspace/toolCatalog";
import { executeReadToolResult, readToolResultTool, type SavedToolResultReader } from "./toolResults";

/**
 * The native engine's one tool registry, built once at the start of a run
 * from the tools its admission froze and the existing executors. Every tool
 * declares its effects:
 * - `none`: it only reads (a transient failure is retried, an identical
 *   repeat may be blocked);
 * - `local`: it changes the user's own AIQSA state through its owner's
 *   service, which settles the call itself;
 * - `external`: it may act outside (an MCP tool not annotated read-only, a
 *   Workspace command, a paid generation) and is never sent twice.
 * A tool that needs its initiator's approval says so per call. Workspace tools
 * are always registered when the run has a Workspace; the VM starts at the
 * first call that needs it. Discovery (`find_tools`) adds MCP tools to the
 * registry for the run's later requests.
 */
export type EngineToolEffects = "external" | "local" | "none";

export type EngineToolActivity = NonNullable<Parameters<typeof liveToolCallStatus>[1]>;

export type EngineToolExecution = Readonly<{
  call: ModelToolCall;
  /** The call's place in its round. */
  ordinal: number;
  /** The call's `ModelRunToolCall` row. */
  persistedToolCallId: string;
  round: number;
  signal: AbortSignal;
}>;

export type EngineToolLinks = Readonly<{ mcpRunBindingId?: string; workspaceRunBindingId?: string }>;

export type EngineTool = Readonly<{
  activity(call: ModelToolCall): EngineToolActivity;
  /** The initiator's approval this call needs before it is sent. */
  approval?(call: ModelToolCall): McpApprovalRequest | undefined;
  definition: RunTool;
  effects: EngineToolEffects;
  execute(execution: EngineToolExecution): Promise<ToolExecutionResult>;
  /** The rows the call's record links; null when the binding it needs is gone. */
  links?(call: ModelToolCall): EngineToolLinks | null;
  /** The store a long result is saved in. */
  observationSource: ToolObservationSource;
  /** The call's own records after it ran (Search rows and their usage). */
  settled?(execution: EngineToolExecution, result: ToolExecutionResult): Promise<void>;
}>;

export type ToolRegistry = Readonly<{
  definitions(): readonly RunTool[];
  resolve(name: string): EngineTool | undefined;
}>;

/** One accepted MCP runtime of the run: the generation its calls use and their binding row. */
export type EngineMcpBinding = Readonly<{ fingerprint: string; mcpRunBindingId: string; runtimeGenerationId: string }>;

export type ToolRegistryServices = Readonly<{
  artifacts?: Pick<ArtifactService, "execute">;
  /** Test seams of the page reader; production uses the pinned SSRF-safe transport and the parser process. */
  extractPage?: FetchUrlSessionDeps["extractPage"];
  fetchPage?: FetchUrlSessionDeps["fetchPage"];
  images?: Pick<ImageGenerationService, "execute">;
  mcp?: Readonly<{
    filterTools: McpToolAccessFilter;
    materialize?(userId: string, tools: readonly Readonly<{ namespacedName: string; revisionId: string; serverId: string }>[]):
      Promise<McpRunPlanResult>;
  }>;
  /** The MCP runtime of this process (`getDefaultMcpRuntimeCoordinator`). */
  mcpRuntime?: () => Readonly<{ callTool: McpToolRuntimeCall; ensureAcceptedGeneration(generationId: string): Promise<boolean> }>;
  memorySearch?: Pick<MemorySearchService, "execute">;
  repository: Pick<RunRepository, "appendMcpDiscoveryEpoch" | "createScheduledTaskForCall" | "createSearchRun" |
    "loadRunFetchUrlCalls" | "loadRunSearchSourceUrls" | "manageScheduledTaskForCall" | "saveSkillForCall">;
  savedResults: SavedToolResultReader;
  searchRuntimes?: Readonly<Record<string, ProviderRuntimeBinding>>;
  skillTools?: Pick<SkillToolService, "execute">;
  vision?: Pick<VisionAnalysisService, "execute">;
  workspace?: WorkspaceCoordinator;
}>;

export type ToolRegistryInput = Readonly<{
  chatId: string;
  /** Text the user sent into this running answer (`fetch_url` link authority). */
  followupTexts(): readonly string[];
  /** The run's accepted MCP runtimes, by server; discovery adds to it. */
  mcpBindings: Map<string, EngineMcpBinding>;
  /** Loads the binding rows discovery just accepted. */
  loadMcpBindings?(): Promise<ReadonlyMap<string, EngineMcpBinding>>;
  onEvent(event: ModelRunSseEvent): Promise<void>;
  onUsage(attribution: RunUsageAttribution): void;
  onWorkspaceActivity(entry: ThreadWorkspaceActivityEntry): Promise<void>;
  /** The run's request as admission froze it; executors read their frozen plans from it. */
  request: ProviderRunRequest;
  runId: string;
  services: ToolRegistryServices;
  userId: string;
}>;

function unavailable(call: ModelToolCall, code: string): ToolExecutionResult {
  return { callId: call.id, content: [{ type: "json", value: { error: code } }], name: call.name, status: "error" };
}

/** Builds the registry of one run. */
export async function buildToolRegistry(input: ToolRegistryInput): Promise<ToolRegistry> {
  const request = input.request;
  const owner = { runId: input.runId, userId: input.userId };
  const context = (execution: EngineToolExecution) => ({
    persistedToolCallId: execution.persistedToolCallId, request, runId: input.runId, userId: input.userId
  });
  const tools = new Map<string, EngineTool>();
  const descriptors = toolActivityDescriptors(request);
  const add = (tool: EngineTool) => {
    if (!tools.has(tool.definition.name)) tools.set(tool.definition.name, tool);
  };
  const named = (definition: RunTool, serverName: string | undefined, extra?: (call: ModelToolCall) => Partial<EngineToolActivity>) =>
    (call: ModelToolCall): EngineToolActivity => ({
      origin: definition.capability,
      ...(serverName ? { serverName } : {}),
      ...(extra ? extra(call) : {})
    });
  const clientTools = request.toolMode !== "none";

  if (clientTools && request.memorySearch && input.services.memorySearch) {
    const definition = memorySearchTool(request.memorySearch);
    const service = input.services.memorySearch;
    add({ activity: named(definition, "Memory"), definition, effects: "none", observationSource: "workspace",
      execute: async (execution) => {
        await input.onEvent(memorySearchActivityEvent({ ordinal: execution.ordinal, round: execution.round, state: "running" }));
        return service.execute(execution.call, context(execution), { signal: execution.signal });
      },
      settled: (execution, result) => input.onEvent(memorySearchActivityEvent({ ordinal: execution.ordinal, result,
        round: execution.round, state: result.status })) });
  }

  for (const definition of skillToolsForRequest(request)) {
    if (!input.services.skillTools || !acceptsSkillTool(request, definition.name)) continue;
    const service = input.services.skillTools;
    add({ activity: named(definition, undefined, (call) => skillToolActivityFacts(request, call.name, call.arguments)),
      definition, effects: "none", observationSource: "workspace",
      execute: async (execution) => {
        const result = await service.execute(execution.call, context(execution));
        // A loaded Skill's bundle reaches the Workspace only if the run has one.
        return deliverSkillWorkspaceBundle({ call: execution.call, coordinator: input.services.workspace, onActivity: input.onWorkspaceActivity,
          request, result, runId: input.runId, signal: execution.signal, userId: input.userId });
      } });
  }

  if (request.workspaceCheckpoints) {
    const definition = checkpointOutputsToolForRequest(request);
    add({ activity: named(definition, "Workspace"), definition, effects: "local", observationSource: "workspace",
      execute: async (execution) => (await defaultWorkspaceCheckpoints()).execute(execution.call, context(execution), execution.signal) });
  }

  for (const definition of analyzeImageTools(request)) {
    if (definition.name !== ANALYZE_IMAGE_TOOL_NAME || !input.services.vision) continue;
    const service = input.services.vision;
    add({ activity: named(definition, "System Vision"), definition, effects: "none", observationSource: "workspace",
      execute: (execution) => service.execute(execution.call, context(execution), execution.signal) });
  }

  if (clientTools && request.imagePlan && input.services.images) {
    const definition = imageGenerationTool(request.imagePlan);
    const service = input.services.images;
    add({ activity: named(definition, "Images"), definition, effects: "external", observationSource: "workspace",
      execute: (execution) => service.execute(execution.call, context(execution), execution.signal) });
  }

  if (clientTools && request.artifactTool && input.services.artifacts) {
    const service = input.services.artifacts;
    const create = artifactTool(request.artifactToolDescription);
    add({ activity: named(create, "Artifacts"), definition: create, effects: "local", observationSource: "workspace",
      execute: (execution) => service.execute(execution.call, context(execution), { signal: execution.signal }) });
    if (request.artifactReferences?.length) {
      const read = readArtifactTool();
      add({ activity: named(read, "Artifacts"), definition: read, effects: "none", observationSource: "workspace",
        execute: (execution) => service.execute(execution.call, context(execution), { signal: execution.signal }) });
    }
  }

  add({ activity: named(readToolResultTool, "Chat context"), definition: readToolResultTool, effects: "none",
    observationSource: "workspace",
    execute: (execution) => executeReadToolResult(execution.call, { chatId: input.chatId, reader: input.services.savedResults,
      signal: execution.signal, userId: input.userId }) });

  const scheduledServer = "Scheduled tasks";
  for (const definition of scheduledTaskToolsForRequest(request)) {
    if (!isScheduledTaskCreateCall(request, definition.name)) continue;
    const create = input.services.repository.createScheduledTaskForCall?.bind(input.services.repository);
    add({ activity: named(definition, scheduledServer), definition, effects: "local", observationSource: "workspace",
      execute: (execution) => executeCreateScheduledTask(execution.call, context(execution), create) });
  }
  for (const definition of scheduledTaskManagementToolsForRequest(request)) {
    if (!isScheduledTaskManageCall(request, definition.name)) continue;
    const manage = input.services.repository.manageScheduledTaskForCall?.bind(input.services.repository);
    add({ activity: named(definition, scheduledServer), definition, effects: "local", observationSource: "workspace",
      execute: (execution) => executeManageScheduledTask(execution.call, context(execution), manage) });
  }
  for (const definition of skillSaveToolsForRequest(request)) {
    if (!isSkillSaveCall(request, definition.name)) continue;
    add({ activity: named(definition, "Skills"), definition, effects: "local", observationSource: "workspace",
      execute: (execution) => executeSaveSkill(execution.call, context(execution), {
        commit: runSkillSaveCommitter(input.services.repository, { callId: execution.persistedToolCallId, ...owner }),
        reader: defaultSkillSaveWorkspaceReader, signal: execution.signal
      }) });
  }

  const fetchPlan = isFetchUrlPlan(request.fetchUrl) ? request.fetchUrl : null;
  if (fetchPlan) {
    const repository = input.services.repository;
    const session = createFetchUrlSession({
      followupTexts: input.followupTexts,
      plan: fetchPlan,
      scheduled: fetchPlan.taskUrlDigests !== undefined,
      searchAvailable: request.searchPlan.options.length > 0,
      ...(input.services.fetchPage ? { fetchPage: input.services.fetchPage } : {}),
      ...(input.services.extractPage ? { extractPage: input.services.extractPage } : {}),
      ...(repository.loadRunSearchSourceUrls ? { loadSearchUrls: () => repository.loadRunSearchSourceUrls!(owner) } : {}),
      ...(repository.loadRunFetchUrlCalls ? { loadCalls: () => repository.loadRunFetchUrlCalls!(owner) } : {})
    });
    for (const definition of fetchUrlToolsForRequest(request)) {
      if (definition.name !== FETCH_URL_TOOL_NAME) continue;
      add({ activity: named(definition, "Web", (call) => fetchUrlActivityFacts(call.name, call.arguments)), definition,
        effects: "none", observationSource: "workspace",
        execute: (execution) => session.execute(execution.call, { persistedToolCallId: execution.persistedToolCallId,
          signal: execution.signal }) });
    }
  }

  const router = clientTools ? createSearchPlanToolRouter({ plan: request.searchPlan, runtimes: input.services.searchRuntimes ?? {} }) : null;
  for (const definition of router?.tools ?? []) {
    add({ activity: named(definition, "Web search", () => descriptors.get(definition.name) ?? {}), definition, effects: "none",
      observationSource: "search",
      execute: (execution) => router!.execute(execution.call, request, { signal: execution.signal }),
      settled: async (_execution, result) => {
        // Each engine call keeps its sources (page-reader authority, counts)
        // and its usage; a failed one keeps its reported usage too.
        for (const executed of searchExecutionsFromToolResult(result)) {
          if (executed.usage) input.onUsage(searchUsageAttribution(executed));
          await input.services.repository.createSearchRun({
            artifacts: { sources: executed.sources }, invocationId: executed.invocationId, modelId: executed.modelId,
            modelRunId: input.runId, provider: executed.provider, searchRevisionId: executed.revisionId,
            status: executed.status, strategyId: executed.optionId
          });
        }
      } });
  }

  if (clientTools) addMcpTools(input, add, tools);

  if (request.workspace && input.services.workspace) {
    const workspace = request.workspace;
    const coordinator = input.services.workspace;
    for (const definition of await coordinator.tools({ runId: input.runId, userId: input.userId, workspace })) {
      if (!coordinator.accepts({ name: definition.name, workspace })) continue;
      add({ activity: () => ({ origin: definition.capability, serverName: "Workspace",
        toolName: workspaceToolNameFromNamespaced(definition.name) ?? definition.name }),
        definition, effects: "external", links: () => ({ workspaceRunBindingId: input.runId }), observationSource: "workspace",
        execute: (execution) => coordinator.execute({ call: execution.call, modelRunToolCallId: execution.persistedToolCallId,
          onActivity: input.onWorkspaceActivity, runId: input.runId, signal: execution.signal, userId: input.userId, workspace }) });
    }
  }

  return {
    definitions: () => [...tools.values()].map((tool) => tool.definition),
    resolve: (name) => tools.get(name)
  };
}

/** MCP tools of the admitted snapshot, and `find_tools` adding more under Auto. */
function addMcpTools(input: ToolRegistryInput, add: (tool: EngineTool) => void, tools: Map<string, EngineTool>): void {
  const request = input.request;
  let snapshot: McpRunPlanSnapshot | undefined = request.mcp;
  let discovery = request.mcpDiscovery;
  const runtime = input.services.mcpRuntime;

  const addTool = (definition: RunTool) => {
    const route = () => resolveMcpRunTool(snapshot, definition.name);
    const readOnly = (() => {
      const annotations = route()?.tool.annotations;
      return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
    })();
    add({
      activity: () => {
        const current = route();
        return { origin: "mcp", ...(current ? { serverName: current.tool.serverName, toolName: current.originalName } : {}) };
      },
      approval: (call) => mcpApprovalRequestForCall({ admission: request.mcpApproval, call, snapshot }),
      definition,
      effects: readOnly ? "none" : "external",
      links: () => {
        const current = route();
        const binding = current ? input.mcpBindings.get(current.serverId) : undefined;
        return current && binding && binding.fingerprint === current.fingerprint ? { mcpRunBindingId: binding.mcpRunBindingId } : null;
      },
      observationSource: "mcp",
      execute: async (execution) => {
        const current = route();
        const binding = current ? input.mcpBindings.get(current.serverId) : undefined;
        if (!current || !binding || !runtime) return unavailable(execution.call, "mcp_run_binding_unavailable");
        const raw = await dispatchMcpTool({
          arguments: execution.call.arguments,
          // Entitlement was checked at admission. The accepted runtime is
          // started on demand, and it refuses a definition that changed since.
          assertCurrent: async () => {
            if (!await runtime().ensureAcceptedGeneration(binding.runtimeGenerationId)) throw mcpDispatchError("mcp_runtime_unavailable");
          },
          callTool: (call) => runtime().callTool(call),
          generationId: binding.runtimeGenerationId,
          route: current,
          signal: execution.signal
        });
        return mcpToolExecutionResult(execution.call, raw);
      }
    });
  };
  for (const definition of mcpRunTools(snapshot)) addTool(definition);

  const materialize = input.services.mcp?.materialize;
  const appendEpoch = input.services.repository.appendMcpDiscoveryEpoch;
  if (!discovery || !materialize || !appendEpoch || !input.services.mcp) return;
  const filterTools = input.services.mcp.filterTools;
  const budgets = toolRunBudgetsForRequest(request);
  let queue: Promise<unknown> = Promise.resolve();
  add({
    activity: () => ({ origin: "discovery", serverName: "Auto tools" }),
    definition: mcpFindToolsTool,
    effects: "none",
    observationSource: "mcp",
    execute: (execution) => {
      // Discovery calls of one batch run one after another: each epoch builds on the last.
      const run = async (): Promise<ToolExecutionResult> => {
        if (!discovery) return unavailable(execution.call, "mcp_discovery_not_available");
        const executed = await executeDurableMcpDiscovery({
          activeDiscovery: discovery,
          ...(snapshot ? { activeSnapshot: snapshot } : {}),
          appendEpoch: appendEpoch.bind(input.services.repository),
          call: execution.call,
          filterTools,
          materialize,
          maxResults: budgets.maxMcpToolsPerDiscovery,
          modelRunToolCallId: execution.persistedToolCallId,
          roundIndex: execution.round,
          runId: input.runId,
          signal: execution.signal,
          userId: input.userId
        });
        snapshot = executed.snapshot;
        discovery = executed.discovery;
        // The accepted bindings of newly loaded servers, then their tools.
        if (input.loadMcpBindings) {
          for (const [serverId, binding] of await input.loadMcpBindings()) input.mcpBindings.set(serverId, binding);
        }
        for (const definition of mcpRunTools(snapshot)) if (!tools.has(definition.name)) addTool(definition);
        return executed.toolResult;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    }
  });
}

/** The accepted bindings of a run, by server, from its `McpRunBinding` rows. */
export function engineMcpBindings(
  bindings: readonly McpRunPlanBinding[],
  rows: readonly Readonly<{ id: string; runtimeGenerationFingerprint: string; runtimeGenerationId: string | null }>[]
): Map<string, EngineMcpBinding> {
  const byFingerprint = new Map(rows.flatMap((row) => row.runtimeGenerationId
    ? [[row.runtimeGenerationFingerprint, { id: row.id, runtimeGenerationId: row.runtimeGenerationId }] as const] : []));
  const result = new Map<string, EngineMcpBinding>();
  for (const binding of bindings) {
    const row = byFingerprint.get(binding.fingerprint);
    if (row && row.runtimeGenerationId === binding.runtimeGenerationId) {
      result.set(binding.serverId, { fingerprint: binding.fingerprint, mcpRunBindingId: row.id,
        runtimeGenerationId: binding.runtimeGenerationId });
    }
  }
  return result;
}

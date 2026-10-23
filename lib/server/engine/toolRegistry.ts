import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ThreadWorkspaceActivityEntry, WorkspaceActivityKind } from "../../contracts/workspace";
import type { ArtifactService } from "../artifacts/service";
import type { ImageGenerationService } from "../images/service";
import { MCP_FIND_TOOLS_NAME, mcpFindToolsTool } from "../mcp/discovery";
import { executeDurableMcpDiscovery } from "../mcp/durableDiscovery";
import type { McpRunPlanBinding, McpRunPlanResult, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { McpToolAccessFilter } from "../mcp/toolAccess";
import { mcpDispatchError } from "../mcp/dispatchStatus";
import { dispatchMcpTool, mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool, type McpToolRuntimeCall } from "../mcp/toolExecutor";
import { mcpApprovalRequest, type McpApprovalRequest } from "../mcp/writeApproval";
import { memorySearchTool } from "../memory/search/contract";
import type { MemorySearchService } from "../memory/search/runtime";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { ProviderRunRequest } from "../providers/types";
import { mcpApprovalRequestForCall } from "../runs/mcpApprovalGate";
import { attachmentIdsFromContentBlocks } from "../runs/runAttachmentMaterialization";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { toolRunBudgetsForRequest } from "../runs/toolBudgets";
import { createSearchPlanToolRouter, searchExecutionsFromToolResult, searchUsageAttribution } from "../search/toolExecutor";
import type { SkillToolService } from "../skills/toolService";
import { deliverSkillWorkspaceBundle } from "../skills/workspaceDelivery";
import { memorySearchActivityEvent, skillToolActivityFacts, toolActivityDescriptors } from "../tools/activityDescriptors";
import { ANALYZE_IMAGE_TOOL_NAME, analyzeImageTools } from "../tools/analyzeImage";
import {
  APPLY_PATCH_TOOL_NAME,
  APPLY_PATCH_WORKSPACE_TOOLS,
  applyPatchTool,
  executeApplyPatch,
  workspaceApplyPatchFiles,
  type WorkspaceToolCaller
} from "../tools/applyPatch";
import { answerReviewToolsForRequest, executeAnswerReviewCall } from "../tools/answerReview";
import { artifactTool, readArtifactTool } from "../tools/artifact";
import { checkpointOutputsToolForRequest } from "../tools/checkpointOutputs";
import { createFetchUrlSession, type FetchUrlSessionDeps } from "../tools/fetchUrl";
import { FETCH_URL_TOOL_NAME, fetchUrlActivityFacts, fetchUrlToolsForRequest, isFetchUrlPlan } from "../tools/fetchUrlPlan";
import { patchActivityChanges, patchActivityEntry, planActivityEntry } from "../tools/harnessActivity";
import type { HarnessToolEffects } from "../tools/harnessTool";
import { imageGenerationTool } from "../tools/imageGeneration";
import { executeMonitoringVerdict, monitoringVerdictTool } from "../tools/monitoringVerdict";
import { executeReadSecret, readSecretTool } from "../tools/readSecret";
import type { liveToolCallStatus } from "../runs/liveToolStatus";
import { executeCreateScheduledTask, isScheduledTaskCreateCall, scheduledTaskToolsForRequest } from "../tools/scheduledTaskCreation";
import {
  executeManageScheduledTask,
  isScheduledTaskManageCall,
  scheduledTaskManagementToolsForRequest
} from "../tools/scheduledTaskManagement";
import { MANAGE_SKILL_TOOL_NAME } from "../tools/manageSkill";
import {
  SELF_SERVICE_TOOLS,
  createToolCallSelfServiceStore,
  executeSelfServiceTool,
  type SelfServiceRunDeps
} from "../tools/selfServiceTools";
import { acceptsSkillTool, skillToolsForRequest } from "../tools/skill";
import { SAVE_SKILL_TOOL_NAME, executeSaveSkill, isSkillSaveCall, runSkillSaveCommitter, skillSaveToolsForRequest } from "../tools/skillSave";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { executeUpdatePlan, parsePlanUpdate, updatePlanTool } from "../tools/updatePlan";
import type { ToolObservationSource } from "../toolObservations/contract";
import type { VisionAnalysisService } from "../vision/service";
import { defaultWorkspaceCheckpoints } from "../workspace/checkpoints";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { defaultSkillSaveWorkspaceReader } from "../workspace/skillSaveCapture";
import { namespacedWorkspaceToolName, workspaceToolNameFromNamespaced } from "../workspace/toolCatalog";
import { executeReadToolResult, readToolResultTool, type SavedToolResultReader } from "./toolResults";

/**
 * The native engine's one tool registry, built once at the start of a run
 * from the tools its admission froze and the existing executors. Every tool
 * declares its effects in one vocabulary (`HarnessToolEffects`): `none` only
 * reads, `local` changes the user's own AIQSA state or this chat's Workspace
 * files and is never tried again, `external` may act outside and is never
 * sent twice. A tool that needs its initiator's approval says so per call.
 * Workspace tools are always registered when the run has a Workspace; the VM
 * starts at the first call that needs it. Discovery (`find_tools`) adds MCP
 * tools to the registry for the run's later requests. The harness tools
 * (`HARNESS_TOOLS`) ride on every request that offers tools, and the
 * self-service tools (`SELF_SERVICE_TOOLS`) on those of interactive personal
 * and temporary chats, whose handler gives their owners. A monitoring
 * check's verdict and an answer review step's report are the run's reserved
 * report (`toolBatch.ts`, `loop.ts`).
 */
export type EngineToolEffects = HarnessToolEffects;

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
  /**
   * The result is disclosed only within the run that produced it: it is never
   * saved for a later read (its own budget bounds it, so it stays whole) and
   * the transcript keeps a note in its place, so a later turn searches again
   * and the source's authority is rechecked (Memory, `agent_docs/MEMORY.md`).
   */
  runScopedResult?: true;
  /**
   * The approval request of exactly this call, whatever standing consent the
   * initiator gave: the card in which the user decides whether a call whose
   * earlier equivalent has an unknown outcome is sent again (MCP tools).
   */
  retryApproval?(call: ModelToolCall): McpApprovalRequest | undefined;
  /** The call's own records after it ran (Search rows and their usage). */
  settled?(execution: EngineToolExecution, result: ToolExecutionResult): Promise<void>;
}>;

export type ToolRegistry = Readonly<{
  definitions(): readonly RunTool[];
  /**
   * For a call of an older tool this run does not offer because a newer one
   * replaces it (a name the model may know from a Workspace guide or an
   * earlier turn), what to call instead: the refusal the model reads.
   */
  replacement?(name: string): string | undefined;
  /**
   * The `find_tools` call, with provider call `id`, that loads the MCP tool
   * `name` from the run's frozen Auto catalog: how the server loads an
   * approved call's tool into a run that admitted none. Undefined without a
   * catalog or when the catalog lacks the tool.
   */
  mcpLoadCall?(name: string, id: string): ModelToolCall | undefined;
  resolve(name: string): EngineTool | undefined;
}>;

/**
 * Older tools a newer one of this registry replaces, and how to do the same
 * with it. The old core keeps offering them; a native run offers only the
 * newer one, so the model never chooses between two ways of doing one thing.
 */
const SUPERSEDED_TOOLS: ReadonlyMap<string, Readonly<{ by: string; how: string }>> = new Map([
  [SAVE_SKILL_TOOL_NAME, { by: MANAGE_SKILL_TOOL_NAME, how: "action \"save\", target \"new\" or the Skill's alias, and files with each " +
    "file's path and text content, SKILL.md first. For a folder built in the Workspace, read its files and pass them" }]
]);

/** One accepted MCP runtime of the run: the generation its calls use and their binding row. */
export type EngineMcpBinding = Readonly<{ fingerprint: string; mcpRunBindingId: string; runtimeGenerationId: string }>;

/** One `McpRunBinding` row of the run: an accepted runtime generation, by its fingerprint. */
export type EngineMcpBindingRow = Readonly<{ id: string; runtimeGenerationFingerprint: string; runtimeGenerationId: string | null }>;

export type ToolRegistryServices = Readonly<{
  artifacts?: Pick<ArtifactService, "execute">;
  /** Test seams of the page reader; production uses the pinned SSRF-safe transport and the parser process. */
  extractPage?: FetchUrlSessionDeps["extractPage"];
  fetchPage?: FetchUrlSessionDeps["fetchPage"];
  images?: Pick<ImageGenerationService, "execute" | "withConversationPixels">;
  mcp?: Readonly<{
    filterTools: McpToolAccessFilter;
    materialize?(userId: string, tools: readonly Readonly<{ namespacedName: string; revisionId: string; serverId: string }>[]):
      Promise<McpRunPlanResult>;
  }>;
  /** The MCP runtime of this process (`getDefaultMcpRuntimeCoordinator`). */
  mcpRuntime?: () => Readonly<{ callTool: McpToolRuntimeCall; ensureAcceptedGeneration(generationId: string): Promise<boolean> }>;
  memorySearch?: Pick<MemorySearchService, "execute">;
  repository: Pick<RunRepository, "appendMcpDiscoveryEpoch" | "createScheduledTaskForCall" | "createSearchRun" |
    "loadRunFetchUrlCalls" | "loadRunSearchSourceUrls" | "manageScheduledTaskForCall" | "recordMonitoringVerdict" | "saveSkillForCall">;
  savedResults: SavedToolResultReader;
  searchRuntimes?: Readonly<Record<string, ProviderRuntimeBinding>>;
  /** The saved secrets `read_secret` reads (`createRunSecretSource`), with or without a Workspace. */
  secrets?: RunSecretSource;
  /**
   * The owners behind the self-service tools, given only for interactive
   * personal and temporary chats (`nativeRunResponse`); the registry adds
   * the run's own facts. They need `secrets` too, for the Skill save guard.
   */
  selfService?: Pick<SelfServiceRunDeps, "assistants" | "db" | "storage">;
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
  /**
   * The run's `McpRunBinding` rows, read after every discovery epoch: the
   * epoch writes the rows of the servers it loaded (Auto admits none).
   */
  loadMcpBindingRows?(): Promise<readonly EngineMcpBindingRow[]>;
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

/** Workspace lifecycle rows (the VM starting, staging, retiring), which every Workspace call reports as it goes. */
const WORKSPACE_LIFECYCLE_KINDS: ReadonlySet<WorkspaceActivityKind> = new Set<WorkspaceActivityKind>([
  "attachments_prepare", "execution_status", "outputs_export", "workspace_recreated", "workspace_start", "workspace_stopped"
]);

/** Conversation files the self-service tools may read: those of the run's frozen branch and its own message. */
const ADMITTED_ATTACHMENTS_LIMIT = 256;

function admittedAttachmentIds(request: ProviderRunRequest): string[] {
  const ids = new Set<string>();
  const add = (blocks: readonly unknown[]) => {
    try {
      for (const id of attachmentIdsFromContentBlocks(blocks)) ids.add(id);
    } catch {
      // Admission bounded and checked these blocks; a block it could not read references nothing.
    }
  };
  for (const message of request.context?.messages ?? []) {
    if (message.purpose === undefined) add(message.content.blocks);
  }
  add(request.content.blocks);
  for (const id of request.attachmentIds) ids.add(id);
  return [...ids].slice(-ADMITTED_ATTACHMENTS_LIMIT);
}

/** A call refused before it was sent (a stale runtime, invalid arguments): its outcome is known, nothing happened. */
function notSent(call: ModelToolCall, error: unknown): ToolExecutionResult {
  const own = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const code = typeof own === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(own) ? own : "mcp_call_not_sent";
  return { callId: call.id, content: [{ type: "json", value: { error: code, message: "Nothing was sent." } }], name: call.name,
    status: "error" };
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
    add({ activity: named(definition, "Memory"), definition, effects: "none", observationSource: "workspace", runScopedResult: true,
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

  // The harness tools of every chat that offers tools, none of which needs the VM: the plan
  // the user sees as progress, and the user's saved secrets.
  const listed = (name: string) => (): EngineToolActivity => descriptors.get(name) ?? {};
  if (clientTools) {
    add({ activity: listed(updatePlanTool.name), definition: updatePlanTool.tool, effects: updatePlanTool.effects,
      observationSource: "workspace",
      execute: async (execution) => {
        const result = executeUpdatePlan(execution.call);
        const parsed = result.status === "complete" ? parsePlanUpdate(execution.call.arguments) : null;
        const entry = parsed?.ok ? planActivityEntry({ callId: execution.persistedToolCallId, runId: input.runId, update: parsed.update })
          : null;
        if (entry) await input.onWorkspaceActivity(entry);
        return result;
      } });
  }
  const secrets = input.services.secrets;
  if (clientTools && secrets) {
    add({ activity: listed(readSecretTool.name), definition: readSecretTool.tool, effects: readSecretTool.effects,
      observationSource: "workspace",
      execute: (execution) => executeReadSecret(secrets, execution.call, owner, { signal: execution.signal }) });
  }

  // The self-service tools: the user's own resources through their owners, each call settled
  // with its change and card in one transaction, which fences the run once more.
  const selfService = input.services.selfService;
  const selfServiceOffered = clientTools && selfService !== undefined && secrets !== undefined &&
    !request.answerReviewStep && !request.monitoringVerdictTool;
  if (selfServiceOffered && selfService && secrets) {
    const deps: SelfServiceRunDeps = { ...selfService, attachmentIds: admittedAttachmentIds(request), request: { skills: request.skills },
      run: { chatId: input.chatId, runId: input.runId, userId: input.userId }, secretSource: secrets };
    for (const descriptor of SELF_SERVICE_TOOLS) {
      add({ activity: listed(descriptor.name), definition: descriptor.tool, effects: descriptor.effects, observationSource: "workspace",
        execute: async (execution) => await executeSelfServiceTool(deps, execution.call, {
          callId: execution.persistedToolCallId, signal: execution.signal,
          store: createToolCallSelfServiceStore({ callId: execution.persistedToolCallId, runId: input.runId, toolName: execution.call.name,
            userId: input.userId })
        }) ?? unavailable(execution.call, "tool_unavailable") });
    }
  }

  // The run's one reserved report, frozen from its server-only admission and never from a request
  // field (`reservedToolCallForRequest`): a monitoring check's verdict, which only its own running
  // occurrence takes, or an answer review step's review or decisions, whose card is the record.
  if (request.monitoringVerdictTool === true) {
    const record = input.services.repository.recordMonitoringVerdict?.bind(input.services.repository);
    add({ activity: named(monitoringVerdictTool, "Monitoring"), definition: monitoringVerdictTool, effects: "local",
      observationSource: "workspace", execute: (execution) => executeMonitoringVerdict(execution.call, owner, record) });
  }
  // A step reports once: the first call that settles its card wins, a later one is refused.
  let reviewReported = false;
  for (const definition of answerReviewToolsForRequest(request)) {
    add({ activity: named(definition, "Answer review"), definition, effects: "local", observationSource: "workspace",
      execute: async (execution) => {
        const result = executeAnswerReviewCall(execution.call, request, { submitted: reviewReported });
        if (result.status === "complete") reviewReported = true;
        return result;
      } });
  }

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
    // `manage_skill` saves Skills in any chat and supersedes the Workspace folder save (`SUPERSEDED_TOOLS`).
    if (!isSkillSaveCall(request, definition.name) || selfServiceOffered) continue;
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

  const mcpLoadCall = clientTools ? addMcpTools(input, add, tools) : undefined;

  if (clientTools && request.workspace && input.services.workspace) {
    const workspace = request.workspace;
    const coordinator = input.services.workspace;
    const workspaceTools = await coordinator.tools({ runId: input.runId, userId: input.userId, workspace });
    for (const definition of workspaceTools) {
      if (!coordinator.accepts({ name: definition.name, workspace })) continue;
      add({ activity: () => ({ origin: definition.capability, serverName: "Workspace",
        toolName: workspaceToolNameFromNamespaced(definition.name) ?? definition.name }),
        definition, effects: "external", links: () => ({ workspaceRunBindingId: input.runId }), observationSource: "workspace",
        execute: (execution) => coordinator.execute({ call: execution.call, modelRunToolCallId: execution.persistedToolCallId,
          onActivity: input.onWorkspaceActivity, runId: input.runId, signal: execution.signal, userId: input.userId, workspace }) });
    }
    const offered = new Set(workspaceTools.map((definition) => definition.name));
    if (APPLY_PATCH_WORKSPACE_TOOLS.every((name) => offered.has(namespacedWorkspaceToolName(name)) &&
      coordinator.accepts({ name: namespacedWorkspaceToolName(name), workspace }))) {
      add(applyPatchEngineTool(input, coordinator, workspace));
    }
  }

  return {
    definitions: () => [...tools.values()].map((tool) => tool.definition),
    ...(mcpLoadCall ? { mcpLoadCall } : {}),
    replacement: (name) => {
      const superseded = SUPERSEDED_TOOLS.get(name);
      return superseded && tools.has(superseded.by) && !tools.has(name)
        ? `${name} is not available in this chat, so nothing was executed. Use ${superseded.by} instead: ${superseded.how}.`
        : undefined;
    },
    resolve: (name) => tools.get(name)
  };
}

/**
 * `apply_patch` over the Workspace: each file step (exists, read, write,
 * remove, mkdir) is a Workspace call on the patch's own record, which starts
 * the VM like any other Workspace tool. Of those steps only the VM's
 * lifecycle reaches the thread; the patch shows as one row of its files.
 */
function applyPatchEngineTool(input: ToolRegistryInput, coordinator: WorkspaceCoordinator,
  workspace: NonNullable<ProviderRunRequest["workspace"]>): EngineTool {
  const lifecycle = async (entry: ThreadWorkspaceActivityEntry) => {
    if (WORKSPACE_LIFECYCLE_KINDS.has(entry.kind)) await input.onWorkspaceActivity(entry);
  };
  return {
    activity: () => ({ origin: "workspace", serverName: "Workspace", toolName: APPLY_PATCH_TOOL_NAME }),
    definition: applyPatchTool.tool,
    effects: applyPatchTool.effects,
    links: () => ({ workspaceRunBindingId: input.runId }),
    observationSource: "workspace",
    execute: async (execution) => {
      const call: WorkspaceToolCaller = (name, args, signal) => coordinator.execute({
        call: { arguments: args, id: execution.call.id, name: namespacedWorkspaceToolName(name) },
        modelRunToolCallId: execution.persistedToolCallId, onActivity: lifecycle, runId: input.runId,
        signal: signal ?? execution.signal, userId: input.userId, workspace
      });
      const changes = patchActivityChanges(execution.call.arguments);
      const startedAt = new Date();
      const row = async (phase: "cancelled" | "failed" | "running" | "succeeded") => {
        if (changes.length === 0) return;
        await input.onWorkspaceActivity(patchActivityEntry({ callId: execution.persistedToolCallId, changes,
          ...(phase === "running" ? {} : { durationMs: Date.now() - startedAt.getTime() }), phase, startedAt }));
      };
      await row("running");
      try {
        const result = await executeApplyPatch(workspaceApplyPatchFiles(call), execution.call, { signal: execution.signal });
        await row(result.status === "complete" ? "succeeded" : "failed");
        return result;
      } catch (error) {
        await row(execution.signal.aborted ? "cancelled" : "failed").catch(() => undefined);
        throw error;
      }
    }
  };
}

/**
 * MCP tools of the admitted snapshot, and `find_tools` adding more under Auto;
 * under Auto, also the server's own `find_tools` call for one catalog tool
 * (`ToolRegistry.mcpLoadCall`).
 */
function addMcpTools(input: ToolRegistryInput, add: (tool: EngineTool) => void,
  tools: Map<string, EngineTool>): ToolRegistry["mcpLoadCall"] {
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
      retryApproval: (call) => {
        const current = request.mcpApproval ? route() : null;
        if (!current) return undefined;
        const annotatedTitle = typeof current.tool.annotations?.title === "string" ? current.tool.annotations.title : undefined;
        return mcpApprovalRequest({ arguments: call.arguments, definitionHash: current.tool.definitionHash,
          originalName: current.originalName, serverId: current.serverId, serverName: current.tool.serverName,
          title: current.tool.title ?? annotatedTitle, toolName: call.name });
      },
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
        let dispatched = false;
        try {
          const raw = await dispatchMcpTool({
            arguments: execution.call.arguments,
            // Entitlement was checked at admission. The accepted runtime is
            // started on demand, and it refuses a definition that changed since.
            assertCurrent: async () => {
              if (!await runtime().ensureAcceptedGeneration(binding.runtimeGenerationId)) throw mcpDispatchError("mcp_runtime_unavailable");
            },
            callTool: (call) => runtime().callTool(call),
            generationId: binding.runtimeGenerationId,
            onDispatch: () => { dispatched = true; },
            route: current,
            signal: execution.signal
          });
          return mcpToolExecutionResult(execution.call, raw);
        } catch (error) {
          // A write refused before it was sent has a known outcome; a read-only call fails for the batch to try again.
          if (!readOnly && !dispatched && !execution.signal.aborted) return notSent(execution.call, error);
          throw error;
        }
      }
    });
  };
  for (const definition of mcpRunTools(snapshot)) addTool(definition);

  const materialize = input.services.mcp?.materialize;
  const appendEpoch = input.services.repository.appendMcpDiscoveryEpoch;
  if (!discovery || !materialize || !appendEpoch || !input.services.mcp) return undefined;
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
        // The accepted bindings of newly loaded servers (their rows, written with the epoch), then their tools.
        if (input.loadMcpBindingRows) {
          for (const [serverId, binding] of engineSnapshotMcpBindings(snapshot, await input.loadMcpBindingRows())) {
            input.mcpBindings.set(serverId, binding);
          }
        }
        for (const definition of mcpRunTools(snapshot)) if (!tools.has(definition.name)) addTool(definition);
        return executed.toolResult;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    }
  });
  // Exactly that tool, by its name in the frozen catalog the model's `find_tools` searches; nothing outside it.
  return (name, id) => discovery?.catalog.servers.some((server) => server.tools.some((tool) => tool.namespacedName === name))
    ? { arguments: { query: `select:${name}` }, id, name: MCP_FIND_TOOLS_NAME } : undefined;
}

/**
 * The bindings of a snapshot's servers, by server, from the run's rows: the
 * row of the runtime generation whose fingerprint is the server's. Admission
 * and every discovery epoch write those rows with the run, so a server Auto
 * loaded mid-run is bound like one admission bound.
 */
export function engineSnapshotMcpBindings(snapshot: McpRunPlanSnapshot | undefined,
  rows: readonly EngineMcpBindingRow[]): Map<string, EngineMcpBinding> {
  const byFingerprint = acceptedRowsByFingerprint(rows);
  const result = new Map<string, EngineMcpBinding>();
  for (const server of snapshot?.servers ?? []) {
    const row = byFingerprint.get(server.fingerprint);
    if (row) result.set(server.serverId, { fingerprint: server.fingerprint, mcpRunBindingId: row.id, runtimeGenerationId: row.runtimeGenerationId });
  }
  return result;
}

/** The rows of accepted runtime generations, by fingerprint. */
function acceptedRowsByFingerprint(rows: readonly EngineMcpBindingRow[]): Map<string, Readonly<{ id: string; runtimeGenerationId: string }>> {
  return new Map(rows.flatMap((row) => row.runtimeGenerationId
    ? [[row.runtimeGenerationFingerprint, { id: row.id, runtimeGenerationId: row.runtimeGenerationId }] as const] : []));
}

/** The accepted bindings of a run, by server, from its `McpRunBinding` rows. */
export function engineMcpBindings(
  bindings: readonly McpRunPlanBinding[],
  rows: readonly EngineMcpBindingRow[]
): Map<string, EngineMcpBinding> {
  const byFingerprint = acceptedRowsByFingerprint(rows);
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

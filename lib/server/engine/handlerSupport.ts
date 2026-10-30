import { logEvent } from "../observability";
import type { ProviderAdapter } from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { endRetiredEngineRunsFor, type RetiredEngineRunDeps } from "../runs/retiredEngineRuns";
import { MANAGE_SKILL_TOOL_NAME, READ_AIQSA_GUIDE_TOOL_NAME, SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunServices } from "./execution";
import { processBootedAt, reconcileNativeRuns, type NativeRecoveryDeps } from "./recovery";
import type { ToolRegistryServices } from "./toolRegistry";
import type { SubagentRunPorts } from "./subagents/runSubagents";
import { workspaceAgentEnvironment } from "../subagents/guestProtocol";
import type { BrowserAgentIdentity, SubagentBackgroundControl, SubagentTypeResolver } from "../subagents/ports";
import { subagentManagementToolNames } from "../subagents/managementTools";

/**
 * The agent engine a send or regenerate handler runs its admitted runs on.
 * Every entry point that admits through the ordinary send handler carries it
 * (the chat routes, the scheduled task runner and Telegram, through
 * `createDefaultSendMessageDeps`), as do the document and Workspace
 * follow-up jobs that start a run admitted behind them.
 */
export type NativeEngineHandlerDeps = Readonly<{
  engine: NativeEngineDeps;
  findOrphans: NativeRecoveryDeps["findOrphans"];
  /** The old core's runs still active (`retiredEngineRuns.ts`), which admission ends like orphans. */
  findRetiredRuns: RetiredEngineRunDeps["findRuns"];
  mcpRuntime?: ToolRegistryServices["mcpRuntime"];
  /** Background sub-agent runs' own recovery pass (`lib/server/runs/subagentBackground/recovery.ts`). */
  subagentRecovery?: NativeRecoveryDeps["subagents"];
  /**
   * The sub-agent ports of the other slices (`lib/server/subagents/ports.ts`): background turns (web and Assistant
   * chats only, never a Telegram turn or a scheduled occurrence) and the user's custom types. The browser identity
   * comes from the run's own Workspace coordinator.
   */
  subagents?: Readonly<{ background?: () => SubagentBackgroundControl; types?: SubagentTypeResolver }>;
  /** The owners of the harness and self-service tools (`defaultNativeToolServices`). */
  tools?: Pick<ToolRegistryServices, "secrets" | "selfService">;
}>;

/**
 * The self-service tools a run takes: all of them in an interactive web run
 * of a personal or temporary chat; in an Assistant chat only the guide and
 * Skill saves (operator decision 2026-10-29), because the Assistant's
 * instructions carry its author's authority and a replaced secret or an
 * edited Assistant has no Undo, while a Skill save shows its changes with
 * Undo. Scheduled occurrences and Telegram turns (the bridge cannot show
 * their cards or Undo) take none, and every change fences its run again as
 * it commits (`selfServiceRunAllowedInTransaction`).
 */
export function selfServiceToolsFor(prepared: MaterializedPreparedRunData,
  options: Readonly<{ scheduled?: boolean; telegram?: boolean }> = {}): readonly string[] {
  if (options.scheduled === true || options.telegram === true || prepared.normalizedRequest.monitoringVerdictTool) return [];
  if (prepared.assistant || prepared.chatAssistant) return [READ_AIQSA_GUIDE_TOOL_NAME, MANAGE_SKILL_TOOL_NAME];
  // Custom sub-agents change like the user's other resources, in the same chats (`managementTools.ts`).
  return [...SELF_SERVICE_TOOLS.map((tool) => tool.name), ...subagentManagementToolNames({ assistant: false })];
}

/**
 * The sub-agent ports one run gets: background turns only in a web or Assistant chat, the custom types (the engine
 * never offers them in an Assistant chat), and the browser identity of its Workspace coordinator, whose release
 * frees an agent's browser slot when its turn ends. Absent ports are unavailable (`callTools.ts`).
 */
export function subagentRunPorts(native: NativeEngineHandlerDeps, input: Readonly<{ scheduled: boolean; telegram: boolean;
  workspace?: WorkspaceCoordinator }>): SubagentRunPorts {
  const background = native.subagents?.background && !input.scheduled && !input.telegram ? native.subagents.background() : undefined;
  const release = input.workspace?.releaseBrowserAgent;
  const browserIdentity: BrowserAgentIdentity | undefined = release ? {
    environment: workspaceAgentEnvironment,
    release: ({ agent, modelRunId, signal, userId }) => release({ agent, runId: modelRunId, ...(signal ? { signal } : {}), userId })
  } : undefined;
  return {
    ...(background ? { background } : {}),
    ...(browserIdentity ? { browserIdentity } : {}),
    ...(native.subagents?.types ? { types: native.subagents.types } : {})
  };
}

/**
 * Before a user's admission: their runs no execution owns end interrupted,
 * and so do the old core's runs still active, so the chat is free.
 */
export async function recoverUserNativeRuns(native: NativeEngineHandlerDeps, deps: Readonly<{
  repository: Pick<RunRepository, "failRun">;
  workspaceCoordinator?: WorkspaceCoordinator;
}>, userId: string): Promise<void> {
  await endRetiredEngineRunsFor({ findRuns: native.findRetiredRuns, repository: deps.repository,
    ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {}) }, { userId });
  await reconcileNativeRuns({ bootedAt: processBootedAt(), findOrphans: native.findOrphans,
    liveRunIds: () => activeRunControllerRegistry.ids(), repository: deps.repository, runs: native.engine.runs,
    ...(native.subagentRecovery ? { subagents: native.subagentRecovery } : {}),
    ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {}) }, { userId }).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "native_run_recovery_failed", error, outcome: "failed", stage: "recovery",
      subsystem: "run_recovery" });
  });
}

/** Answer adapters that render the neutral history (`lib/server/providers/history.ts`). A new answer adapter
 * belongs here too, or admission refuses every send on it with `model_adapter_unsupported`. */
export const NATIVE_ENGINE_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  "anthropic_messages",
  "deepseek_responses_native",
  "fake",
  "gemini_interactions_native",
  "openai_chat_completions_compatible",
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
]);

/**
 * Why the agent cannot run an admitted chat model, checked before the run is
 * created so nothing is accepted that no engine would answer: the model must
 * have verified tool calling (`agent_docs/PROVIDERS.md`), and its adapter
 * must render the agent's conversation. Null admits.
 */
export function engineAdmissionRefusal(prepared: MaterializedPreparedRunData):
  Readonly<{ code: "model_adapter_unsupported" | "model_tool_calling_required"; status: 409 }> | null {
  if (!NATIVE_ENGINE_ADAPTER_KINDS.has(prepared.providerAdmissionPlan.answer.snapshot.model.adapterKind)) {
    return { code: "model_adapter_unsupported", status: 409 };
  }
  if (prepared.normalizedRequest.modelCapabilities.toolCalling !== true) return { code: "model_tool_calling_required", status: 409 };
  return null;
}

/**
 * The services a native run takes from its entry point: the send handler's
 * dependencies, or the Workspace follow-up that starts a run admitted behind
 * the previous answer's hand-off.
 */
export function nativeRunServices(deps: Readonly<Pick<NativeRunServices, "artifacts" | "images" | "mcp" | "memorySearch" |
  "skillTools" | "vision" | "mcpGuard">>): Omit<NativeRunServices, "searchRuntimes"> {
  return {
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.images ? { images: deps.images } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.mcpGuard ? { mcpGuard: deps.mcpGuard } : {}),
    ...(deps.memorySearch ? { memorySearch: deps.memorySearch } : {}),
    ...(deps.skillTools ? { skillTools: deps.skillTools } : {}),
    ...(deps.vision ? { vision: deps.vision } : {})
  };
}

/** The native execution of an admitted run. */
export function nativeRunResponse(native: NativeEngineHandlerDeps, input: Readonly<{
  adapter: ProviderAdapter;
  approvalId?: string;
  chatTitleGenerator?: import("../chats/titleGeneration").ChatTitleGenerator;
  created: Readonly<{ acceptedAt?: Date; assistantMessageId: string; runId: string; userMessageId: string }>;
  prepared: MaterializedPreparedRunData;
  repository: RunRepository;
  /** The run is a scheduled task's occurrence. */
  scheduled?: boolean;
  searchRuntimes?: Readonly<Record<string, ProviderRuntimeBinding>>;
  services: Omit<NativeRunServices, "searchRuntimes">;
  /** The run is a Telegram turn. */
  telegram?: boolean;
  userId: string;
  workspace?: WorkspaceCoordinator;
}>): Response {
  const tools = native.tools;
  const scheduled = input.scheduled === true;
  const telegram = input.telegram === true;
  const selfServiceTools = selfServiceToolsFor(input.prepared, { scheduled, telegram });
  return createNativeRunExecutionResponse({
    adapter: input.adapter,
    ...(input.approvalId ? { approvalContinuation: { approvalId: input.approvalId } } : {}),
    ...(input.chatTitleGenerator ? { chatTitleGenerator: input.chatTitleGenerator } : {}),
    created: input.created,
    engine: native.engine,
    ...(native.mcpRuntime ? { mcpRuntime: native.mcpRuntime } : {}),
    prepared: input.prepared,
    repository: input.repository,
    ...(scheduled ? { scheduled: true as const } : {}),
    ...(telegram ? { telegram: true as const } : {}),
    subagents: subagentRunPorts(native, { scheduled, telegram, ...(input.workspace ? { workspace: input.workspace } : {}) }),
    services: {
      ...input.services,
      ...(input.searchRuntimes ? { searchRuntimes: input.searchRuntimes } : {}),
      ...(tools?.secrets ? { secrets: tools.secrets } : {}),
      ...(tools?.selfService && selfServiceTools.length > 0 ? { selfService: { ...tools.selfService, tools: selfServiceTools } } : {})
    },
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {})
  });
}

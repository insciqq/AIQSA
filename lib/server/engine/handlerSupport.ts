import type { ConnectorTurn } from "../connectors/turn";
import { logEvent } from "../observability";
import type { ProviderAdapter } from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { MANAGE_MEMORY_TOOL_NAME, MANAGE_SKILL_TOOL_NAME, READ_AIQSA_GUIDE_TOOL_NAME, SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunServices } from "./execution";
import { processBootedAt, reconcileNativeRuns, type NativeRecoveryDeps } from "./recovery";
import type { ToolRegistryServices } from "./toolRegistry";
import type { SubagentRunPorts } from "./subagents/runSubagents";
import { workspaceAgentEnvironment } from "../subagents/guestProtocol";
import type { BrowserAgentIdentity, SubagentBackgroundControl, SubagentMessaging, SubagentTypeResolver } from "../subagents/ports";
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
  mcpRuntime?: ToolRegistryServices["mcpRuntime"];
  /** Background sub-agent runs' own recovery pass (`lib/server/runs/subagentBackground/recovery.ts`). */
  subagentRecovery?: NativeRecoveryDeps["subagents"];
  /**
   * The sub-agent ports of the other slices (`lib/server/subagents/ports.ts`): background turns and the user's custom
   * types. The browser identity comes from the run's own Workspace coordinator.
   */
  subagents?: Readonly<{ background?: () => SubagentBackgroundControl; messaging?: () => SubagentMessaging; types?: SubagentTypeResolver }>;
  /** The owners of the harness and self-service tools (`defaultNativeToolServices`). */
  tools?: Pick<ToolRegistryServices, "computerOutputs" | "runProxies" | "secrets" | "selfService">;
}>;

/**
 * The self-service tools a run takes: all of them in an interactive run of a
 * personal or temporary chat, on the web or in Telegram; in an Assistant chat
 * only the guide and Skill saves (operator decision 2026-10-29), because the
 * Assistant's instructions carry its author's authority and a replaced secret
 * or an edited Assistant has no Undo, while a Skill save shows its changes
 * with Undo. A Telegram turn takes what the same chat takes on the web
 * (operator decision 2026-11-16): the bot shows each change as a message with
 * Undo, Confirm and Cancel buttons (`lib/server/telegram/changes/`).
 * Scheduled occurrences and Discord turns (a service account's runs, with no
 * one to confirm) take none, and neither does a turn that is not the user's
 * own request (`TurnProvenance.userRequest`): a turn the server wrote (a
 * sub-agent wake-up, a browser sign-in request, a regenerate of either),
 * which authorizes nothing, or a regenerate of a scheduled task's prompt,
 * which the model may have written. The continuation after an MCP Allow has
 * the authority of the turn whose call the user allowed: it goes on with the
 * user's own request, and takes none after a wake-up's or a sign-in
 * request's, since that Allow covers its one call. Every change fences its
 * run again as it commits (`selfServiceRunAllowedInTransaction`). `manage_memory` rides only
 * where admission froze the user's Memory with changes (`memory.changes`: Memory
 * on, an ordinary personal chat that is neither Temporary nor Excluded), so a
 * temporary chat, a task and an Assistant chat never change the note.
 */
export function selfServiceToolsFor(prepared: MaterializedPreparedRunData,
  options: Readonly<{ connectorTurn?: ConnectorTurn; scheduled?: boolean; userRequest: boolean }>): readonly string[] {
  const connectorWithoutChanges = options.connectorTurn !== undefined && options.connectorTurn !== "telegram";
  if (!options.userRequest || options.scheduled === true || connectorWithoutChanges ||
    prepared.normalizedRequest.monitoringVerdictTool) return [];
  if (prepared.assistant || prepared.chatAssistant) return [READ_AIQSA_GUIDE_TOOL_NAME, MANAGE_SKILL_TOOL_NAME];
  const memoryChanges = prepared.normalizedRequest.memory?.changes === true;
  // Custom sub-agents change like the user's other resources, in the same chats (`managementTools.ts`).
  return [...SELF_SERVICE_TOOLS.flatMap((tool) => tool.name !== MANAGE_MEMORY_TOOL_NAME || memoryChanges ? [tool.name] : []),
    ...subagentManagementToolNames({ assistant: false })];
}

/**
 * The sub-agent ports one run gets. Every run takes background turns, messaging and the runner's custom types: a connector
 * turn or a scheduled occurrence starts no background turn (`backgroundAllowed`, `execution.ts`), but it answers one
 * waiting on its branch, and stops it, like any other. The browser identity is its Workspace coordinator's, whose release
 * frees an agent's browser slot when its turn ends. Absent ports are unavailable (`callTools.ts`).
 */
export function subagentRunPorts(native: NativeEngineHandlerDeps, input: Readonly<{ workspace?: WorkspaceCoordinator }>): SubagentRunPorts {
  const background = native.subagents?.background?.();
  const release = input.workspace?.releaseBrowserAgent;
  const browserIdentity: BrowserAgentIdentity | undefined = release ? {
    environment: workspaceAgentEnvironment,
    release: ({ agent, modelRunId, signal, userId }) => release({ agent, runId: modelRunId, ...(signal ? { signal } : {}), userId })
  } : undefined;
  return {
    ...(background ? { background } : {}),
    ...(browserIdentity ? { browserIdentity } : {}),
    ...(native.subagents?.messaging ? { messaging: native.subagents.messaging() } : {}),
    ...(native.subagents?.types ? { types: native.subagents.types } : {})
  };
}

/** Before a user's admission: their runs no execution owns end interrupted, so the chat is free. */
export async function recoverUserNativeRuns(native: NativeEngineHandlerDeps, deps: Readonly<{
  repository: Pick<RunRepository, "failRun">;
  workspaceCoordinator?: WorkspaceCoordinator;
}>, userId: string): Promise<void> {
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
export function nativeRunServices(deps: Readonly<Pick<NativeRunServices, "artifacts" | "images" | "mcp" | "pastChats" |
  "skillTools" | "vision" | "mcpGuard">>): Omit<NativeRunServices, "searchRuntimes"> {
  return {
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.images ? { images: deps.images } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.mcpGuard ? { mcpGuard: deps.mcpGuard } : {}),
    ...(deps.pastChats ? { pastChats: deps.pastChats } : {}),
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
  /** The run is a connector's turn (Telegram, Discord). */
  connectorTurn?: ConnectorTurn;
  userId: string;
  /** The turn is the user's own request (`TurnProvenance.userRequest`): only then may it take self-service tools. */
  userRequest: boolean;
  workspace?: WorkspaceCoordinator;
}>): Response {
  const tools = native.tools;
  const scheduled = input.scheduled === true;
  const connectorTurn = input.connectorTurn;
  const selfServiceTools = selfServiceToolsFor(input.prepared, { ...(connectorTurn ? { connectorTurn } : {}), scheduled,
    userRequest: input.userRequest });
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
    ...(connectorTurn ? { connectorTurn } : {}),
    subagents: subagentRunPorts(native, input.workspace ? { workspace: input.workspace } : {}),
    services: {
      ...input.services,
      ...(input.searchRuntimes ? { searchRuntimes: input.searchRuntimes } : {}),
      ...(tools?.computerOutputs ? { computerOutputs: tools.computerOutputs } : {}),
      ...(tools?.runProxies ? { runProxies: tools.runProxies } : {}),
      ...(tools?.secrets ? { secrets: tools.secrets } : {}),
      ...(tools?.selfService && selfServiceTools.length > 0 ? { selfService: { ...tools.selfService, tools: selfServiceTools } } : {})
    },
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {})
  });
}

import { logEvent } from "../observability";
import type { ProviderAdapter } from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import { endRetiredEngineRunsFor, type RetiredEngineRunDeps } from "../runs/retiredEngineRuns";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunServices } from "./execution";
import { processBootedAt, reconcileNativeRuns, type NativeRecoveryDeps } from "./recovery";
import type { ToolRegistryServices } from "./toolRegistry";

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
  /** The owners of the harness and self-service tools (`defaultNativeToolServices`). */
  tools?: Pick<ToolRegistryServices, "secrets" | "selfService">;
}>;

/**
 * Whether a run takes the self-service tools: an interactive run of a
 * personal or temporary chat in the web. Assistant runs, scheduled
 * occurrences and Telegram turns (the bridge cannot show
 * their confirmation cards or Undo) never take them, and every change fences
 * its run again as it commits (`selfServiceRunAllowedInTransaction`).
 */
export function selfServiceChat(prepared: MaterializedPreparedRunData,
  options: Readonly<{ scheduled?: boolean; telegram?: boolean }> = {}): boolean {
  const request = prepared.normalizedRequest;
  return options.scheduled !== true && options.telegram !== true && !prepared.assistant &&
    !prepared.chatAssistant && !request.monitoringVerdictTool;
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
  "skillTools" | "vision">>): Omit<NativeRunServices, "searchRuntimes"> {
  return {
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.images ? { images: deps.images } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
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
    services: {
      ...input.services,
      ...(input.searchRuntimes ? { searchRuntimes: input.searchRuntimes } : {}),
      ...(tools?.secrets ? { secrets: tools.secrets } : {}),
      ...(tools?.selfService && selfServiceChat(input.prepared, { scheduled, telegram }) ? { selfService: tools.selfService } : {})
    },
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {})
  });
}

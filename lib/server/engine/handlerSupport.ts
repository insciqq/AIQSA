import { logEvent } from "../observability";
import type { ProviderAdapter } from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunServices } from "./execution";
import { processBootedAt, reconcileNativeRuns, type NativeRecoveryDeps } from "./recovery";
import { nativeEngineRoute, type NativeEngineAllowlist, type NativeEngineRoute } from "./routing";
import type { ToolRegistryServices } from "./toolRegistry";

/**
 * What a send or regenerate handler adds to admit native runs. Every entry
 * point that admits through the ordinary send handler carries it (the chat
 * routes, the scheduled task runner, Telegram and answer review, through
 * `createDefaultSendMessageDeps`); `nativeEngineRoute` decides per run.
 */
export type NativeEngineHandlerDeps = Readonly<{
  allowlist(): NativeEngineAllowlist;
  engine: NativeEngineDeps;
  findOrphans: NativeRecoveryDeps["findOrphans"];
  mcpRuntime?: ToolRegistryServices["mcpRuntime"];
  /** The owners of the harness and self-service tools (`defaultNativeToolServices`). */
  tools?: Pick<ToolRegistryServices, "secrets" | "selfService">;
}>;

/**
 * Whether a run takes the self-service tools: an interactive run of a
 * personal or temporary chat (from the web or Telegram). Project, Assistant,
 * Agent and review runs and scheduled occurrences never take them, and every
 * change fences its run again as it commits (`selfServiceRunAllowedInTransaction`).
 */
export function selfServiceChat(prepared: MaterializedPreparedRunData, options: Readonly<{ scheduled?: boolean }> = {}): boolean {
  const request = prepared.normalizedRequest;
  return options.scheduled !== true && !prepared.project && !prepared.assistant && !prepared.chatAssistant && !request.agent &&
    !request.answerReviewStep && !request.monitoringVerdictTool;
}

/** Before a user's admission: their native runs no execution owns end interrupted, so the chat is free. */
export async function recoverUserNativeRuns(native: NativeEngineHandlerDeps | undefined, deps: Readonly<{
  repository: Pick<RunRepository, "failRun">;
  workspaceCoordinator?: WorkspaceCoordinator;
}>, userId: string): Promise<void> {
  if (!native) return;
  await reconcileNativeRuns({ bootedAt: processBootedAt(), findOrphans: native.findOrphans,
    liveRunIds: () => activeRunControllerRegistry.ids(), repository: deps.repository, runs: native.engine.runs,
    ...(deps.workspaceCoordinator ? { workspace: deps.workspaceCoordinator } : {}) }, { userId }).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "native_run_recovery_failed", error, outcome: "failed", stage: "recovery",
      subsystem: "run_recovery" });
  });
}

/** The engine of a run about to be admitted; the old core without native deps. */
export function routeRun(native: NativeEngineHandlerDeps | undefined, input: Readonly<{
  prepared: MaterializedPreparedRunData;
  user: Readonly<{ email: string | null; id: string }>;
  workspacePredecessor: boolean;
}>): NativeEngineRoute {
  if (!native) return { engine: "v1", reason: "not_listed" };
  return nativeEngineRoute({ ...input, allowlist: native.allowlist() });
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
  userId: string;
  workspace?: WorkspaceCoordinator;
}>): Response {
  const tools = native.tools;
  const scheduled = input.scheduled === true;
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
      ...(tools?.selfService && selfServiceChat(input.prepared, { scheduled }) ? { selfService: tools.selfService } : {})
    },
    userId: input.userId,
    ...(input.workspace ? { workspace: input.workspace } : {})
  });
}

import type {
  ChatWorkspaceState,
  WorkspaceRuntimeHealthWire,
  WorkspaceSessionStateWire
} from "@/lib/contracts/workspace";
import type { WorkspaceHealthService } from "./health";
import type { WorkspacePolicyRepository } from "./policyRepository";
import { normalizeProviderModelConfiguration } from "@/lib/server/providers/providerConfiguration";

export type WorkspaceAvailabilitySnapshot = Readonly<{
  policy: Readonly<{ enabled: boolean; internetEnabled: boolean }>;
  runtime: WorkspaceRuntimeHealthWire;
}>;

export type WorkspaceAvailabilityService = Readonly<{
  invalidate(): void;
  project(
    snapshot: WorkspaceAvailabilitySnapshot,
    input: Readonly<{
      enabled: boolean;
      modelSupportsTools: boolean;
      session: Readonly<{ internetEnabled: boolean; state: string }> | null;
      continuationSeedStatus?: string | null;
      continuationSeedFailureCode?: string | null;
    }>
  ): ChatWorkspaceState;
  snapshot(): Promise<WorkspaceAvailabilitySnapshot>;
}>;

export function workspaceModelSupportsTools(model: Readonly<{
  activeConfig: unknown | null;
  activeVersion: number;
  enabled: boolean;
  modelClass: string;
}> | null): boolean {
  if (
    !model ||
    !model.enabled ||
    model.activeVersion < 1 ||
    model.activeConfig === null ||
    model.modelClass !== "answer"
  ) return false;
  try {
    return normalizeProviderModelConfiguration(model.activeConfig).capabilities.toolCalling === true;
  } catch {
    return false;
  }
}

function sessionState(value: string): WorkspaceSessionStateWire {
  switch (value) {
    case "PENDING": return "not_started";
    case "CREATING": return "creating";
    case "READY": return "ready";
    case "RUNNING": return "running";
    case "STOPPED": return "stopped";
    case "FAILED":
    case "DELETING":
    default:
      return "failed";
  }
}

function continuationFailureReason(code: string | null | undefined): string {
  switch (code) {
    case "workspace_archive_limit_exceeded": return "archive_limit";
    case "workspace_archive_invalid": return "unsupported_entries";
    case "workspace_tool_timeout": return "timeout";
    case "workspace_runtime_unavailable": return "runner_unavailable";
    case "workspace_session_lost": return "source_disk_missing";
    case "workspace_restored_disk_lost": return "restored_disk_lost";
    case "workspace_operation_interrupted": return "interrupted";
    case "workspace_reset_consumed": return "reset_consumed";
    default: return "restore_failed";
  }
}

export function createWorkspaceAvailabilityService(input: Readonly<{
  cacheTtlMs?: number;
  health: WorkspaceHealthService;
  now?: () => number;
  policy: WorkspacePolicyRepository;
}>): WorkspaceAvailabilityService {
  const cacheTtlMs = input.cacheTtlMs ?? 2_000;
  const now = input.now ?? Date.now;
  let cached: { expiresAt: number; value: WorkspaceAvailabilitySnapshot } | null = null;
  let pending: Promise<WorkspaceAvailabilitySnapshot> | null = null;

  return {
    invalidate() {
      cached = null;
    },
    project(snapshot, state) {
      const available = snapshot.policy.enabled && snapshot.runtime.state === "ready" &&
        state.modelSupportsTools;
      const unavailableReason = snapshot.policy.enabled
        ? snapshot.runtime.state === "ready"
          ? state.modelSupportsTools
            ? undefined
            : "model_tools_required" as const
          : "runtime_unavailable" as const
        : "installation_disabled" as const;
      const seedStatus = state.continuationSeedStatus;
      const continuationFiles = seedStatus
        ? seedStatus === "NO_SOURCE_DISK" ? { status: "none" as const }
          : seedStatus === "RESTORED" ? { status: "ready" as const }
          : seedStatus === "FAILED" || seedStatus === "ABANDONED" ? { status: "failed" as const, reason: continuationFailureReason(state.continuationSeedFailureCode) }
          : { status: "pending" as const }
        : undefined;
      return {
        agentAvailable: available && snapshot.runtime.agentReady === true,
        available,
        enabled: state.enabled,
        internetEnabled: state.session?.internetEnabled ??
          (snapshot.policy.enabled ? snapshot.policy.internetEnabled : null),
        sessionState: state.session
          ? sessionState(state.session.state)
          : state.enabled ? "not_started" : null,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(continuationFiles ? { continuationFiles } : {})
      };
    },
    async snapshot() {
      const timestamp = now();
      if (cached && cached.expiresAt > timestamp) return cached.value;
      pending ??= Promise.all([input.policy.read(), input.health.read()])
        .then(([policy, runtime]) => {
          const value = {
            policy: { enabled: policy.enabled, internetEnabled: policy.internetEnabled },
            runtime
          };
          cached = { expiresAt: now() + cacheTtlMs, value };
          return value;
        })
        .catch(() => {
          const value: WorkspaceAvailabilitySnapshot = {
            policy: { enabled: false, internetEnabled: true },
            runtime: {
              reasonCode: "workspace_runtime_unavailable",
              state: "unavailable"
            }
          };
          cached = { expiresAt: now() + cacheTtlMs, value };
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    }
  };
}

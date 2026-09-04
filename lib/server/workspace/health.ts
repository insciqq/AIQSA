import type { WorkspaceRuntimeHealthWire } from "@/lib/contracts/workspace";
import { WORKSPACE_MCP_VERSION, WORKSPACE_RUNTIME_VERSION } from "./config";
import type { WorkspaceRuntime, WorkspaceRuntimeHealth } from "./runtime";

const HEALTH_REASON_CODES = new Set([
  "workspace_image_unavailable",
  "workspace_runner_unconfigured",
  "workspace_runtime_incompatible",
  "workspace_runtime_unavailable"
]);

export type WorkspaceHealthService = Readonly<{
  invalidate(): void;
  read(options?: Readonly<{ fresh?: boolean }>): Promise<WorkspaceRuntimeHealthWire>;
}>;

function sanitizedUnavailable(health: WorkspaceRuntimeHealth): WorkspaceRuntimeHealthWire {
  const reasonCode = health.reasonCode && HEALTH_REASON_CODES.has(health.reasonCode)
    ? health.reasonCode
    : "workspace_runtime_unavailable";
  return {
    ...(typeof health.imageReady === "boolean" ? { imageReady: health.imageReady } : {}),
    ...(health.mcpVersion === WORKSPACE_MCP_VERSION ? { mcpVersion: health.mcpVersion } : {}),
    reasonCode,
    ...(health.runtimeVersion === WORKSPACE_RUNTIME_VERSION
      ? { runtimeVersion: health.runtimeVersion }
      : {}),
    state: "unavailable",
    ...(typeof health.virtualizationReady === "boolean"
      ? { virtualizationReady: health.virtualizationReady }
      : {})
  };
}

export function sanitizeWorkspaceRuntimeHealth(
  health: WorkspaceRuntimeHealth
): WorkspaceRuntimeHealthWire {
  if (
    health.state === "ready" &&
    health.runtimeVersion === WORKSPACE_RUNTIME_VERSION &&
    health.mcpVersion === WORKSPACE_MCP_VERSION &&
    health.imageReady === true &&
    health.virtualizationReady === true
  ) {
    return {
      imageReady: true,
      mcpVersion: WORKSPACE_MCP_VERSION,
      runtimeVersion: WORKSPACE_RUNTIME_VERSION,
      state: "ready",
      virtualizationReady: true
    };
  }
  return sanitizedUnavailable({
    ...health,
    reasonCode: health.state === "ready"
      ? "workspace_runtime_incompatible"
      : health.reasonCode
  });
}

export function createWorkspaceHealthService(input: Readonly<{
  cacheTtlMs?: number;
  now?: () => number;
  runtime: WorkspaceRuntime;
  timeoutMs?: number;
}>): WorkspaceHealthService {
  const cacheTtlMs = input.cacheTtlMs ?? 5_000;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const now = input.now ?? Date.now;
  let cached: { expiresAt: number; value: WorkspaceRuntimeHealthWire } | null = null;
  let pending: Promise<WorkspaceRuntimeHealthWire> | null = null;

  async function probe(): Promise<WorkspaceRuntimeHealthWire> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return sanitizeWorkspaceRuntimeHealth(await input.runtime.health(controller.signal));
    } catch {
      return { reasonCode: "workspace_runtime_unavailable", state: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    invalidate() {
      cached = null;
    },
    async read(options = {}) {
      const timestamp = now();
      if (!options.fresh && cached && cached.expiresAt > timestamp) return cached.value;
      pending ??= probe().then((value) => {
        cached = { expiresAt: now() + cacheTtlMs, value };
        return value;
      }).finally(() => {
        pending = null;
      });
      return pending;
    }
  };
}

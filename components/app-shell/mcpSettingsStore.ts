import type { UserMcpServer } from "@/lib/contracts/mcp";
import { loadUserMcpServers } from "./mcpSettingsApi";
import { hasTransitioningMcpServer } from "./mcpReadiness";
import { create } from "zustand";

export type McpOAuthOutcome = Readonly<{
  kind: "cancelled" | "connected" | "failed";
  serverId: string | null;
}>;

type McpSettingsLoadState = "error" | "idle" | "loading" | "ready";

type McpSettingsStore = {
  error: string | null;
  loadState: McpSettingsLoadState;
  oauthOutcome: McpOAuthOutcome | null;
  servers: UserMcpServer[];
  replaceServer(server: UserMcpServer): void;
  setError(error: string | null): void;
  setOAuthOutcome(outcome: McpOAuthOutcome | null): void;
};

export const useMcpSettingsStore = create<McpSettingsStore>((set) => ({
  error: null,
  loadState: "idle",
  oauthOutcome: null,
  replaceServer(server) {
    set((state) => ({
      servers: state.servers.map((candidate) => candidate.id === server.id ? server : candidate)
    }));
    syncMcpReadinessPolling(true);
  },
  servers: [],
  setError(error) {
    set({ error });
  },
  setOAuthOutcome(oauthOutcome) {
    set({ oauthOutcome });
  }
}));

let loadPromise: Promise<UserMcpServer[]> | null = null;
let readinessPollAttempt = 0;
let readinessPollInFlight = false;
let readinessPollTimer: number | null = null;
const readinessPollDelaysMs = [750, 1_500, 2_500, 4_000, 6_000] as const;
const oauthAuthorizingPrefix = "aiqsa:mcp:authorizing:";
const oauthAuthorizingTtlMs = 10 * 60_000;

function stopMcpReadinessPolling(): void {
  if (readinessPollTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(readinessPollTimer);
  }
  readinessPollAttempt = 0;
  readinessPollTimer = null;
}

function syncMcpReadinessPolling(reset = false): void {
  if (!hasTransitioningMcpServer(useMcpSettingsStore.getState().servers)) {
    stopMcpReadinessPolling();
    return;
  }
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (reset) {
    readinessPollAttempt = 0;
    if (readinessPollTimer !== null) window.clearTimeout(readinessPollTimer);
    readinessPollTimer = null;
  }
  if (document.visibilityState !== "visible" || readinessPollInFlight || readinessPollTimer !== null) return;

  const delay = readinessPollDelaysMs[Math.min(readinessPollAttempt, readinessPollDelaysMs.length - 1)]!;
  readinessPollTimer = window.setTimeout(async () => {
    readinessPollTimer = null;
    if (document.visibilityState !== "visible") return;
    readinessPollInFlight = true;
    try {
      await refreshMcpSettings(true, { background: true });
    } catch {
      // A transient catalog failure must not turn activation progress into a false terminal state.
    } finally {
      readinessPollInFlight = false;
      readinessPollAttempt += 1;
      syncMcpReadinessPolling();
    }
  }, delay);
}

function oauthAuthorizingKey(serverId: string): string {
  return `${oauthAuthorizingPrefix}${serverId}`;
}

export function markMcpOAuthAuthorizing(serverId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(oauthAuthorizingKey(serverId), String(Date.now()));
}

export function clearMcpOAuthAuthorizing(serverId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(oauthAuthorizingKey(serverId));
}

export function isMcpOAuthAuthorizing(serverId: string): boolean {
  if (typeof window === "undefined") return false;
  const startedAt = Number(window.sessionStorage.getItem(oauthAuthorizingKey(serverId)));
  if (!Number.isFinite(startedAt) || startedAt <= 0 || Date.now() - startedAt > oauthAuthorizingTtlMs) {
    clearMcpOAuthAuthorizing(serverId);
    return false;
  }
  return true;
}

export async function refreshMcpSettings(
  force = false,
  options: Readonly<{ background?: boolean }> = {}
): Promise<UserMcpServer[]> {
  const current = useMcpSettingsStore.getState();
  if (!force && current.loadState === "ready") {
    syncMcpReadinessPolling();
    return current.servers;
  }
  if (loadPromise) return loadPromise;

  const preserveCurrentState = options.background === true && current.loadState !== "idle";
  useMcpSettingsStore.setState(preserveCurrentState
    ? { error: null }
    : { error: null, loadState: "loading" });
  loadPromise = loadUserMcpServers().then(
    (servers) => {
      useMcpSettingsStore.setState({ error: null, loadState: "ready", servers });
      syncMcpReadinessPolling();
      return servers;
    },
    (error: unknown) => {
      const code = error instanceof Error ? error.message : "mcp_request_failed";
      useMcpSettingsStore.setState(preserveCurrentState
        ? { error: code }
        : { error: code, loadState: "error" });
      throw error;
    }
  ).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export function consumeMcpOAuthReturn(url: URL): McpOAuthOutcome | null {
  if (url.searchParams.get("settings") !== "mcp") return null;
  const raw = url.searchParams.get("oauth");
  const kind = raw === "connected" || raw === "cancelled" || raw === "failed" ? raw : null;
  const outcome = kind ? { kind, serverId: url.searchParams.get("server") } as const : null;
  if (outcome?.serverId) clearMcpOAuthAuthorizing(outcome.serverId);
  useMcpSettingsStore.getState().setOAuthOutcome(outcome);
  url.searchParams.delete("settings");
  url.searchParams.delete("oauth");
  url.searchParams.delete("server");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return outcome;
}

export function resetMcpSettingsStoreForTest(): void {
  loadPromise = null;
  readinessPollInFlight = false;
  stopMcpReadinessPolling();
  if (typeof window !== "undefined") {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(oauthAuthorizingPrefix)) window.sessionStorage.removeItem(key);
    }
  }
  useMcpSettingsStore.setState({
    error: null,
    loadState: "idle",
    oauthOutcome: null,
    servers: []
  });
}

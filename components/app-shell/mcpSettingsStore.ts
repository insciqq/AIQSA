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
    catalogRevision += 1;
    set((state) => ({
      loadState: state.loadState === "loading" ? "ready" : state.loadState,
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
let catalogRevision = 0;
let loadGeneration = 0;
let settingsObservers = 0;
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
  const servers = useMcpSettingsStore.getState().servers;
  if (!settingsObservers || !servers.some((server) => server.enabled)) {
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

  const delay = hasTransitioningMcpServer(servers)
    ? readinessPollDelaysMs[Math.min(readinessPollAttempt, readinessPollDelaysMs.length - 1)]!
    : 30_000;
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

function refreshVisibleSettings(): void {
  stopMcpReadinessPolling();
  if (document.visibilityState === "visible") {
    void refreshMcpSettings(true, { background: true }).catch(() => undefined);
  }
}

/** Own polling only while the Settings section is mounted and the tab is visible. */
export function observeMcpSettings(): () => void {
  settingsObservers += 1;
  if (settingsObservers === 1) {
    document.addEventListener("visibilitychange", refreshVisibleSettings);
    refreshVisibleSettings();
  }
  return () => {
    settingsObservers = Math.max(0, settingsObservers - 1);
    if (!settingsObservers) {
      document.removeEventListener("visibilitychange", refreshVisibleSettings);
      stopMcpReadinessPolling();
    }
  };
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

  const generation = loadGeneration;
  const revision = catalogRevision;
  const preserveCurrentState = options.background === true && current.loadState !== "idle";
  useMcpSettingsStore.setState({
    error: null,
    ...(preserveCurrentState ? {} : { loadState: "loading" }),
    // Renewal/error state cannot leave stale positive evidence on screen.
    servers: current.servers.map((server) => server.operationalStatus === "active"
      ? { ...server, operationalStatus: "checking" } : server)
  });
  loadPromise = loadUserMcpServers().then(
    (servers) => {
      if (generation !== loadGeneration || revision !== catalogRevision) {
        return useMcpSettingsStore.getState().servers;
      }
      useMcpSettingsStore.setState({ error: null, loadState: "ready", servers });
      syncMcpReadinessPolling();
      return servers;
    },
    (error: unknown) => {
      if (generation !== loadGeneration || revision !== catalogRevision) throw error;
      const code = error instanceof Error ? error.message : "mcp_request_failed";
      useMcpSettingsStore.setState(preserveCurrentState
        ? { error: code }
        : { error: code, loadState: "error" });
      throw error;
    }
  ).finally(() => {
    if (generation === loadGeneration) {
      loadPromise = null;
      syncMcpReadinessPolling();
    }
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

export function deactivateMcpSettings(): void {
  loadGeneration += 1;
  catalogRevision += 1;
  settingsObservers = 0;
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshVisibleSettings);
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

import { create } from "zustand";
import type { McpReadiness } from "@/lib/contracts/mcp";
import type { McpOAuthOutcome } from "./mcpSettingsStore";
import { loadPersonalMcpConnections, PersonalMcpApiError, type PersonalMcpConnection } from "./personalMcpApi";

/**
 * The account's personal MCP connections: Settings → Connections edits them
 * and the composer discloses them. They never enter the installation store,
 * whose list and limits belong to Studio.
 */
export type PersonalMcpLoadState = "error" | "idle" | "loading" | "ready";

type PersonalMcpState = {
  connections: PersonalMcpConnection[];
  /** Stable code of the last failed read; a background failure keeps the loaded rows. */
  error: string | null;
  loadState: PersonalMcpLoadState;
  /** The OAuth callback outcome for one connection, shown by its row. */
  oauthOutcome: McpOAuthOutcome | null;
};

const initialState: PersonalMcpState = { connections: [], error: null, loadState: "idle", oauthOutcome: null };

export const usePersonalMcpStore = create<PersonalMcpState>(() => ({ ...initialState }));

/** Local mutations since a read started make that read stale. */
let revision = 0;
/** Account changes invalidate every read and timer. */
let generation = 0;
let sequence = 0;
let inFlight: { generation: number; promise: Promise<PersonalMcpConnection[]>; revision: number } | null = null;

/** Readiness the server is still settling without any user action. */
const pollingReadiness = new Set<McpReadiness>(["queued", "restarting", "starting"]);
const pollDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
let observers = 0;
let pollAttempt = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function personalMcpNeedsPolling(connections: readonly PersonalMcpConnection[]): boolean {
  return connections.some((connection) => connection.enabled && pollingReadiness.has(connection.readiness));
}

/**
 * Reads the list. A newer read, a local mutation or an account change makes
 * an older result stale, so it never reverts newer state.
 */
export function refreshPersonalMcp(options: Readonly<{ background?: boolean }> = {}): Promise<PersonalMcpConnection[]> {
  if (inFlight && inFlight.revision === revision && inFlight.generation === generation) return inFlight.promise;
  const ownSequence = ++sequence;
  const ownRevision = revision;
  const ownGeneration = generation;
  const current = usePersonalMcpStore.getState();
  const keepRows = options.background === true && current.loadState === "ready";
  usePersonalMcpStore.setState(keepRows ? {} : { error: null, loadState: "loading" });
  const fresh = () => ownSequence === sequence && ownRevision === revision && ownGeneration === generation;
  const promise = loadPersonalMcpConnections().then(
    (connections) => {
      if (!fresh()) return usePersonalMcpStore.getState().connections;
      usePersonalMcpStore.setState({ connections, error: null, loadState: "ready" });
      return connections;
    },
    (error: unknown) => {
      if (fresh()) {
        const code = error instanceof PersonalMcpApiError ? error.code : "mcp_request_failed";
        usePersonalMcpStore.setState(keepRows ? { error: code } : { connections: [], error: code, loadState: "error" });
      }
      throw error;
    }
  ).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
    if (ownGeneration === generation) syncPolling();
  });
  inFlight = { generation: ownGeneration, promise, revision: ownRevision };
  return promise;
}

/** First read for a consumer (the shell); later reads come from Settings, mutations and OAuth returns. */
export function ensurePersonalMcpLoaded(): void {
  if (usePersonalMcpStore.getState().loadState === "idle") void refreshPersonalMcp().catch(() => undefined);
}

function mutate(update: (connections: PersonalMcpConnection[]) => PersonalMcpConnection[]): void {
  revision += 1;
  usePersonalMcpStore.setState((state) => ({
    connections: update(state.connections),
    ...(state.loadState === "ready" ? {} : { error: null, loadState: "ready" as const })
  }));
  syncPolling(true);
}

/** Applies a server-confirmed row (create, toggle, credential replacement). */
export function applyPersonalMcpConnection(connection: PersonalMcpConnection): void {
  mutate((connections) => connections.some((item) => item.id === connection.id)
    ? connections.map((item) => item.id === connection.id ? connection : item)
    : [connection, ...connections]);
}

export function removePersonalMcpConnection(connectionId: string): void {
  mutate((connections) => connections.filter((item) => item.id !== connectionId));
}

export function setPersonalMcpOAuthOutcome(oauthOutcome: McpOAuthOutcome | null): void {
  usePersonalMcpStore.setState({ oauthOutcome });
}

function stopPolling(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  pollAttempt = 0;
}

function syncPolling(reset = false): void {
  if (!observers || !personalMcpNeedsPolling(usePersonalMcpStore.getState().connections)) {
    stopPolling();
    return;
  }
  if (reset) stopPolling();
  if (pollTimer !== null || inFlight) return;
  const delay = pollDelaysMs[Math.min(pollAttempt, pollDelaysMs.length - 1)]!;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    pollAttempt += 1;
    void refreshPersonalMcp({ background: true }).catch(() => undefined);
  }, delay);
}

function resumeVisiblePolling(): void {
  if (document.visibilityState === "visible") syncPolling();
}

/**
 * Settings observes readiness while it is open: fast reads at first, then
 * backing off, only while an enabled connection is still starting. Reads
 * never wake a runtime; closing Settings stops them.
 */
export function observePersonalMcpReadiness(): () => void {
  observers += 1;
  if (observers === 1 && typeof document !== "undefined") document.addEventListener("visibilitychange", resumeVisiblePolling);
  syncPolling(true);
  return () => {
    observers = Math.max(0, observers - 1);
    if (!observers) {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resumeVisiblePolling);
      stopPolling();
    }
  };
}

/** Account change or sign-out: forget rows, outcomes, reads and timers. */
export function deactivatePersonalMcp(): void {
  generation += 1;
  revision += 1;
  inFlight = null;
  stopPolling();
  usePersonalMcpStore.setState({ ...initialState });
}

import {
  PROXY_ADDRESS_FAILURE_CODES, PROXY_CONNECTION_FAILURE_CODES, PROXY_LIMITS,
  type ProxyAddressFailureCode, type ProxyConnectionFailureCode, type ProxyRunPlan, type ProxySelectionFailureCode
} from "../../contracts/proxies";
import { EMPTY_PROXY_ROTATION_STATE, proxiesToTry, recordProxyFailure, selectProxy, type ProxyExplicitChoice } from "../../domain/proxySelection";
import type { RunProxies, RunProxyConnection, RunProxyConnections } from "../proxies/runProxies";

export type FetchUrlProxyFailure = ProxyAddressFailureCode | ProxyConnectionFailureCode | ProxySelectionFailureCode | "proxy_unavailable";
export type FetchUrlProxyIdentity = Readonly<{ id: string; name: string }>;
export type FetchUrlProxyObservation = Readonly<{
  proxyName: string;
  outcome: "started" | "read" | "failed";
  code?: string;
}>;
export type FetchUrlProxyDeps = Readonly<{
  proxyPlan?: ProxyRunPlan;
  runProxies?: RunProxies;
  userId?: string;
  /** Content-free activity/telemetry hook. Never receives a connection, URL, socket error or body. */
  observeProxy?: (event: FetchUrlProxyObservation) => void;
}>;

export function isFetchUrlProxyFailure(code: string): code is FetchUrlProxyFailure {
  return [...PROXY_ADDRESS_FAILURE_CODES, ...PROXY_CONNECTION_FAILURE_CODES,
    "proxy_all_failed", "proxy_inactive", "proxy_not_found", "proxy_unavailable"].includes(code);
}

export function fetchUrlProxyChoice(value: unknown): ProxyExplicitChoice | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > PROXY_LIMITS.nameMaxLength || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value.toLowerCase() === "direct" ? { kind: "direct" } : { kind: "proxy", ref: value };
}

export function fetchUrlProxyIdentity(value: unknown): FetchUrlProxyIdentity | undefined {
  if (typeof value !== "object" || value === null || !("id" in value) || !("name" in value)) return undefined;
  if (typeof value.id !== "string" || !value.id || value.id.length > 256 ||
    typeof value.name !== "string" || !value.name.trim() || value.name.length > PROXY_LIMITS.nameMaxLength ||
    /[\u0000-\u001f\u007f]/u.test(value.name)) return undefined;
  return { id: value.id, name: value.name };
}

export type FetchUrlRoute = Readonly<
  | { kind: "direct" }
  | { kind: "proxy"; connection: RunProxyConnection }
  | { kind: "failed"; code: FetchUrlProxyFailure; proxy?: FetchUrlProxyIdentity }
>;

/** All agents of one answer share this rotation; explicit choices never mutate it. */
export function createFetchUrlProxySession(deps: FetchUrlProxyDeps) {
  let state = EMPTY_PROXY_ROTATION_STATE;
  const entries = deps.proxyPlan?.entries ?? [];
  const observe = (event: FetchUrlProxyObservation) => {
    try { deps.observeProxy?.(event); } catch { /* Bookkeeping never gates a read. */ }
  };
  return {
    observe,
    suggestions(url: string): string[] {
      return proxiesToTry(entries, new URL(url).hostname).flatMap((id) => {
        const entry = entries.find((candidate) => candidate.id === id);
        return entry ? [entry.name] : [];
      });
    },
    async routes(url: string, explicit?: ProxyExplicitChoice) {
      const host = new URL(url).hostname;
      let loaded: RunProxyConnections | undefined;
      // Direct/no-match reads never need credentials or the store.
      const initial = selectProxy({ entries, explicit, host, state }).selection;
      if (initial.kind === "proxy") {
        if (deps.proxyPlan && deps.runProxies && deps.userId) {
          try { loaded = await deps.runProxies.load({ plan: deps.proxyPlan, userId: deps.userId }); }
          catch { /* A failed store is unavailable, never a direct fallback or a raw exception. */ }
        }
        loaded ??= { connections: [], unavailable: entries.filter((entry) => entry.active)
          .map(({ id, name }) => ({ code: "proxy_unavailable", id, name })) };
      }
      const unavailable = loaded?.unavailable ?? [];
      const failedHere = new Set<string>();
      return {
        next(): FetchUrlRoute {
          if (!explicit) {
            for (const id of [...unavailable.map((entry) => entry.id), ...failedHere]) state = recordProxyFailure({ host, proxyId: id, state });
          }
          const chosen = selectProxy({ entries, explicit, host, state });
          state = chosen.state;
          if (chosen.selection.kind === "failed") {
            const entry = entries.find((candidate) => chosen.selection.kind === "failed" && chosen.selection.tried.includes(candidate.id));
            return { ...chosen.selection, ...(entry ? { proxy: { id: entry.id, name: entry.name } } : {}) };
          }
          if (chosen.selection.kind === "direct") return chosen.selection;
          const id = chosen.selection.proxyId;
          const connection = loaded?.connections.find((entry) => entry.id === id);
          if (connection) return { connection, kind: "proxy" };
          const entry = entries.find((candidate) => candidate.id === id);
          return { code: "proxy_unavailable", kind: "failed", ...(entry ? { proxy: { id, name: entry.name } } : {}) };
        },
        failed(proxyId: string) {
          if (!explicit) {
            failedHere.add(proxyId);
            state = recordProxyFailure({ host, proxyId, state });
          }
        }
      };
    }
  };
}

/** Legacy reads are direct; an explicit and implicit read of the same proxy share a result. */
export const fetchUrlCacheKey = (url: string, proxy?: FetchUrlProxyIdentity) => JSON.stringify([url, proxy?.id ?? null]);

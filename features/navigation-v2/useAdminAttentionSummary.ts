"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  requestAdminAttentionSummary,
  type AdminAttentionSummaryResult
} from "@/components/admin/adminAttentionApi";
import type { AdminAttentionSummary } from "@/lib/contracts/adminAttention";

/** The badge refreshes this often while the tab is visible. */
export const ADMIN_ATTENTION_SUMMARY_POLL_MS = 5 * 60_000;

export type AdminAttentionSummaryStore = Readonly<{
  getSnapshot(): AdminAttentionSummary | null;
  subscribe(listener: () => void): () => void;
}>;

/**
 * One shared poller for every Control Center entry of the shell. It requests
 * only while an administrator's entry is mounted, only while the tab is
 * visible, and stops for the page's lifetime once the server says the viewer
 * is not an administrator.
 */
export function createAdminAttentionSummaryStore(input: Readonly<{
  now?: () => number;
  pollMs?: number;
  request?: () => Promise<AdminAttentionSummaryResult>;
}> = {}): AdminAttentionSummaryStore {
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? ADMIN_ATTENTION_SUMMARY_POLL_MS;
  const request = input.request ?? (() => requestAdminAttentionSummary());
  const listeners = new Set<() => void>();
  let snapshot: AdminAttentionSummary | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let denied = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const publish = (next: AdminAttentionSummary | null) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const refresh = async (force: boolean) => {
    if (denied || inFlight || listeners.size === 0 || document.visibilityState === "hidden") return;
    if (!force && now() - lastRequestAt < pollMs) return;
    inFlight = true;
    lastRequestAt = now();
    try {
      const result = await request().catch(() => null);
      if (result?.ok) {
        publish(result.summary);
      } else if (result && (result.error === "forbidden" || result.error === "unauthorized")) {
        denied = true;
        publish(null);
      }
      // A failed read keeps the last counts until the next poll.
    } finally {
      inFlight = false;
    }
  };

  const onVisibility = () => void refresh(false);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        document.addEventListener("visibilitychange", onVisibility);
        timer = setInterval(() => void refresh(true), pollMs);
        void refresh(false);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        document.removeEventListener("visibilitychange", onVisibility);
        if (timer !== null) clearInterval(timer);
        timer = null;
      };
    }
  };
}

const sharedStore = createAdminAttentionSummaryStore();
const noSubscription = () => () => undefined;
const noSummary = () => null;

/**
 * Severity counts for the Control Center entry. `enabled` is the viewer's
 * administrator entry flag: without it nothing is requested.
 */
export function useAdminAttentionSummary(
  enabled: boolean,
  store: AdminAttentionSummaryStore = sharedStore
): AdminAttentionSummary | null {
  const subscribe = useCallback(
    (listener: () => void) => enabled ? store.subscribe(listener) : noSubscription(),
    [enabled, store]
  );
  return useSyncExternalStore(subscribe, enabled ? store.getSnapshot : noSummary, noSummary);
}

export type AdminAttentionIndicator = Readonly<{ count: number; label: string; severity: "bad" | "warn" }>;

/** What an entry shows: the worst severity and the number of bad and warning items. */
export function adminAttentionIndicator(summary: AdminAttentionSummary | null): AdminAttentionIndicator | null {
  if (!summary) return null;
  const count = summary.bad + summary.warn;
  if (count === 0) return null;
  return {
    count,
    label: `${count} ${count === 1 ? "item needs" : "items need"} attention`,
    severity: summary.bad > 0 ? "bad" : "warn"
  };
}

"use client";

import { shellFetch } from "@/components/app-shell/shellApi";
import { usageLimitNextChange } from "@/components/app-shell/usageLimitStatus";
import { decodeUserUsageLimitStatusResponse, type UserUsageLimitStatus } from "@/lib/contracts/usageLimits";
import { useCallback, useEffect, useRef, useState } from "react";

export type UsageLimitStatusLoader = (signal: AbortSignal) => Promise<UserUsageLimitStatus>;

export type UsageLimitStatusState =
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; status: UserUsageLimitStatus }>;

/** Focus can fire in bursts (window, iframe, devtools); one read follows the last. */
export const USAGE_LIMIT_FOCUS_DEBOUNCE_MS = 750;
// Browsers clamp longer timers; a month reset that far out waits for focus or a settled run.
const MAX_TIMER_MS = 2_147_483_647;

export async function loadUserUsageLimitStatus(signal: AbortSignal): Promise<UserUsageLimitStatus> {
  const response = await shellFetch("/api/me/usage-limits", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`usage_limits_failed_${response.status}`);
  const decoded = decodeUserUsageLimitStatusResponse(await response.json().catch(() => null));
  if (!decoded) throw new Error("usage_limits_malformed");
  return decoded.usageLimits;
}

const LOADING: UsageLimitStatusState = { kind: "loading" };

/**
 * The signed-in user's own limit status, read when `scopeKey` appears or
 * changes, when `busy` turns false (a send or run settled), on window focus
 * (debounced) and when a reached limit frees up. Responses for a previous key
 * or an older read are ignored; a failed read is `failed`, never guessed.
 * A `null` key reads nothing.
 */
export function useUsageLimitStatus(input: Readonly<{
  busy?: boolean;
  load?: UsageLimitStatusLoader;
  scopeKey: string | null;
}>): Readonly<{ refresh(): void; state: UsageLimitStatusState }> {
  const { busy = false, load = loadUserUsageLimitStatus, scopeKey } = input;
  const [entry, setEntry] = useState<Readonly<{ key: string; state: UsageLimitStatusState }> | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (scopeKey === null) return;
    const read = ++sequence.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    load(controller.signal).then(
      (status) => {
        if (read === sequence.current) setEntry({ key: scopeKey, state: { kind: "ready", status } });
      },
      () => {
        if (read === sequence.current && !controller.signal.aborted) {
          setEntry({ key: scopeKey, state: { kind: "failed" } });
        }
      }
    );
  }, [load, scopeKey]);

  useEffect(() => {
    refresh();
    return () => {
      // Unmount or a new key: drop whatever is still in flight.
      sequence.current += 1;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [refresh]);

  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  useEffect(() => {
    if (scopeKey === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, USAGE_LIMIT_FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearTimeout(timer);
    };
  }, [refresh, scopeKey]);

  const state = scopeKey !== null && entry?.key === scopeKey ? entry.state : LOADING;
  const nextChange = state.kind === "ready" ? usageLimitNextChange(state.status) : null;
  useEffect(() => {
    if (nextChange === null) return;
    const delay = Math.max(0, Date.parse(nextChange) - Date.now()) + 1000;
    if (delay > MAX_TIMER_MS) return;
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [nextChange, refresh]);

  return { refresh, state };
}

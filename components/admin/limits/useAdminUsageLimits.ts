"use client";

import {
  removeUserUsageLimits,
  requestAdminUsageLimits,
  saveGroupUsageLimits,
  saveInstallationUsageLimits,
  saveUserUsageLimits,
  type AdminUsageLimitsResult
} from "@/components/admin/limits/adminUsageLimitsApi";
import type {
  AdminUsageGroupLimitsInput,
  AdminUsageInstallationLimitsInput,
  AdminUsageLimits,
  AdminUsageUserLimitsInput
} from "@/lib/contracts/usageLimits";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminUsageLimitsOutcome = Readonly<{ ok: true }> | Readonly<{ error: string; ok: false }>;

export type AdminUsageLimitsController = Readonly<{
  busy: boolean;
  limits: AdminUsageLimits | null;
  /** Error code of the last failed read; `limits` keeps the last good view. */
  loadError: string | null;
  loading: boolean;
  refresh(): Promise<void>;
  removeUser(userId: string, expectedVersion: number | null): Promise<AdminUsageLimitsOutcome>;
  saveGroup(groupId: string, input: AdminUsageGroupLimitsInput): Promise<AdminUsageLimitsOutcome>;
  saveInstallation(input: AdminUsageInstallationLimitsInput): Promise<AdminUsageLimitsOutcome>;
  saveUser(userId: string, input: AdminUsageUserLimitsInput): Promise<AdminUsageLimitsOutcome>;
}>;

export type UseAdminUsageLimitsOptions = Readonly<{
  /** Spend and message counts move on their own; reread while the page is visible. */
  pollMs?: number;
}>;

/**
 * The one owner of the Budgets & limits view: the server's last answer plus
 * one busy flag. Mutations replace the view with the server's answer; a read
 * that started before a mutation never overwrites it.
 */
export function useAdminUsageLimits({ pollMs = 30_000 }: UseAdminUsageLimitsOptions = {}): AdminUsageLimitsController {
  const [limits, setLimits] = useState<AdminUsageLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pendingRead = useRef<AbortController | null>(null);
  const mutating = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current || mutating.current || pendingRead.current) return;
    const current = ++generation.current;
    const controller = new AbortController();
    pendingRead.current = controller;
    const result = await requestAdminUsageLimits(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    if (pendingRead.current === controller) pendingRead.current = null;
    if (!mounted.current || current !== generation.current) return;
    setLoading(false);
    if (result.ok) {
      setLimits(result.limits);
      setLoadError(null);
    } else {
      setLoadError(result.error);
      if (result.error === "forbidden" || result.error === "unauthorized") setLimits(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    queueMicrotask(() => { void refresh(); });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, pollMs);
    return () => {
      mounted.current = false;
      generation.current += 1;
      pendingRead.current?.abort();
      pendingRead.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [pollMs, refresh]);

  const mutate = useCallback(async (operation: () => Promise<AdminUsageLimitsResult>): Promise<AdminUsageLimitsOutcome> => {
    if (mutating.current) return { error: "busy", ok: false };
    mutating.current = true;
    generation.current += 1;
    pendingRead.current?.abort();
    pendingRead.current = null;
    setBusy(true);
    try {
      const result = await operation();
      if (!mounted.current) return { error: "unmounted", ok: false };
      generation.current += 1;
      if (!result.ok) return { error: result.error, ok: false };
      setLimits(result.limits);
      setLoadError(null);
      setLoading(false);
      return { ok: true };
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return useMemo(() => ({
    busy,
    limits,
    loadError,
    loading,
    refresh,
    removeUser: (userId: string, expectedVersion: number | null) => mutate(() => removeUserUsageLimits(userId, expectedVersion)),
    saveGroup: (groupId: string, input: AdminUsageGroupLimitsInput) => mutate(() => saveGroupUsageLimits(groupId, input)),
    saveInstallation: (input: AdminUsageInstallationLimitsInput) => mutate(() => saveInstallationUsageLimits(input)),
    saveUser: (userId: string, input: AdminUsageUserLimitsInput) => mutate(() => saveUserUsageLimits(userId, input))
  }), [busy, limits, loadError, loading, mutate, refresh]);
}

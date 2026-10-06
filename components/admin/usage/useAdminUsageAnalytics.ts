"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminUsageAnalytics, AdminUsagePeriod } from "@/lib/contracts/adminUsageAnalytics";
import { requestAdminUsageAnalytics } from "./adminUsageApi";

type Settled = Readonly<{
  /** Last successful analytics, kept visible while a newer request runs. */
  data: AdminUsageAnalytics | null;
  error: string | null;
  key: string | null;
}>;

export type AdminUsageAnalyticsState = Readonly<{
  data: AdminUsageAnalytics | null;
  error: string | null;
  /** No settled response exists for the current request yet. */
  pending: boolean;
  retry(): void;
}>;

/**
 * One analytics request per period, time zone and retry. A newer request
 * aborts the stale one; the previous data stays visible while it runs and a
 * failure is reported instead of being shown as an empty period.
 */
export function useAdminUsageAnalytics(period: AdminUsagePeriod, timeZone: string): AdminUsageAnalyticsState {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled>({ data: null, error: null, key: null });
  const key = `${period}\u0000${timeZone}\u0000${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    requestAdminUsageAnalytics({ period, signal: controller.signal, timeZone }).then((result) => {
      if (controller.signal.aborted) return;
      setSettled((current) => result.ok
        ? { data: result.usage, error: null, key }
        : { data: current.data, error: result.error, key });
    }, () => undefined);
    return () => controller.abort();
  }, [key, period, timeZone]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const pending = settled.key !== key;
  return { data: settled.data, error: pending ? null : settled.error, pending, retry };
}

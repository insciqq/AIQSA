import type { AdminHealthRequestError } from "@/components/admin/health/adminHealthApi";
import type { AdminHealthRange } from "@/lib/contracts/adminHealth";
import {
  decodeAdminHealthProblemReportsResponse,
  type AdminHealthProblemReports
} from "@/lib/contracts/adminHealthProblemReports";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminHealthProblemReportsResult =
  | Readonly<{ ok: true; page: AdminHealthProblemReports }>
  | Readonly<{ error: AdminHealthRequestError; ok: false }>;

/** `unavailable` covers a failed read, a malformed response and the network. */
export async function requestAdminHealthProblemReports(
  range: AdminHealthRange,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<AdminHealthProblemReportsResult> {
  try {
    const response = await fetcher(`/api/admin/health/problem-reports?range=${encodeURIComponent(range)}`, { method: "GET", signal });
    const data: unknown = await response.json().catch(() => null);
    if (response.status === 401) return { error: "unauthorized", ok: false };
    if (response.status === 403) return { error: "forbidden", ok: false };
    if (response.status === 400) return { error: "invalid", ok: false };
    if (!response.ok) return { error: "unavailable", ok: false };
    const decoded = decodeAdminHealthProblemReportsResponse(data);
    return decoded ? { ok: true, page: decoded.problemReports } : { error: "unavailable", ok: false };
  } catch {
    return { error: "unavailable", ok: false };
  }
}

export type AdminHealthProblemReportsController = Readonly<{
  page: AdminHealthProblemReports | null;
  /** Nothing for this range has loaded yet. */
  loading: boolean;
  /** The last read failed; `page` (when present) is the previous result for this range. */
  error: AdminHealthRequestError | null;
  refresh(): void;
}>;

/**
 * Problem reports for one range. A range change drops the other range's list;
 * a refresh keeps the shown list until the new one arrives, and a late
 * response from an older request is ignored.
 */
export function useAdminHealthProblemReports(
  range: AdminHealthRange,
  request: (range: AdminHealthRange, signal?: AbortSignal) => Promise<AdminHealthProblemReportsResult> = requestAdminHealthProblemReports
): AdminHealthProblemReportsController {
  const [state, setState] = useState<{
    range: AdminHealthRange; page: AdminHealthProblemReports | null; error: AdminHealthRequestError | null; pending: boolean;
  }>({ range, page: null, error: null, pending: true });
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  const load = useCallback((target: AdminHealthRange) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    void requestRef.current(target, controller.signal).catch(() => ({ error: "unavailable" as const, ok: false as const }))
      .then((result) => {
        if (sequence !== sequenceRef.current) return;
        setState((current) => result.ok
          ? { range: target, page: result.page, error: null, pending: false }
          : current.range === target
            ? { ...current, error: result.error, pending: false }
            : { range: target, page: null, error: result.error, pending: false });
      });
  }, []);

  useEffect(() => {
    load(range);
    return () => {
      sequenceRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load, range]);

  const refresh = useCallback(() => {
    setState((current) => current.range === range ? { ...current, pending: true } : current);
    load(range);
  }, [load, range]);
  const current = state.range === range;
  return useMemo(() => ({
    page: current ? state.page : null,
    loading: !current || state.pending && state.page === null,
    error: current && !state.pending ? state.error : null,
    refresh
  }), [current, refresh, state]);
}

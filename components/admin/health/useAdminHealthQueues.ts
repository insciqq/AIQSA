import type { AdminHealthRequestError } from "@/components/admin/health/adminHealthApi";
import { decodeAdminHealthQueuesResponse, type AdminHealthQueues } from "@/lib/contracts/adminHealthQueues";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminHealthQueuesResult =
  | Readonly<{ ok: true; queues: AdminHealthQueues }>
  | Readonly<{ error: AdminHealthRequestError; ok: false }>;

/** `unavailable` covers a failed read, a malformed response and the network. */
export async function requestAdminHealthQueues(signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<AdminHealthQueuesResult> {
  try {
    const response = await fetcher("/api/admin/health/queues", { method: "GET", signal });
    const data: unknown = await response.json().catch(() => null);
    if (response.status === 401) return { error: "unauthorized", ok: false };
    if (response.status === 403) return { error: "forbidden", ok: false };
    if (!response.ok) return { error: "unavailable", ok: false };
    const decoded = decodeAdminHealthQueuesResponse(data);
    return decoded ? { ok: true, queues: decoded.queues } : { error: "unavailable", ok: false };
  } catch {
    return { error: "unavailable", ok: false };
  }
}

export type AdminHealthQueuesController = Readonly<{
  queues: AdminHealthQueues | null;
  /** Nothing has loaded yet. */
  loading: boolean;
  refreshing: boolean;
  /** The last read failed; `queues` (when present) is the previous snapshot. */
  error: AdminHealthRequestError | null;
  refresh(): void;
}>;

/**
 * The current queue snapshot. A refresh keeps the shown snapshot until the new
 * one arrives; a late response from an older request is ignored.
 */
export function useAdminHealthQueues(
  request: (signal?: AbortSignal) => Promise<AdminHealthQueuesResult> = requestAdminHealthQueues
): AdminHealthQueuesController {
  const [state, setState] = useState<{ queues: AdminHealthQueues | null; error: AdminHealthRequestError | null; pending: boolean }>(
    { queues: null, error: null, pending: true });
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  const load = useCallback(() => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    void requestRef.current(controller.signal).catch(() => ({ error: "unavailable" as const, ok: false as const }))
      .then((result) => {
        if (sequence !== sequenceRef.current) return;
        setState((current) => result.ok
          ? { queues: result.queues, error: null, pending: false }
          : { ...current, error: result.error, pending: false });
      });
  }, []);

  useEffect(() => {
    load();
    return () => {
      sequenceRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, pending: true }));
    load();
  }, [load]);

  return useMemo(() => ({
    queues: state.queues,
    loading: state.pending && state.queues === null,
    refreshing: state.pending && state.queues !== null,
    error: state.pending ? null : state.error,
    refresh
  }), [refresh, state]);
}

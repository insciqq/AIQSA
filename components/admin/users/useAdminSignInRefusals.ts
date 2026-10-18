"use client";

import {
  decodeAdminSignInRefusalsResponse,
  type AdminSignInRefusals
} from "@/lib/contracts/adminSignInRefusals";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminSignInRefusalsRequestError = "forbidden" | "unauthorized" | "unavailable";

export type AdminSignInRefusalsResult =
  | Readonly<{ ok: true; page: AdminSignInRefusals }>
  | Readonly<{ error: AdminSignInRefusalsRequestError; ok: false }>;

export type AdminSignInRefusalsRequest = (signal?: AbortSignal) => Promise<AdminSignInRefusalsResult>;

export const ADMIN_SIGN_IN_REFUSALS_URL = "/api/admin/sign-in/refusals";

/** `unavailable` covers a failed read, a malformed response and the network. */
export async function requestAdminSignInRefusals(
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<AdminSignInRefusalsResult> {
  try {
    const response = await fetcher(ADMIN_SIGN_IN_REFUSALS_URL, { method: "GET", signal });
    const data: unknown = await response.json().catch(() => null);
    if (response.status === 401) return { error: "unauthorized", ok: false };
    if (response.status === 403) return { error: "forbidden", ok: false };
    if (!response.ok) return { error: "unavailable", ok: false };
    const decoded = decodeAdminSignInRefusalsResponse(data);
    return decoded ? { ok: true, page: decoded.signInRefusals } : { error: "unavailable", ok: false };
  } catch {
    return { error: "unavailable", ok: false };
  }
}

export type AdminSignInRefusalsController = Readonly<{
  page: AdminSignInRefusals | null;
  /** Nothing has loaded yet. */
  loading: boolean;
  /** The last read failed; `page` (when present) is the previous result. */
  error: AdminSignInRefusalsRequestError | null;
  refresh(): void;
}>;

/**
 * The refused sign-ins of the last 30 days, read once per mount. A retry keeps the shown list
 * until the new one arrives, and a late response from an older request is ignored.
 */
export function useAdminSignInRefusals(
  request: AdminSignInRefusalsRequest = requestAdminSignInRefusals
): AdminSignInRefusalsController {
  const [state, setState] = useState<{
    error: AdminSignInRefusalsRequestError | null; page: AdminSignInRefusals | null; pending: boolean;
  }>({ error: null, page: null, pending: true });
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
          ? { error: null, page: result.page, pending: false }
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
    error: state.pending ? null : state.error,
    loading: state.pending && state.page === null,
    page: state.page,
    refresh
  }), [refresh, state]);
}

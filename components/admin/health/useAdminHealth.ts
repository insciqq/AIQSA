import {
  requestAdminHealth,
  requestAdminHealthIncidents,
  type AdminHealthIncidentsResult,
  type AdminHealthRequestError,
  type AdminHealthResult
} from "@/components/admin/health/adminHealthApi";
import type {
  AdminHealth,
  AdminHealthIncident,
  AdminHealthIncidentFilters,
  AdminHealthRange
} from "@/lib/contracts/adminHealth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminHealthController = Readonly<{
  health: AdminHealth | null;
  /** Nothing for this range has loaded yet. */
  loading: boolean;
  refreshing: boolean;
  /** The last read failed; `health` (when present) is the previous result for this range. */
  error: AdminHealthRequestError | null;
  refresh(): void;
}>;

/**
 * Health data for one range. A range change discards the other range's data
 * and aborts its request; a refresh keeps the current view until the new
 * result arrives, and a late response from an older request is ignored.
 */
export function useAdminHealth(
  range: AdminHealthRange,
  request: (range: AdminHealthRange, signal?: AbortSignal) => Promise<AdminHealthResult> = requestAdminHealth
): AdminHealthController {
  const [state, setState] = useState<{ range: AdminHealthRange; health: AdminHealth | null; error: AdminHealthRequestError | null; pending: boolean }>(
    { range, health: null, error: null, pending: true });
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  // State changes only when a result settles; a range still loading is derived
  // from `state.range` differing from the requested range.
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
          ? { range: target, health: result.health, error: null, pending: false }
          : current.range === target
            ? { ...current, error: result.error, pending: false }
            : { range: target, health: null, error: result.error, pending: false });
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
    health: current ? state.health : null,
    loading: !current || state.pending && state.health === null,
    refreshing: current && state.pending && state.health !== null,
    error: current && !state.pending ? state.error : null,
    refresh
  }), [current, refresh, state]);
}

export type AdminHealthIncidentsController = Readonly<{
  items: readonly AdminHealthIncident[];
  loading: boolean;
  loadingMore: boolean;
  error: AdminHealthRequestError | null;
  /** A "Load more" failure keeps the loaded items. */
  moreError: AdminHealthRequestError | null;
  hasMore: boolean;
  loadMore(): void;
  refresh(): void;
}>;

type IncidentsState = {
  key: string;
  items: AdminHealthIncident[];
  nextCursor: string | null;
  error: AdminHealthRequestError | null;
  moreError: AdminHealthRequestError | null;
  loading: boolean;
  loadingMore: boolean;
};

/** Newest-first incidents for one filter set; a filter change starts a new list. */
export function useAdminHealthIncidents(
  filters: Omit<AdminHealthIncidentFilters, "cursor">,
  request: (filters: AdminHealthIncidentFilters, signal?: AbortSignal) => Promise<AdminHealthIncidentsResult> = requestAdminHealthIncidents
): AdminHealthIncidentsController {
  const key = JSON.stringify([filters.range, filters.category, filters.event, filters.code, filters.level, filters.q]);
  const [state, setState] = useState<IncidentsState>({ key, items: [], nextCursor: null, error: null, moreError: null, loading: true, loadingMore: false });
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  const stateRef = useRef(state);
  const requestRef = useRef(request);
  // Declared before the loading effect so a filter change loads with the new filters.
  useEffect(() => {
    filtersRef.current = filters;
    stateRef.current = state;
    requestRef.current = request;
  });

  // State changes only when a page settles or from an explicit action; a new
  // filter set still loading is derived from `state.key` differing from `key`.
  const fetchPage = useCallback((pageKey: string, cursor: string | null) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const more = cursor !== null;
    void requestRef.current({ ...filtersRef.current, cursor }, controller.signal)
      .catch(() => ({ error: "unavailable" as const, ok: false as const }))
      .then((result) => {
        if (sequence !== sequenceRef.current) return;
        setState((current) => {
          if (!result.ok) {
            return more ? { ...current, loadingMore: false, moreError: result.error }
              : { key: pageKey, items: [], nextCursor: null, loading: false, loadingMore: false, error: result.error, moreError: null };
          }
          const seen = new Set(more ? current.items.map((item) => item.id) : []);
          const items = more ? [...current.items, ...result.page.incidents.filter((item) => !seen.has(item.id))] : result.page.incidents;
          return { key: pageKey, items, nextCursor: result.page.nextCursor, error: null, moreError: null, loading: false, loadingMore: false };
        });
      });
  }, []);

  useEffect(() => {
    fetchPage(key, null);
    return () => {
      sequenceRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [fetchPage, key]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.key !== key || current.loading || current.loadingMore || current.nextCursor === null) return;
    setState((value) => ({ ...value, loadingMore: true, moreError: null }));
    fetchPage(key, current.nextCursor);
  }, [fetchPage, key]);
  const refresh = useCallback(() => {
    setState((value) => value.key === key ? { ...value, loading: true, loadingMore: false, error: null, moreError: null } : value);
    fetchPage(key, null);
  }, [fetchPage, key]);

  const current = state.key === key;
  return useMemo(() => ({
    items: current ? state.items : [],
    loading: !current || state.loading,
    loadingMore: current && state.loadingMore,
    error: current ? state.error : null,
    moreError: current ? state.moreError : null,
    hasMore: current && state.nextCursor !== null,
    loadMore,
    refresh
  }), [current, loadMore, refresh, state]);
}

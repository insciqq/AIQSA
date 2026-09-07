"use client";

import {
  adminSearchErrorMessage,
  createAdminSearchIntegration,
  requestAdminSearchCatalog,
  runAdminSearchAction,
  saveAndCheckAdminSearchIntegration,
  updateAdminSearchPolicy,
  type AdminSearchApiResult
} from "@/components/admin/adminSearchApi";
import type { AdminSearchCatalog, AdminSearchDraft } from "@/lib/contracts/adminSearch";
import type { SearchPlan } from "@/lib/domain/search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminSearchMutationResult =
  | Readonly<{ ok: true; selectedIntegrationId?: string }>
  | Readonly<{ message: string; ok: false }>;

export type AdminSearchSourceInput = Readonly<{
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
}>;

export type AdminSearchController = Readonly<{
  actions: Readonly<{
    /** Archives after the shared confirmation; the caller navigates away. */
    archive(id: string): Promise<boolean>;
    /** Creates a manual source and runs its check as one server operation. */
    create(input: AdminSearchSourceInput): Promise<AdminSearchMutationResult>;
    refresh(): Promise<void>;
    runCheck(id: string): Promise<boolean>;
    /** Saves the configuration and runs the live check as one server operation (PRD B7). */
    saveAndCheck(
      input: AdminSearchSourceInput & Readonly<{ expectedDraftVersion: number; id: string }>
    ): Promise<AdminSearchMutationResult>;
    /** Returns the error message to show in the plan card, or null. */
    savePolicy(defaultPlan: SearchPlan, expectedVersion: number): Promise<string | null>;
    setEnabled(id: string, enabled: boolean): Promise<boolean>;
  }>;
  state: Readonly<{
    busy: boolean;
    catalog: AdminSearchCatalog | null;
    error: string | null;
    loaded: boolean;
    loading: boolean;
  }>;
}>;

export type AdminSearchControllerOptions = Readonly<{
  onError(message: string): void;
  onMutationCommitted?(): void | Promise<unknown>;
  onNotice(message: string): void;
}>;

/**
 * The one state owner of the Search page: the catalog the server returned
 * last, one busy flag, and mutations that always replace the catalog with the
 * server's answer. Form-level errors go back to the caller; whole-action
 * outcomes go to the shared feedback host.
 */
export function useAdminSearchController(
  active: boolean,
  { onError, onMutationCommitted, onNotice }: AdminSearchControllerOptions
): AdminSearchController {
  const [catalog, setCatalog] = useState<AdminSearchCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(active);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback((result: AdminSearchApiResult) => {
    setLoading(false);
    setLoaded(true);
    if (!result.ok) {
      setError(adminSearchErrorMessage(result.error));
      return;
    }
    setError(null);
    setCatalog(result.search);
  }, []);

  // The first load relies on the initial `loading` state and applies the
  // answer from the response callback; a later refresh flips loading on first.
  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    void requestAdminSearchCatalog().then((result) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      apply(result);
    });
  }, [active, apply]);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    const result = await requestAdminSearchCatalog();
    if (!mountedRef.current || generation !== generationRef.current) return;
    apply(result);
  }, [apply]);

  const commit = useCallback(async (
    operation: Promise<AdminSearchApiResult>,
    options: Readonly<{ notice?: string; toastError: boolean }>
  ): Promise<AdminSearchMutationResult> => {
    setBusy(true);
    const result = await operation;
    if (!mountedRef.current) return { message: "", ok: false };
    setBusy(false);
    if (!result.ok) {
      const message = adminSearchErrorMessage(result.error);
      if (options.toastError) onError(message);
      return { message, ok: false };
    }
    setError(null);
    setCatalog(result.search);
    if (options.notice) onNotice(options.notice);
    void onMutationCommitted?.();
    return {
      ok: true,
      ...(result.selectedIntegrationId ? { selectedIntegrationId: result.selectedIntegrationId } : {})
    };
  }, [onError, onMutationCommitted, onNotice]);

  const actions = useMemo<AdminSearchController["actions"]>(() => ({
    async archive(id) {
      const result = await commit(
        runAdminSearchAction({ action: "archive", confirmed: true, id }),
        { notice: "Search source archived.", toastError: true }
      );
      return result.ok;
    },
    create(input) {
      return commit(createAdminSearchIntegration(input), {
        notice: "Search source added and working.",
        toastError: false
      });
    },
    refresh,
    async runCheck(id) {
      const result = await commit(
        runAdminSearchAction({ action: "test", id }),
        { toastError: true }
      );
      return result.ok;
    },
    saveAndCheck(input) {
      return commit(saveAndCheckAdminSearchIntegration(input), {
        notice: "Search source saved and working.",
        toastError: false
      });
    },
    async savePolicy(defaultPlan, expectedVersion) {
      const result = await commit(
        updateAdminSearchPolicy({ defaultPlan, expectedVersion }),
        { notice: "Organization Search default saved.", toastError: false }
      );
      return result.ok ? null : result.message;
    },
    async setEnabled(id, enabled) {
      const result = await commit(
        runAdminSearchAction({ action: enabled ? "enable" : "disable", id }),
        { notice: enabled ? "Search source turned on." : "Search source turned off.", toastError: true }
      );
      return result.ok;
    }
  }), [commit, refresh]);

  return useMemo(() => ({
    actions,
    state: { busy, catalog, error, loaded, loading }
  }), [actions, busy, catalog, error, loaded, loading]);
}

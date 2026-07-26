"use client";

import type { AdminRunProfileCatalog } from "@/lib/contracts/runProfiles";
import {
  adminRunProfileErrorMessage,
  getAdminRunProfiles,
  updateAdminRunProfiles
} from "./adminRunProfilesApi";
import { useCallback, useEffect, useRef, useState } from "react";

export function useAdminRunProfilesController(active: boolean, refreshRevision = 0) {
  const [catalog, setCatalog] = useState<AdminRunProfileCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generationRef = useRef(0);
  const attemptedRef = useRef(false);
  const refreshRevisionRef = useRef(refreshRevision);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    const result = await getAdminRunProfiles();
    if (generation !== generationRef.current) return false;
    setLoading(false);
    if (!result.ok) {
      setError(adminRunProfileErrorMessage(result.error));
      return false;
    }
    setCatalog(result.data);
    return true;
  }, []);

  useEffect(() => {
    if (!active) {
      attemptedRef.current = false;
      return;
    }
    if (!catalog && !loading && !attemptedRef.current) {
      attemptedRef.current = true;
      void refresh();
    }
  }, [active, catalog, loading, refresh]);

  useEffect(() => {
    if (!active || refreshRevisionRef.current === refreshRevision) return;
    refreshRevisionRef.current = refreshRevision;
    void refresh();
  }, [active, refresh, refreshRevision]);

  const save = useCallback(async (profiles: unknown) => {
    if (busy) return false;
    const generation = ++generationRef.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminRunProfiles(profiles);
    if (generation !== generationRef.current) return false;
    setBusy(false);
    if (!result.ok) {
      setError(adminRunProfileErrorMessage(result.error));
      return false;
    }
    setCatalog(result.data);
    setNotice("Run profiles saved for future messages.");
    return true;
  }, [busy]);

  return {
    actions: {
      dismissError: () => setError(null),
      dismissNotice: () => setNotice(null),
      refresh,
      save
    },
    state: {
      busy,
      catalog,
      error,
      loading,
      notice
    }
  };
}

export type AdminRunProfilesController = ReturnType<typeof useAdminRunProfilesController>;

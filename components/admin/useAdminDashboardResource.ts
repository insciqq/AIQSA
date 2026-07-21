import {
  adminDashboardErrorMessage,
  requestAdminDashboard,
  type AdminDashboardResult
} from "@/components/admin/adminApi";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminDashboardRefreshOptions = Readonly<{
  afterReconcile?(): void;
}>;

export type AdminDashboardRefresh = (
  options?: AdminDashboardRefreshOptions
) => Promise<AdminDashboardResult>;

export type AdminDashboardResourceController = Readonly<{
  dashboard: AdminDashboard | null;
  lastLoadedAt: Date | null;
  loading: boolean;
  refresh: AdminDashboardRefresh;
}>;

type AdminDashboardResourceFeedback = Readonly<{
  clearError(): void;
  reportError(message: string): void;
}>;

export type UseAdminDashboardResourceOptions = Readonly<{
  feedback: AdminDashboardResourceFeedback;
  now?: () => Date;
  requestDashboard?: () => Promise<AdminDashboardResult>;
}>;

function currentDate() {
  return new Date();
}

export function useAdminDashboardResource({
  feedback,
  now = currentDate,
  requestDashboard = requestAdminDashboard
}: UseAdminDashboardResourceOptions): AdminDashboardResourceController {
  const { clearError, reportError } = feedback;
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const pendingReconcileCallbacksRef = useRef<Array<() => void>>([]);
  const requestSequenceRef = useRef(0);
  const dependenciesRef = useRef({ clearError, now, reportError, requestDashboard });

  useEffect(() => {
    dependenciesRef.current = { clearError, now, reportError, requestDashboard };
  }, [clearError, now, reportError, requestDashboard]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      pendingReconcileCallbacksRef.current = [];
    };
  }, []);

  const refresh = useCallback<AdminDashboardRefresh>(
    async (options = {}) => {
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      if (options.afterReconcile) {
        pendingReconcileCallbacksRef.current.push(options.afterReconcile);
      }
      if (mountedRef.current) {
        setLoading(true);
        dependenciesRef.current.clearError();
      }

      let result: AdminDashboardResult;
      try {
        result = await dependenciesRef.current.requestDashboard();
      } catch {
        result = {
          error: "network_error",
          ok: false
        };
      }

      if (!mountedRef.current || requestSequence !== requestSequenceRef.current) {
        return result;
      }

      if (result.ok) {
        dependenciesRef.current.clearError();
        setDashboard(result.dashboard);
        setLastLoadedAt(dependenciesRef.current.now());
      } else {
        dependenciesRef.current.reportError(adminDashboardErrorMessage(result.error));
      }
      setLoading(false);
      const reconcileCallbacks = pendingReconcileCallbacksRef.current;
      pendingReconcileCallbacksRef.current = [];
      reconcileCallbacks.forEach((callback) => callback());

      return result;
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      dashboard,
      lastLoadedAt,
      loading,
      refresh
    }),
    [dashboard, lastLoadedAt, loading, refresh]
  );
}

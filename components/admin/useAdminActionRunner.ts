import {
  adminActionErrorMessage,
  requestAdminAction,
  type AdminActionResult
} from "@/components/admin/adminApi";
import type {
  AdminDashboardRefresh,
  AdminDashboardRefreshOptions
} from "@/components/admin/useAdminDashboardResource";
import type { AdminActionName, AdminActionRequest } from "@/lib/contracts/admin";
import { useCallback, useMemo, useRef, useState } from "react";

export type AdminRunActionOptions = Readonly<{
  reload?: boolean;
  successNotice?: boolean;
}>;

export type AdminRunAction = (
  body: AdminActionRequest,
  successMessage: string,
  options?: AdminRunActionOptions
) => Promise<AdminActionResult>;

type AdminActionRunnerFeedback = Readonly<{
  clearAll(): void;
  reportError(message: string): void;
  reportNotice(message: string): void;
}>;

export type UseAdminActionRunnerOptions = Readonly<{
  feedback: AdminActionRunnerFeedback;
  onMutationReconciled(): void;
  refreshDashboard: AdminDashboardRefresh;
  requestAction?: (body: AdminActionRequest) => Promise<AdminActionResult>;
}>;

export type AdminActionRunnerController = Readonly<{
  runAction: AdminRunAction;
  submitting: AdminActionName | null;
}>;

export function useAdminActionRunner({
  feedback,
  onMutationReconciled,
  refreshDashboard,
  requestAction = requestAdminAction
}: UseAdminActionRunnerOptions): AdminActionRunnerController {
  const { clearAll, reportError, reportNotice } = feedback;
  const [submitting, setSubmitting] = useState<AdminActionName | null>(null);
  const activeRunsRef = useRef(new Map<number, AdminActionName>());
  const nextRunIdRef = useRef(0);

  const runAction = useCallback<AdminRunAction>(
    async (body, successMessage, options = {}) => {
      const runId = nextRunIdRef.current + 1;
      nextRunIdRef.current = runId;
      activeRunsRef.current.set(runId, body.action);
      setSubmitting(body.action);
      clearAll();

      try {
        const result = await requestAction(body);

        if (result.error) {
          reportError(adminActionErrorMessage(result.error));
          return result;
        }

        if (options.successNotice !== false) {
          reportNotice(successMessage);
        }

        if (options.reload !== false) {
          const refreshOptions: AdminDashboardRefreshOptions = {
            afterReconcile: onMutationReconciled
          };
          await refreshDashboard(refreshOptions);
        }

        return result;
      } catch {
        const result: AdminActionResult = {
          error: "network_error"
        };

        reportError(adminActionErrorMessage("network_error"));
        return result;
      } finally {
        activeRunsRef.current.delete(runId);
        let latestActiveAction: AdminActionName | null = null;
        for (const activeAction of activeRunsRef.current.values()) {
          latestActiveAction = activeAction;
        }
        setSubmitting(latestActiveAction);
      }
    },
    [clearAll, onMutationReconciled, refreshDashboard, reportError, reportNotice, requestAction]
  );

  return useMemo(
    () => ({
      runAction,
      submitting
    }),
    [runAction, submitting]
  );
}

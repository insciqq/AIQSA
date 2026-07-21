import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminDashboardResult } from "@/components/admin/adminApi";
import { useAdminFeedback } from "@/components/admin/useAdminFeedback";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAdminDashboardResource } from "./useAdminDashboardResource";

const dashboard: AdminDashboard = {
  accessRules: [],
  catalog: {
    models: [],
    providers: [],
    searchStrategies: []
  },
  groups: [],
  invites: [],
  usage: {
    byGroup: [],
    byUser: [],
    totals: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      lastUsedAt: null,
      outputTokens: 0,
      reasoningTokens: 0,
      runCount: 0,
      totalTokens: 0
    }
  },
  users: []
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function useResourceHarness(requestDashboard: () => Promise<AdminDashboardResult>, now: () => Date) {
  const feedback = useAdminFeedback();
  const resource = useAdminDashboardResource({
    feedback,
    now,
    requestDashboard
  });

  return { feedback, resource };
}

describe("useAdminDashboardResource", () => {
  it("loads the dashboard on mount and records the successful reconciliation time", async () => {
    const loadedAt = new Date("2026-07-12T12:00:00.000Z");
    const requestDashboard = vi.fn<() => Promise<AdminDashboardResult>>().mockResolvedValue({
      dashboard,
      ok: true
    });
    const { result } = renderHook(() => useResourceHarness(requestDashboard, () => loadedAt));

    expect(result.current.resource.loading).toBe(true);
    expect(result.current.resource.dashboard).toBeNull();
    await waitFor(() => expect(result.current.resource.loading).toBe(false));

    expect(result.current.resource.dashboard).toBe(dashboard);
    expect(result.current.resource.lastLoadedAt).toBe(loadedAt);
    expect(result.current.feedback.error).toBeNull();
    expect(requestDashboard).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good dashboard and notice when a later refresh fails", async () => {
    const firstLoadedAt = new Date("2026-07-12T12:00:00.000Z");
    const requestDashboard = vi
      .fn<() => Promise<AdminDashboardResult>>()
      .mockResolvedValueOnce({ dashboard, ok: true })
      .mockResolvedValueOnce({ error: "admin_dashboard_failed", ok: false });
    const afterReconcile = vi.fn();
    const { result } = renderHook(() => useResourceHarness(requestDashboard, () => firstLoadedAt));

    await waitFor(() => expect(result.current.resource.dashboard).toBe(dashboard));
    act(() => result.current.feedback.reportNotice("Action completed."));
    await act(async () => {
      await result.current.resource.refresh({ afterReconcile });
    });

    expect(result.current.resource.dashboard).toBe(dashboard);
    expect(result.current.resource.lastLoadedAt).toBe(firstLoadedAt);
    expect(result.current.feedback.notice).toBe("Action completed.");
    expect(result.current.feedback.error).toMatch(/could not be loaded/i);
    expect(afterReconcile).toHaveBeenCalledOnce();
  });

  it("ignores a late initial response after unmount", async () => {
    const request = deferred<AdminDashboardResult>();
    const clearError = vi.fn();
    const reportError = vi.fn();
    const { unmount } = renderHook(() =>
      useAdminDashboardResource({
        feedback: { clearError, reportError },
        requestDashboard: () => request.promise
      })
    );

    await waitFor(() => expect(clearError).toHaveBeenCalledOnce());
    unmount();
    request.resolve({ dashboard, ok: true });
    await act(async () => {
      await request.promise;
    });

    expect(clearError).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lets only the latest Strict Mode request reconcile resource state", async () => {
    const firstRequest = deferred<AdminDashboardResult>();
    const secondRequest = deferred<AdminDashboardResult>();
    const latestDashboard: AdminDashboard = {
      ...dashboard,
      catalog: {
        ...dashboard.catalog,
        providers: [{ id: "latest", name: "Latest provider" }]
      }
    };
    const requestDashboard = vi
      .fn<() => Promise<AdminDashboardResult>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { result } = renderHook(
      () => useResourceHarness(requestDashboard, () => new Date("2026-07-12T12:00:00.000Z")),
      { wrapper: StrictMode }
    );

    await waitFor(() => expect(requestDashboard).toHaveBeenCalledTimes(2));
    secondRequest.resolve({ dashboard: latestDashboard, ok: true });
    await act(async () => {
      await secondRequest.promise;
    });
    await waitFor(() => expect(result.current.resource.dashboard).toBe(latestDashboard));

    firstRequest.resolve({ dashboard, ok: true });
    await act(async () => {
      await firstRequest.promise;
    });
    expect(result.current.resource.dashboard).toBe(latestDashboard);
  });

  it("flushes a stale mutation focus callback after the latest overlapping refresh reconciles", async () => {
    const initialRequest = deferred<AdminDashboardResult>();
    const mutationRequest = deferred<AdminDashboardResult>();
    const manualRequest = deferred<AdminDashboardResult>();
    const requestDashboard = vi
      .fn<() => Promise<AdminDashboardResult>>()
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(mutationRequest.promise)
      .mockReturnValueOnce(manualRequest.promise);
    const { result } = renderHook(() =>
      useResourceHarness(requestDashboard, () => new Date("2026-07-12T12:00:00.000Z"))
    );
    initialRequest.resolve({ dashboard, ok: true });
    await waitFor(() => expect(result.current.resource.dashboard).toBe(dashboard));
    const afterMutationReconcile = vi.fn();

    let mutationRefresh!: Promise<AdminDashboardResult>;
    let manualRefresh!: Promise<AdminDashboardResult>;
    act(() => {
      mutationRefresh = result.current.resource.refresh({ afterReconcile: afterMutationReconcile });
      manualRefresh = result.current.resource.refresh();
    });
    mutationRequest.resolve({ dashboard, ok: true });
    await act(async () => {
      await mutationRefresh;
    });
    expect(afterMutationReconcile).not.toHaveBeenCalled();

    manualRequest.resolve({ dashboard, ok: true });
    await act(async () => {
      await manualRefresh;
    });
    expect(afterMutationReconcile).toHaveBeenCalledOnce();
  });
});

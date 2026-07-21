import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminActionResult, AdminDashboardResult } from "@/components/admin/adminApi";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
import type { AdminActionRequest } from "@/lib/contracts/admin";
import { describe, expect, it, vi } from "vitest";
import { useAdminActionRunner } from "./useAdminActionRunner";

const action: AdminActionRequest = {
  action: "disable_user",
  userId: "user-1"
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function successRefresh(): AdminDashboardRefresh {
  return async (options) => {
    options?.afterReconcile?.();
    return {
      error: "admin_dashboard_failed",
      ok: false
    } satisfies AdminDashboardResult;
  };
}

describe("useAdminActionRunner", () => {
  it("keeps the action pending through reload and preserves the reconciliation order", async () => {
    const request = deferred<AdminActionResult>();
    const events: string[] = [];
    const requestAction = vi.fn(async () => {
      events.push("request");
      return request.promise;
    });
    const refreshDashboard = vi.fn<AdminDashboardRefresh>(async (options) => {
      events.push("refresh");
      options?.afterReconcile?.();
      return { error: "admin_dashboard_failed", ok: false };
    });
    const { result } = renderHook(() =>
      useAdminActionRunner({
        feedback: {
          clearAll: () => events.push("clear"),
          reportError: () => events.push("error"),
          reportNotice: () => events.push("notice")
        },
        onMutationReconciled: () => events.push("focus"),
        refreshDashboard,
        requestAction
      })
    );

    let actionPromise!: Promise<AdminActionResult>;
    act(() => {
      actionPromise = result.current.runAction(action, "User disabled.");
    });
    expect(result.current.submitting).toBe("disable_user");
    expect(events).toEqual(["clear", "request"]);

    request.resolve({ ok: true });
    await act(async () => {
      await actionPromise;
    });

    expect(events).toEqual(["clear", "request", "notice", "refresh", "focus"]);
    expect(result.current.submitting).toBeNull();
  });

  it("keeps the latest still-active action pending when overlapping calls finish out of order", async () => {
    const firstRequest = deferred<AdminActionResult>();
    const secondRequest = deferred<AdminActionResult>();
    const requestAction = vi
      .fn<(body: AdminActionRequest) => Promise<AdminActionResult>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { result } = renderHook(() =>
      useAdminActionRunner({
        feedback: {
          clearAll: vi.fn(),
          reportError: vi.fn(),
          reportNotice: vi.fn()
        },
        onMutationReconciled: vi.fn(),
        refreshDashboard: successRefresh(),
        requestAction
      })
    );
    const archiveAction: AdminActionRequest = {
      action: "archive_group",
      groupId: "group-1"
    };
    let firstPromise!: Promise<AdminActionResult>;
    let secondPromise!: Promise<AdminActionResult>;

    act(() => {
      firstPromise = result.current.runAction(action, "User disabled.", { reload: false });
    });
    expect(result.current.submitting).toBe("disable_user");

    act(() => {
      secondPromise = result.current.runAction(archiveAction, "Group archived.", { reload: false });
    });
    expect(result.current.submitting).toBe("archive_group");

    secondRequest.resolve({ ok: true });
    await act(async () => {
      await secondPromise;
    });
    expect(result.current.submitting).toBe("disable_user");

    firstRequest.resolve({ ok: true });
    await act(async () => {
      await firstPromise;
    });
    expect(result.current.submitting).toBeNull();
    expect(requestAction).toHaveBeenNthCalledWith(1, action);
    expect(requestAction).toHaveBeenNthCalledWith(2, archiveAction);
  });

  it("maps action failures without reloading or showing a success notice", async () => {
    const clearAll = vi.fn();
    const reportError = vi.fn();
    const reportNotice = vi.fn();
    const refreshDashboard = vi.fn<AdminDashboardRefresh>(successRefresh());
    const requestAction = vi.fn().mockResolvedValue({ error: "user_not_found" });
    const { result } = renderHook(() =>
      useAdminActionRunner({
        feedback: { clearAll, reportError, reportNotice },
        onMutationReconciled: vi.fn(),
        refreshDashboard,
        requestAction
      })
    );

    let response!: AdminActionResult;
    await act(async () => {
      response = await result.current.runAction(action, "User disabled.");
    });

    expect(response.error).toBe("user_not_found");
    expect(reportError).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i));
    expect(reportNotice).not.toHaveBeenCalled();
    expect(refreshDashboard).not.toHaveBeenCalled();
    expect(result.current.submitting).toBeNull();
  });

  it("supports suppressed per-item notices and reloads for sequential batch work", async () => {
    const reportNotice = vi.fn();
    const refreshDashboard = vi.fn<AdminDashboardRefresh>(successRefresh());
    const requestAction = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useAdminActionRunner({
        feedback: {
          clearAll: vi.fn(),
          reportError: vi.fn(),
          reportNotice
        },
        onMutationReconciled: vi.fn(),
        refreshDashboard,
        requestAction
      })
    );

    await act(async () => {
      await result.current.runAction(action, "User disabled.", {
        reload: false,
        successNotice: false
      });
    });

    expect(reportNotice).not.toHaveBeenCalled();
    expect(refreshDashboard).not.toHaveBeenCalled();
  });

  it("maps unexpected request rejection to the network error", async () => {
    const reportError = vi.fn();
    const { result } = renderHook(() =>
      useAdminActionRunner({
        feedback: {
          clearAll: vi.fn(),
          reportError,
          reportNotice: vi.fn()
        },
        onMutationReconciled: vi.fn(),
        refreshDashboard: successRefresh(),
        requestAction: vi.fn().mockRejectedValue(new Error("offline"))
      })
    );

    await act(async () => {
      await result.current.runAction(action, "User disabled.");
    });

    await waitFor(() => expect(reportError).toHaveBeenCalledWith("Could not reach the admin API."));
  });
});

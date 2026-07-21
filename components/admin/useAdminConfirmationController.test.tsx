import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import { describe, expect, it, vi } from "vitest";
import { useAdminConfirmationController } from "./useAdminConfirmationController";

function createRunAction() {
  return vi.fn<AdminRunAction>().mockResolvedValue({ ok: true });
}

describe("useAdminConfirmationController", () => {
  it("opens and cancels a raw confirmation without invoking its action", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useAdminConfirmationController({ runAction: createRunAction() }));

    act(() => {
      result.current.requestConfirmation({
        body: "This cannot be undone.",
        confirmLabel: "Delete user",
        dialogLabel: "Delete stale user",
        onConfirm,
        testId: "admin-confirm-delete-user",
        title: "Delete stale user?"
      });
    });
    expect(result.current.confirmation).toMatchObject({
      body: "This cannot be undone.",
      testId: "admin-confirm-delete-user"
    });

    act(() => result.current.cancelConfirmation());
    expect(result.current.confirmation).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes before dispatching and prevents duplicate confirmation dispatch", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useAdminConfirmationController({ runAction: createRunAction() }));

    act(() => {
      result.current.requestConfirmation({
        body: "Proceed?",
        confirmLabel: "Proceed",
        dialogLabel: "Proceed",
        onConfirm,
        testId: "confirm-proceed",
        title: "Proceed?"
      });
    });
    act(() => {
      result.current.confirmConfirmation();
      result.current.confirmConfirmation();
    });

    expect(result.current.confirmation).toBeNull();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("maps a confirmed admin action and runs cleanup only after success", async () => {
    const runAction = createRunAction();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAdminConfirmationController({ runAction }));

    act(() => {
      result.current.requestConfirmedAction({
        body: { action: "delete_user", userId: "user-1" },
        confirmLabel: "Delete user",
        dialogLabel: "Delete stale@example.com",
        icon: "trash",
        message: "User deleted.",
        onSuccess,
        prompt: "Delete stale@example.com?",
        testId: "admin-confirm-delete-user",
        title: "Delete stale user?"
      });
    });
    expect(result.current.confirmation).toMatchObject({
      body: "Delete stale@example.com?",
      icon: "trash",
      testId: "admin-confirm-delete-user"
    });

    act(() => result.current.confirmConfirmation());
    await waitFor(() => expect(runAction).toHaveBeenCalledWith(
      { action: "delete_user", userId: "user-1" },
      "User deleted."
    ));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());

    runAction.mockResolvedValueOnce({ error: "user_not_found" });
    act(() => {
      result.current.requestConfirmedAction({
        body: { action: "delete_user", userId: "user-2" },
        confirmLabel: "Delete user",
        dialogLabel: "Delete missing@example.com",
        message: "User deleted.",
        onSuccess,
        prompt: "Delete missing@example.com?",
        testId: "admin-confirm-delete-user",
        title: "Delete stale user?"
      });
      result.current.confirmConfirmation();
    });
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(2));
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});

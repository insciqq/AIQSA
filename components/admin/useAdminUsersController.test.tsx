import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmedActionRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminGroup } from "@/lib/contracts/admin";
import { useAdminUsersController } from "./useAdminUsersController";

const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: "group-active", name: "Active group", systemRole: null, userCount: 2 },
  { accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Archived group", systemRole: null, userCount: 0 }
];
const target = { displayName: "Pat", email: "pat@example.com", id: "pat" };

function harness(runAction: AdminRunAction = vi.fn(async () => ({ ok: true }))) {
  const confirmations: AdminConfirmedActionRequest[] = [];
  const view = renderHook(() => useAdminUsersController({
    actionsDisabled: false,
    adminUserId: "admin-1",
    dashboard: { groups },
    requestConfirmedAction: (config) => { confirmations.push(config); },
    runAction
  }));
  return { confirmations, view };
}

describe("useAdminUsersController", () => {
  it("approves with groups as one client action: memberships first, then approval", async () => {
    const calls: unknown[][] = [];
    const runAction: AdminRunAction = vi.fn(async (...args) => {
      calls.push(args);
      return { ok: true };
    });
    const { view } = harness(runAction);

    await act(async () => {
      expect(await view.result.current.actions.approve(target, ["group-active", "group-archived"])).toBe(true);
    });
    expect(calls).toEqual([
      [{ action: "set_user_groups", groupIds: ["group-active"], userId: "pat" }, "User groups saved.", { reload: false, successNotice: false }],
      [{ action: "approve_user", groupIds: ["group-active"], userId: "pat" }, "User approved and added to the group."]
    ]);

    calls.length = 0;
    await act(async () => {
      await view.result.current.actions.approve(target, []);
    });
    expect(calls).toEqual([[{ action: "approve_user", groupIds: [], userId: "pat" }, "User approved."]]);
  });

  it("stops approval when the membership step fails and reports save results", async () => {
    const runAction: AdminRunAction = vi.fn(async (body) =>
      body.action === "set_user_groups" ? { error: "user_not_found" } : { ok: true });
    const { view } = harness(runAction);

    await act(async () => {
      expect(await view.result.current.actions.approve(target, ["group-active"])).toBe(false);
    });
    expect(runAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await view.result.current.actions.saveGroups(target, ["group-active"])).toBe(false);
    });
    expect(runAction).toHaveBeenLastCalledWith(
      { action: "set_user_groups", groupIds: ["group-active"], userId: "pat" },
      "User groups saved."
    );
  });

  it("routes destructive account actions through confirmations with stable ids", () => {
    const { confirmations, view } = harness();
    const onSuccess = vi.fn();
    act(() => {
      view.result.current.actions.requestReject(target);
      view.result.current.actions.requestDisable(target);
      view.result.current.actions.requestRevokeSessions(target);
      view.result.current.actions.requestDelete(target, onSuccess);
      view.result.current.actions.requestRevokeAllSessions();
    });
    expect(confirmations.map((config) => [config.testId, config.body])).toEqual([
      ["admin-confirm-reject-user", { action: "reject_user", userId: "pat" }],
      ["admin-confirm-disable-user", { action: "disable_user", userId: "pat" }],
      ["admin-confirm-revoke-user-sessions", { action: "revoke_user_sessions", userId: "pat" }],
      ["admin-confirm-delete-user", { action: "delete_user", userId: "pat" }],
      ["admin-confirm-revoke-all-sessions", { action: "revoke_all_sessions" }]
    ]);
    expect(confirmations[3]?.onSuccess).toBe(onSuccess);
    expect(confirmations.every((config) => config.prompt.includes("pat@example.com") || config.body.action === "revoke_all_sessions")).toBe(true);
  });
});

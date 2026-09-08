import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController, AdminConfirmedActionRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminDashboard, AdminGroup } from "@/lib/contracts/admin";
import { useAdminGroupsController } from "./useAdminGroupsController";

const archived: AdminGroup = {
  accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Former operators", systemRole: null, userCount: 0
};
const operators: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-operators", name: "Operators", systemRole: null, userCount: 1
};
const reviewers: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-reviewers", name: "Reviewers", systemRole: null, userCount: 0
};
const fullAccess: AdminGroup = {
  accessGrants: [], archivedAt: null, id: "group-full-access", name: "Full access", systemRole: "full_access", userCount: 1
};

const dashboard: Pick<AdminDashboard, "groups" | "users"> = {
  groups: [archived, operators, reviewers, fullAccess],
  users: [{
    directGrants: [],
    displayName: "Ada Operator",
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: "ada@example.com",
    groups: [
      { groupId: operators.id, name: operators.name, role: "member" },
      { groupId: archived.id, name: archived.name, role: "member" }
    ],
    hasVerifiedIdentity: true,
    id: "user-ada",
    lastSessionAt: null,
    role: "user",
    status: "active"
  }]
};

function dependencies() {
  const runAction = vi.fn<AdminRunAction>();
  runAction.mockResolvedValue({ ok: true });
  const confirmations: AdminConfirmedActionRequest[] = [];
  const requestConfirmedAction = vi.fn<AdminConfirmationController["requestConfirmedAction"]>((config) => {
    confirmations.push(config);
  });
  return { confirmations, requestConfirmedAction, runAction };
}

function renderController(deps = dependencies(), actionsDisabled = false) {
  return renderHook(() => useAdminGroupsController({
    actionsDisabled,
    dashboard,
    requestConfirmedAction: deps.requestConfirmedAction,
    runAction: deps.runAction
  }));
}

describe("useAdminGroupsController", () => {
  it("creates and renames through the sheet contract and hands failures back as messages", async () => {
    const deps = dependencies();
    deps.runAction
      .mockResolvedValueOnce({ group: { id: "group-new" } })
      .mockResolvedValueOnce({ error: "group_invalid" })
      .mockResolvedValueOnce({ ok: true });
    const { result } = renderController(deps);

    await expect(result.current.actions.create("")).resolves.toEqual({ message: "Enter a group name.", ok: false });
    await expect(result.current.actions.create("  Research  ")).resolves.toEqual({ groupId: "group-new", ok: true });
    expect(deps.runAction).toHaveBeenLastCalledWith({ action: "create_group", name: "Research" }, "Group created.");
    await expect(result.current.actions.create("Research")).resolves.toEqual({
      message: "Use a unique, non-empty group name.",
      ok: false
    });

    await expect(result.current.actions.rename(operators, " Ops ")).resolves.toEqual({ groupId: operators.id, ok: true });
    expect(deps.runAction).toHaveBeenLastCalledWith(
      { action: "rename_group", groupId: operators.id, name: "Ops" },
      "Group renamed."
    );
    await expect(result.current.actions.rename(fullAccess, "Everyone")).resolves.toMatchObject({ ok: false });
    expect(deps.runAction).toHaveBeenCalledTimes(3);
  });

  it("sends one set_group_grants request per batch and never for Full access or archived groups", async () => {
    const deps = dependencies();
    const { result } = renderController(deps);
    const changes = [
      { enabled: true, modelId: "gpt-5.5", provider: "openai" },
      { enabled: true, modelId: "gpt-mini", provider: "openai" }
    ];

    await expect(result.current.actions.applyGrants(operators, changes, "All models granted.")).resolves.toBe(true);
    expect(deps.runAction).toHaveBeenCalledTimes(1);
    expect(deps.runAction).toHaveBeenCalledWith(
      { action: "set_group_grants", changes, groupId: operators.id },
      "All models granted."
    );

    deps.runAction.mockResolvedValueOnce({ error: "group_grant_invalid" });
    await expect(result.current.actions.applyGrants(operators, [{ enabled: false, provider: "openai" }])).resolves.toBe(false);
    expect(deps.runAction).toHaveBeenLastCalledWith(
      { action: "set_group_grants", changes: [{ enabled: false, provider: "openai" }], groupId: operators.id },
      "Access updated."
    );

    await expect(result.current.actions.applyGrants(fullAccess, changes)).resolves.toBe(false);
    await expect(result.current.actions.applyGrants(archived, changes)).resolves.toBe(false);
    await expect(result.current.actions.applyGrants(operators, [])).resolves.toBe(false);
    expect(deps.runAction).toHaveBeenCalledTimes(2);
  });

  it("adds and removes members without losing their other active groups", async () => {
    const deps = dependencies();
    const { result } = renderController(deps);

    await act(async () => {
      await expect(result.current.actions.setMembership(reviewers, "user-ada", true)).resolves.toBe(true);
    });
    expect(deps.runAction).toHaveBeenLastCalledWith(
      { action: "set_user_groups", expectedGroupIds: [operators.id], groupIds: [operators.id, reviewers.id], userId: "user-ada" },
      "Member added."
    );

    await act(async () => {
      await expect(result.current.actions.setMembership(operators, "user-ada", false)).resolves.toBe(true);
    });
    expect(deps.runAction).toHaveBeenLastCalledWith(
      { action: "set_user_groups", expectedGroupIds: [operators.id], groupIds: [], userId: "user-ada" },
      "Member removed."
    );

    await expect(result.current.actions.setMembership(archived, "user-ada", false)).resolves.toBe(false);
    await expect(result.current.actions.setMembership(operators, "user-missing", true)).resolves.toBe(false);
    expect(deps.runAction).toHaveBeenCalledTimes(2);
  });

  it("routes archive and delete through the shared confirmation and skips them for Full access", () => {
    const deps = dependencies();
    const { result } = renderController(deps);
    const onSuccess = vi.fn();

    result.current.actions.requestArchive(operators, onSuccess);
    result.current.actions.requestDelete(reviewers, onSuccess);
    result.current.actions.requestArchive(archived);
    result.current.actions.requestArchive(fullAccess);
    result.current.actions.requestDelete(fullAccess);

    expect(deps.confirmations.map((config) => [config.testId, config.body, config.onSuccess])).toEqual([
      ["admin-confirm-archive-group", { action: "archive_group", groupId: operators.id }, onSuccess],
      ["admin-confirm-delete-group", { action: "delete_group", groupId: reviewers.id }, onSuccess]
    ]);
    expect(deps.confirmations[0]).toMatchObject({ confirmLabel: "Archive group", tone: "warning" });
    expect(deps.confirmations[1]).toMatchObject({ confirmLabel: "Delete group", icon: "trash" });
  });
});

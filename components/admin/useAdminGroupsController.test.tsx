import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminDashboardRefresh } from "@/components/admin/useAdminDashboardResource";
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
  return {
    confirmations,
    onError: vi.fn(),
    onNotice: vi.fn(),
    refreshDashboard: vi.fn<AdminDashboardRefresh>().mockResolvedValue({ dashboard: dashboard as AdminDashboard, ok: true }),
    requestConfirmedAction,
    runAction
  };
}

function renderController(deps = dependencies(), actionsDisabled = false) {
  return renderHook(() => useAdminGroupsController({
    actionsDisabled,
    dashboard,
    onError: deps.onError,
    onNotice: deps.onNotice,
    refreshDashboard: deps.refreshDashboard,
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

    await act(async () => { await expect(result.current.actions.applyGrants(operators, changes, "All models granted.")).resolves.toBe(true); });
    expect(deps.runAction).toHaveBeenCalledTimes(1);
    expect(deps.runAction).toHaveBeenCalledWith(
      { action: "set_group_grants", changes, groupId: operators.id },
      "All models granted.",
      { reload: false, successNotice: false }
    );

    deps.runAction.mockResolvedValueOnce({ error: "group_grant_invalid" });
    await act(async () => { await expect(result.current.actions.applyGrants(operators, [{ enabled: false, provider: "openai" }])).resolves.toBe(false); });
    expect(deps.runAction).toHaveBeenLastCalledWith(
      { action: "set_group_grants", changes: [{ enabled: false, provider: "openai" }], groupId: operators.id },
      "Access updated.",
      { reload: false, successNotice: false }
    );

    await expect(result.current.actions.applyGrants(fullAccess, changes)).resolves.toBe(false);
    await expect(result.current.actions.applyGrants(archived, changes)).resolves.toBe(false);
    await expect(result.current.actions.applyGrants(operators, [])).resolves.toBe(false);
    expect(deps.runAction).toHaveBeenCalledTimes(2);
    expect(deps.refreshDashboard).toHaveBeenCalledTimes(2);
    expect(deps.onNotice).toHaveBeenCalledTimes(1);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("0 of 1 access changes confirmed"));
  });

  it("serializes bounded batches, deduplicates identities and locks repeat submissions through the final reload", async () => {
    const deps = dependencies();
    let finishFirst!: (value: Awaited<ReturnType<AdminRunAction>>) => void;
    deps.runAction.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    let finishReload!: (value: Awaited<ReturnType<typeof deps.refreshDashboard>>) => void;
    deps.refreshDashboard.mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    const changes = Array.from({ length: 401 }, (_, index) => ({ enabled: true, modelId: `model-${index}`, provider: "openai" }));
    const { result } = renderController(deps);
    let mutation!: Promise<boolean>;
    act(() => { mutation = result.current.actions.applyGrants(operators, [...changes, changes[0]], "All models granted."); });
    expect(deps.runAction).toHaveBeenCalledTimes(1);
    expect(result.current.actionsDisabled).toBe(true);
    expect(result.current.grantProgress).toEqual({ completed: 0, groupId: operators.id, total: 401 });
    await expect(result.current.actions.applyGrants(operators, changes)).resolves.toBe(false);
    await act(async () => { finishFirst({ ok: true }); });
    expect(deps.runAction.mock.calls.map(([body]) => body.action === "set_group_grants" ? body.changes.length : -1)).toEqual([200, 200, 1]);
    expect(deps.refreshDashboard).toHaveBeenCalledTimes(1);
    expect(result.current.grantProgress).toEqual({ completed: 401, groupId: operators.id, total: 401 });
    expect(result.current.actionsDisabled).toBe(true);
    expect(deps.onNotice).not.toHaveBeenCalled();
    await act(async () => {
      finishReload({ dashboard: dashboard as AdminDashboard, ok: true });
      await expect(mutation).resolves.toBe(true);
    });
    expect(result.current.actionsDisabled).toBe(false);
    expect(result.current.grantProgress).toBeNull();
    expect(deps.onNotice).toHaveBeenCalledWith("Operators: All models granted.");
  });

  it("stops a later rejected batch, reloads confirmed partial work and never announces success", async () => {
    const deps = dependencies();
    deps.runAction.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ error: "group_grant_invalid" });
    const { result } = renderController(deps);
    const changes = Array.from({ length: 401 }, (_, index) => ({ enabled: false, searchStrategy: `search-${index}` }));
    await act(async () => { await expect(result.current.actions.applyGrants(operators, changes)).resolves.toBe(false); });
    expect(deps.runAction).toHaveBeenCalledTimes(2);
    expect(deps.refreshDashboard).toHaveBeenCalledTimes(1);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("200 of 401 access changes confirmed"));
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("Review the saved grants"));
    expect(deps.onNotice).not.toHaveBeenCalled();
    expect(result.current.actionsDisabled).toBe(false);
  });

  it("reports saved changes without a success notice if authoritative refresh fails", async () => {
    const deps = dependencies();
    deps.refreshDashboard.mockResolvedValueOnce({ error: "network_error", ok: false });
    const { result } = renderController(deps);
    await act(async () => { await expect(result.current.actions.applyGrants(operators, [{ enabled: true, provider: "openai" }])).resolves.toBe(false); });
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("1 of 1 access changes saved, but current grants could not be reloaded"));
    expect(deps.onNotice).not.toHaveBeenCalled();
  });

  it("does not mutate while its owner is disabled and refreshes an uncertain network failure", async () => {
    const disabled = dependencies();
    const blocked = renderController(disabled, true);
    await expect(blocked.result.current.actions.applyGrants(operators, [{ enabled: true, provider: "openai" }])).resolves.toBe(false);
    expect(disabled.runAction).not.toHaveBeenCalled();
    const deps = dependencies();
    deps.runAction.mockRejectedValueOnce(new Error("network offline"));
    const { result } = renderController(deps);
    await act(async () => { await expect(result.current.actions.applyGrants(operators, [{ enabled: true, provider: "openai" }])).resolves.toBe(false); });
    expect(deps.refreshDashboard).toHaveBeenCalledOnce();
    expect(deps.onNotice).not.toHaveBeenCalled();
    expect(result.current.actionsDisabled).toBe(false);
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

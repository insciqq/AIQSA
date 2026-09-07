import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { useAdminAccessRulesController } from "./useAdminAccessRulesController";

const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: "group-active", name: "Active group", systemRole: null, userCount: 2 },
  { accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-archived", name: "Archived group", systemRole: null, userCount: 0 }
];
const rule: AdminAccessRuleRecord = {
  defaultGroups: [],
  enabled: true,
  id: "rule-1",
  kind: "domain",
  value: "example.com"
};

describe("useAdminAccessRulesController", () => {
  it("normalizes the value, keeps only active groups, and reports validation without a request", async () => {
    const runAction: AdminRunAction = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useAdminAccessRulesController({
      actionsDisabled: false,
      dashboard: { accessRules: [rule], groups },
      runAction
    }));
    expect(result.current.rules).toEqual([rule]);

    await act(async () => {
      expect(await result.current.actions.createRule({ groupIds: [], kind: "email", value: "   " }))
        .toEqual({ message: "Enter an exact email or domain before saving.", ok: false });
    });
    expect(runAction).not.toHaveBeenCalled();

    await act(async () => {
      expect(await result.current.actions.createRule({
        groupIds: ["group-active", "group-archived"],
        kind: "domain",
        value: " @Example.COM "
      })).toEqual({ ok: true });
    });
    expect(runAction).toHaveBeenCalledWith(
      { action: "create_access_rule", groupIds: ["group-active"], kind: "domain", value: "example.com" },
      "Sign-up rule saved."
    );
  });

  it("passes server errors back and deletes without its own confirmation", async () => {
    const runAction: AdminRunAction = vi.fn()
      .mockResolvedValueOnce({ error: "access_rule_invalid" })
      .mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useAdminAccessRulesController({
      actionsDisabled: false,
      dashboard: { accessRules: [rule], groups },
      runAction
    }));

    await act(async () => {
      const created = await result.current.actions.createRule({ groupIds: [], kind: "email", value: "person@example.com" });
      expect(created.ok).toBe(false);
      expect(created).toMatchObject({ message: expect.any(String) });
    });
    await act(async () => {
      expect(await result.current.actions.deleteRule(rule)).toBe(true);
    });
    expect(runAction).toHaveBeenLastCalledWith({ action: "delete_access_rule", ruleId: "rule-1" }, "Sign-up rule deleted.");
  });
});

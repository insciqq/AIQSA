import { act, renderHook } from "@testing-library/react";
import type { AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { describe, expect, it, vi } from "vitest";
import type { AdminRunAction } from "./useAdminActionRunner";
import type { AdminConfirmationController } from "./useAdminConfirmationController";
import type { AdminFieldErrorController } from "./useAdminFieldErrors";
import {
  useAdminAccessRulesController,
  type AdminAccessRulesController,
  type AdminAccessRulesDashboard,
  type UseAdminAccessRulesControllerOptions
} from "./useAdminAccessRulesController";

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-active",
  name: "Operators",
  systemRole: null,
  userCount: 1
};

const archivedGroup: AdminGroup = {
  ...activeGroup,
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators"
};

const emailRule: AdminAccessRuleRecord = {
  defaultGroups: [{ groupId: activeGroup.id, name: activeGroup.name, role: "member" }],
  enabled: true,
  id: "rule-email",
  kind: "email",
  value: "person@example.com"
};

const domainRule: AdminAccessRuleRecord = {
  defaultGroups: [],
  enabled: true,
  id: "rule-domain",
  kind: "domain",
  value: "example.org"
};

const dashboard: AdminAccessRulesDashboard = {
  accessRules: [emailRule, domainRule],
  groups: [activeGroup, archivedGroup]
};

function createDependencies() {
  const fieldErrors = {
    clearFieldError: vi.fn<AdminFieldErrorController["clearFieldError"]>(),
    fieldError: null,
    reportFieldError: vi.fn<AdminFieldErrorController["reportFieldError"]>()
  } satisfies UseAdminAccessRulesControllerOptions["fieldErrors"];
  const confirmation = {
    requestConfirmedAction: vi.fn<AdminConfirmationController["requestConfirmedAction"]>()
  } satisfies UseAdminAccessRulesControllerOptions["confirmation"];
  const runAction = vi.fn<AdminRunAction>().mockResolvedValue({ ok: true });

  return { confirmation, fieldErrors, runAction };
}

function section(controller: AdminAccessRulesController) {
  if (!controller.sectionProps) {
    throw new Error("Expected access-rule section props");
  }

  return controller.sectionProps;
}

describe("useAdminAccessRulesController", () => {
  it("owns persistent form/filter drafts, normalized preview, and active-group projection", () => {
    const dependencies = createDependencies();
    const initialProps: { actionsDisabled: boolean; currentDashboard: AdminAccessRulesDashboard | null } = {
      actionsDisabled: false,
      currentDashboard: dashboard
    };
    const { result, rerender } = renderHook(
      ({ actionsDisabled, currentDashboard }: { actionsDisabled: boolean; currentDashboard: AdminAccessRulesDashboard | null }) =>
        useAdminAccessRulesController({
          ...dependencies,
          actionsDisabled,
          dashboard: currentDashboard
      }),
      {
        initialProps
      }
    );

    act(() => {
      result.current.headerForm.toggleForm();
      section(result.current).actions.changeKind("domain");
      section(result.current).actions.changeValue("  @Example.COM  ");
      section(result.current).actions.changeGroups([activeGroup.id, archivedGroup.id]);
      section(result.current).actions.changeQuery("operators");
    });

    expect(result.current.headerForm.formOpen).toBe(true);
    expect(section(result.current).state).toMatchObject({
      formOpen: true,
      groupIds: [activeGroup.id],
      kind: "domain",
      normalizedPreview: "example.com",
      query: "operators",
      value: "  @Example.COM  "
    });
    expect(section(result.current).data.rules.map((rule) => rule.id)).toEqual([emailRule.id]);

    const refreshedDashboard: AdminAccessRulesDashboard = structuredClone(dashboard);
    const refreshedActiveGroup = refreshedDashboard.groups.find((group) => group.id === activeGroup.id);
    if (!refreshedActiveGroup) {
      throw new Error("Expected active group fixture");
    }
    refreshedActiveGroup.archivedAt = "2026-07-12T00:00:00.000Z";
    rerender({ actionsDisabled: true, currentDashboard: refreshedDashboard });

    expect(section(result.current).state.groupIds).toEqual([]);
    expect(section(result.current).state.value).toBe("  @Example.COM  ");
    expect(section(result.current).status.actionsDisabled).toBe(true);

    rerender({ actionsDisabled: true, currentDashboard: null });
    expect(result.current.sectionProps).toBeNull();
    expect(result.current.headerForm.formOpen).toBe(true);
  });

  it("validates locally, retains failed drafts, and resets only the successful rule form", async () => {
    const dependencies = createDependencies();
    const { result } = renderHook(() =>
      useAdminAccessRulesController({
        ...dependencies,
        actionsDisabled: false,
        dashboard
      })
    );

    await act(async () => section(result.current).actions.createRule());
    expect(dependencies.fieldErrors.reportFieldError).toHaveBeenCalledWith("rule-value", "access_rule_required");
    expect(dependencies.runAction).not.toHaveBeenCalled();

    act(() => {
      result.current.headerForm.toggleForm();
      section(result.current).actions.changeKind("domain");
      section(result.current).actions.changeValue("  @Example.COM  ");
      section(result.current).actions.changeGroups([activeGroup.id, archivedGroup.id]);
      section(result.current).actions.changeQuery("domain");
    });
    dependencies.runAction.mockResolvedValueOnce({ error: "access_rule_invalid" });
    await act(async () => section(result.current).actions.createRule());

    expect(dependencies.runAction).toHaveBeenNthCalledWith(
      1,
      {
        action: "create_access_rule",
        groupIds: [activeGroup.id],
        kind: "domain",
        value: "example.com"
      },
      "Access rule saved."
    );
    expect(section(result.current).state).toMatchObject({
      formOpen: true,
      groupIds: [activeGroup.id],
      kind: "domain",
      query: "domain",
      value: "  @Example.COM  "
    });

    dependencies.runAction.mockResolvedValueOnce({ ok: true });
    await act(async () => section(result.current).actions.createRule());

    expect(dependencies.runAction).toHaveBeenCalledTimes(2);
    expect(result.current.headerForm.formOpen).toBe(false);
    expect(section(result.current).state).toMatchObject({
      formOpen: false,
      groupIds: [],
      kind: "domain",
      query: "domain",
      value: ""
    });
  });

  it("builds the exact access-rule deletion confirmation target", () => {
    const dependencies = createDependencies();
    const { result } = renderHook(() =>
      useAdminAccessRulesController({
        ...dependencies,
        actionsDisabled: false,
        dashboard
      })
    );

    act(() =>
      section(result.current).actions.requestDeleteRule({
        id: domainRule.id,
        kind: domainRule.kind,
        value: domainRule.value
      })
    );

    expect(dependencies.confirmation.requestConfirmedAction).toHaveBeenCalledWith({
      body: { action: "delete_access_rule", ruleId: domainRule.id },
      confirmLabel: "Delete rule",
      dialogLabel: "Delete access rule example.org",
      message: "Access rule deleted.",
      onSuccess: expect.any(Function),
      prompt:
        "Delete the domain access rule for example.org? Future matching requests will no longer auto-activate through this rule.",
      testId: "admin-confirm-delete-access-rule",
      title: "Delete access rule?"
    });
  });
});

"use client";

import { adminActionErrorMessage } from "@/components/admin/adminApi";
import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import { normalizedRuleValue } from "@/components/admin/adminViewUtils";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminAccessRuleKind, AdminAccessRuleRecord, AdminDashboard } from "@/lib/contracts/admin";
import { useCallback, useMemo } from "react";

export type AdminAccessRulesDashboard = Pick<AdminDashboard, "accessRules" | "groups">;

export type AdminAccessRuleActionTarget = Pick<AdminAccessRuleRecord, "id" | "kind" | "value">;

export type AdminAccessRuleCreateInput = Readonly<{
  groupIds: readonly string[];
  kind: AdminAccessRuleKind;
  value: string;
}>;

export type AdminAccessRuleCreateResult =
  | Readonly<{ ok: true }>
  | Readonly<{ message: string; ok: false }>;

export type UseAdminAccessRulesControllerOptions = Readonly<{
  actionsDisabled: boolean;
  dashboard: AdminAccessRulesDashboard | null;
  runAction: AdminRunAction;
}>;

export type AdminAccessRulesController = Readonly<{
  actions: Readonly<{
    createRule(input: AdminAccessRuleCreateInput): Promise<AdminAccessRuleCreateResult>;
    /** The Sign-up rules section confirms before deletion. */
    deleteRule(rule: AdminAccessRuleActionTarget): Promise<boolean>;
  }>;
  actionsDisabled: boolean;
  rules: AdminAccessRuleRecord[];
}>;

/** One mutation owner for the Sign-up rules section and its add-rule sheet. */
export function useAdminAccessRulesController({
  actionsDisabled,
  dashboard,
  runAction
}: UseAdminAccessRulesControllerOptions): AdminAccessRulesController {
  const groups = dashboard?.groups;

  const createRule = useCallback(async (input: AdminAccessRuleCreateInput): Promise<AdminAccessRuleCreateResult> => {
    const value = normalizedRuleValue(input.kind, input.value);
    if (!value) {
      return { message: adminActionErrorMessage("access_rule_required"), ok: false };
    }
    const result = await runAction(
      {
        action: "create_access_rule",
        groupIds: activeDraftGroupIds(groups ?? [], input.groupIds),
        kind: input.kind,
        value
      },
      "Sign-up rule saved."
    );
    return result.error ? { message: adminActionErrorMessage(result.error), ok: false } : { ok: true };
  }, [groups, runAction]);

  const deleteRule = useCallback(async (rule: AdminAccessRuleActionTarget) => {
    const result = await runAction(
      { action: "delete_access_rule", ruleId: rule.id },
      "Sign-up rule deleted."
    );
    return !result.error;
  }, [runAction]);

  const rules = dashboard?.accessRules;
  return useMemo(() => ({
    actions: { createRule, deleteRule },
    actionsDisabled,
    rules: rules ?? []
  }), [actionsDisabled, createRule, deleteRule, rules]);
}

"use client";

import type { AdminAccessRulesSectionProps } from "@/components/admin/AdminAccessRulesSection";
import { filterAdminAccessRules } from "@/components/admin/adminAccessRuleView";
import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import { normalizedRuleValue } from "@/components/admin/adminViewUtils";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import type { AdminAccessRuleKind, AdminDashboard } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

export type AdminAccessRulesDashboard = Pick<AdminDashboard, "accessRules" | "groups">;

export type AdminAccessRulesHeaderForm = Readonly<{
  formOpen: boolean;
  toggleForm(): void;
}>;

export type UseAdminAccessRulesControllerOptions = Readonly<{
  actionsDisabled: boolean;
  confirmation: Pick<AdminConfirmationController, "requestConfirmedAction">;
  dashboard: AdminAccessRulesDashboard | null;
  fieldErrors: Pick<AdminFieldErrorController, "clearFieldError" | "fieldError" | "reportFieldError">;
  runAction: AdminRunAction;
}>;

export type AdminAccessRulesController = Readonly<{
  headerForm: AdminAccessRulesHeaderForm;
  sectionProps: AdminAccessRulesSectionProps | null;
}>;

export function useAdminAccessRulesController({
  actionsDisabled,
  confirmation,
  dashboard,
  fieldErrors,
  runAction
}: UseAdminAccessRulesControllerOptions): AdminAccessRulesController {
  const { clearFieldError, fieldError, reportFieldError } = fieldErrors;
  const { requestConfirmedAction } = confirmation;
  const [formOpen, setFormOpen] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [kind, setKind] = useState<AdminAccessRuleKind>("email");
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const normalizedPreview = normalizedRuleValue(kind, value);
  const projectedGroupIds = useMemo(
    () => activeDraftGroupIds(dashboard?.groups ?? [], groupIds),
    [dashboard?.groups, groupIds]
  );
  const filteredRules = useMemo(
    () => filterAdminAccessRules(dashboard?.accessRules ?? [], query),
    [dashboard?.accessRules, query]
  );

  const toggleForm = useCallback(() => {
    clearFieldError("rule-value");
    setFormOpen((open) => !open);
  }, [clearFieldError]);

  const changeValue = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      clearFieldError("rule-value");
    },
    [clearFieldError]
  );

  const createRule = useCallback(async () => {
    const normalizedValue = normalizedRuleValue(kind, value);

    if (!normalizedValue) {
      reportFieldError("rule-value", "access_rule_required");
      return;
    }
    clearFieldError("rule-value");

    const result = await runAction(
      {
        action: "create_access_rule",
        groupIds: projectedGroupIds,
        kind,
        value: normalizedValue
      },
      "Access rule saved."
    );

    if (!result.error) {
      setValue("");
      setGroupIds([]);
      setFormOpen(false);
    }
  }, [clearFieldError, kind, projectedGroupIds, reportFieldError, runAction, value]);

  const requestDeleteRule = useCallback(
    (rule: Parameters<AdminAccessRulesSectionProps["actions"]["requestDeleteRule"]>[0]) => {
      requestConfirmedAction({
        body: {
          action: "delete_access_rule",
          ruleId: rule.id
        },
        confirmLabel: "Delete rule",
        dialogLabel: `Delete access rule ${rule.value}`,
        message: "Access rule deleted.",
        prompt: `Delete the ${rule.kind} access rule for ${rule.value}? Future matching requests will no longer auto-activate through this rule.`,
        testId: "admin-confirm-delete-access-rule",
        title: "Delete access rule?"
      });
    },
    [requestConfirmedAction]
  );

  const sectionProps = useMemo<AdminAccessRulesSectionProps | null>(() => {
    if (!dashboard) {
      return null;
    }

    return {
      actions: {
        changeGroups: setGroupIds,
        changeKind: setKind,
        changeQuery: setQuery,
        changeValue,
        createRule,
        requestDeleteRule
      },
      data: {
        groups: dashboard.groups,
        rules: filteredRules,
        totalRuleCount: dashboard.accessRules.length
      },
      state: {
        formOpen,
        groupIds: projectedGroupIds,
        kind,
        normalizedPreview,
        query,
        value,
        valueError: fieldError?.field === "rule-value" ? fieldError.message : null
      },
      status: {
        actionsDisabled
      }
    };
  }, [
    actionsDisabled,
    changeValue,
    createRule,
    dashboard,
    fieldError,
    filteredRules,
    formOpen,
    kind,
    normalizedPreview,
    projectedGroupIds,
    query,
    requestDeleteRule,
    value
  ]);

  return useMemo(
    () => ({
      headerForm: {
        formOpen,
        toggleForm
      },
      sectionProps
    }),
    [formOpen, sectionProps, toggleForm]
  );
}

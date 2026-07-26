import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { AdminAccessRulesSection, type AdminAccessRulesSectionActions, type AdminAccessRulesSectionProps } from "./AdminAccessRulesSection";

const groups: AdminGroup[] = [{ accessGrants: [], archivedAt: null, id: "group-1", name: "operators", systemRole: null, userCount: 1 }];
const rule: AdminAccessRuleRecord = {
  defaultGroups: [{ groupId: "group-1", name: "operators", role: "member" }],
  enabled: true,
  id: "rule-1",
  kind: "email",
  value: "allowed@example.com"
};

function actions(): AdminAccessRulesSectionActions {
  return {
    backToList: vi.fn(),
    changeGroups: vi.fn(),
    changeKind: vi.fn(),
    changeQuery: vi.fn(),
    changeValue: vi.fn(),
    createRule: vi.fn(),
    requestDeleteRule: vi.fn(),
    selectRule: vi.fn()
  };
}

function props(sectionActions: AdminAccessRulesSectionActions, overrides: Partial<AdminAccessRulesSectionProps> = {}): AdminAccessRulesSectionProps {
  return {
    actions: sectionActions,
    data: { groups, rules: [rule], selectedRule: null, totalRuleCount: 1 },
    state: {
      compactDetailOpen: false,
      formOpen: false,
      groupIds: ["group-1"],
      kind: "email",
      normalizedPreview: "person@example.com",
      query: "",
      value: " PERSON@Example.COM ",
      valueError: null
    },
    status: { actionsDisabled: false },
    ...overrides
  };
}

describe("AdminAccessRulesSection", () => {
  it("keeps a flat rule index and selected detail mounted", () => {
    const sectionActions = actions();
    render(<AdminAccessRulesSection {...props(sectionActions)} />);

    expect(screen.getByTestId("admin-access-rules-index")).toHaveClass("block", "lg:block");
    expect(screen.getByTestId("admin-access-rules-detail-pane")).toHaveClass("hidden", "lg:block");
    expect(screen.getByText("Enabled")).toHaveClass("border-positive/35", "text-positive");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search access rules"), { target: { value: "domain" } });
    fireEvent.click(within(screen.getByTestId("admin-access-rule-row")).getByRole("button", { name: "Details" }));

    expect(sectionActions.changeQuery).toHaveBeenCalledWith("domain");
    expect(sectionActions.selectRule).toHaveBeenCalledWith(rule.id);
  });

  it("keeps lifecycle emphasis visible underneath the independent selection ring", () => {
    const sectionActions = actions();
    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: { groups, rules: [rule], selectedRule: rule, totalRuleCount: 1 }
        })}
      />
    );

    expect(screen.getByTestId("admin-access-rule-row")).toHaveClass(
      "border-l-positive/55",
      "ring-proof/45"
    );
  });

  it("wires create, exact normalized preview, active groups, and local validation", () => {
    const sectionActions = actions();
    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          state: {
            compactDetailOpen: true,
            formOpen: true,
            groupIds: ["group-1"],
            kind: "email",
            normalizedPreview: "person@example.com",
            query: "allowed",
            value: " PERSON@Example.COM ",
            valueError: "Enter an exact email or domain."
          }
        })}
      />
    );

    const kind = screen.getByLabelText("Kind");
    const value = screen.getByLabelText("Value");
    expect(value).toHaveAccessibleDescription("Enter an exact email or domain.");
    expect(screen.getByText("person@example.com")).toBeVisible();
    expect(screen.getByText(/Matching users receive/)).toHaveTextContent("1 default group.");

    fireEvent.change(kind, { target: { value: "domain" } });
    fireEvent.change(value, { target: { value: "example.com" } });
    fireEvent.click(screen.getByLabelText("operators"));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to access rules" }));

    expect(sectionActions.changeKind).toHaveBeenCalledWith("domain");
    expect(sectionActions.changeValue).toHaveBeenCalledWith("example.com");
    expect(sectionActions.changeGroups).toHaveBeenCalledWith([]);
    expect(sectionActions.createRule).toHaveBeenCalledTimes(1);
    expect(sectionActions.backToList).toHaveBeenCalledTimes(1);
  });

  it("keeps the create/delete-only lifecycle explicit in selected rule detail", () => {
    const sectionActions = actions();
    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: { groups, rules: [rule], selectedRule: rule, totalRuleCount: 1 },
          state: { ...props(sectionActions).state, compactDetailOpen: true }
        })}
      />
    );

    expect(screen.getByText(/Rules cannot be edited/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
    expect(sectionActions.requestDeleteRule).toHaveBeenCalledWith({ id: rule.id, kind: rule.kind, value: rule.value });
  });

  it("surfaces retained disabled rules without inventing an enable mutation", () => {
    const sectionActions = actions();
    const disabledRule = { ...rule, enabled: false };
    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: { groups, rules: [disabledRule], selectedRule: disabledRule, totalRuleCount: 1 },
          state: { ...props(sectionActions).state, compactDetailOpen: true }
        })}
      />
    );

    expect(screen.getAllByText("Disabled")).toHaveLength(2);
    expect(screen.getAllByText("Disabled")[0]).toHaveClass("border-trace-strong", "text-ink");
    expect(screen.getByText(/Matching future access requests are not approved by it/)).toBeVisible();
    expect(screen.queryByText(/matching this exact email is approved/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable rule/i })).not.toBeInTheDocument();
  });

  it("distinguishes empty views and disables the active mutation", () => {
    const sectionActions = actions();
    const view = render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: { groups, rules: [], selectedRule: null, totalRuleCount: 0 }
        })}
      />
    );
    expect(screen.getByText("No access rules")).toBeVisible();

    view.rerender(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: { groups, rules: [], selectedRule: null, totalRuleCount: 2 },
          state: {
            compactDetailOpen: true,
            formOpen: true,
            groupIds: [],
            kind: "domain",
            normalizedPreview: "",
            query: "missing",
            value: "",
            valueError: null
          },
          status: { actionsDisabled: true }
        })}
      />
    );
    expect(screen.getByText("No access rules match this view")).toBeVisible();
    expect(screen.getByText("Enter a value to preview the exact normalized match before saving.")).toBeVisible();
    expect(screen.getByLabelText("Value")).toHaveAttribute("placeholder", "example.com");
    expect(screen.getByRole("button", { name: "Save rule" })).toBeDisabled();
  });
});

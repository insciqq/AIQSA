import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import {
  AdminAccessRulesSection,
  type AdminAccessRulesSectionActions,
  type AdminAccessRulesSectionProps
} from "./AdminAccessRulesSection";

const groups: AdminGroup[] = [
  {
    accessGrants: [],
    archivedAt: null,
    id: "group-1",
    name: "operators",
    userCount: 1
  }
];

const rule: AdminAccessRuleRecord = {
  defaultGroups: [{ groupId: "group-1", name: "operators", role: "member" }],
  enabled: true,
  id: "rule-1",
  kind: "email",
  value: "allowed@example.com"
};

function actions(): AdminAccessRulesSectionActions {
  return {
    changeGroups: vi.fn<AdminAccessRulesSectionActions["changeGroups"]>(),
    changeKind: vi.fn<AdminAccessRulesSectionActions["changeKind"]>(),
    changeQuery: vi.fn<AdminAccessRulesSectionActions["changeQuery"]>(),
    changeValue: vi.fn<AdminAccessRulesSectionActions["changeValue"]>(),
    createRule: vi.fn<AdminAccessRulesSectionActions["createRule"]>(),
    requestDeleteRule: vi.fn<AdminAccessRulesSectionActions["requestDeleteRule"]>()
  };
}

function props(
  sectionActions: AdminAccessRulesSectionActions,
  overrides: Partial<AdminAccessRulesSectionProps> = {}
): AdminAccessRulesSectionProps {
  return {
    actions: sectionActions,
    data: {
      groups,
      rules: [rule],
      totalRuleCount: 1
    },
    state: {
      formOpen: true,
      groupIds: ["group-1"],
      kind: "email",
      normalizedPreview: "person@example.com",
      query: "",
      value: " PERSON@Example.COM ",
      valueError: null
    },
    status: {
      actionsDisabled: false
    },
    ...overrides
  };
}

describe("AdminAccessRulesSection", () => {
  it("wires the controlled form, normalized preview, filter, table action, and error association", () => {
    const sectionActions = actions();

    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          state: {
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
    expect(kind).toHaveAttribute("id", "rule-kind");
    expect(value).toHaveAttribute("id", "rule-value");
    expect(value).toHaveAttribute("aria-invalid", "true");
    expect(value).toHaveAttribute("aria-describedby", "rule-value-error");
    expect(screen.getByText("Enter an exact email or domain.")).toHaveAttribute("id", "rule-value-error");

    expect(screen.getByText("person@example.com")).toBeVisible();
    expect(screen.getByText(/Matching users receive/).closest("p")).toHaveTextContent("1 default group.");

    fireEvent.change(kind, { target: { value: "domain" } });
    expect(sectionActions.changeKind).toHaveBeenCalledWith("domain");
    fireEvent.change(value, { target: { value: "example.com" } });
    expect(sectionActions.changeValue).toHaveBeenCalledWith("example.com");
    fireEvent.click(screen.getByLabelText("operators"));
    expect(sectionActions.changeGroups).toHaveBeenCalledWith([]);
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(sectionActions.createRule).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Search access rules"), { target: { value: "domain" } });
    expect(sectionActions.changeQuery).toHaveBeenCalledWith("domain");

    const tableRegion = screen.getByRole("region", { name: "Access rules table" });
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(within(tableRegion).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Rule",
      "Default groups",
      "Actions"
    ]);
    fireEvent.click(within(tableRegion).getByRole("button", { name: "Delete" }));
    expect(sectionActions.requestDeleteRule).toHaveBeenCalledWith({
      id: rule.id,
      kind: rule.kind,
      value: rule.value
    });
  });

  it("renders the deliberate empty and filtered-empty table copy", () => {
    const sectionActions = actions();
    const { rerender } = render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: {
            groups,
            rules: [],
            totalRuleCount: 0
          },
          state: {
            formOpen: false,
            groupIds: [],
            kind: "email",
            normalizedPreview: "",
            query: "",
            value: "",
            valueError: null
          }
        })}
      />
    );

    expect(screen.getByText("No access rules").closest("td")).toHaveAttribute("colspan", "3");

    rerender(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          data: {
            groups,
            rules: [],
            totalRuleCount: 2
          },
          state: {
            formOpen: false,
            groupIds: [],
            kind: "email",
            normalizedPreview: "",
            query: "missing",
            value: "",
            valueError: null
          }
        })}
      />
    );

    expect(screen.getByText("No access rules match this view").closest("td")).toHaveAttribute("colspan", "3");
  });

  it("renders the no-preview instruction and disables mutation actions", () => {
    const sectionActions = actions();

    render(
      <AdminAccessRulesSection
        {...props(sectionActions, {
          state: {
            formOpen: true,
            groupIds: [],
            kind: "domain",
            normalizedPreview: "",
            query: "",
            value: "",
            valueError: null
          },
          status: {
            actionsDisabled: true
          }
        })}
      />
    );

    expect(screen.getByText("Enter a value to preview the exact normalized match before saving.")).toBeVisible();
    expect(screen.getByLabelText("Value")).toHaveAttribute("placeholder", "example.com");
    const save = screen.getByRole("button", { name: "Save rule" });
    const deleteRule = screen.getByRole("button", { name: "Delete" });
    expect(save).toBeDisabled();
    expect(deleteRule).toBeDisabled();

    fireEvent.click(save);
    fireEvent.click(deleteRule);
    expect(sectionActions.createRule).not.toHaveBeenCalled();
    expect(sectionActions.requestDeleteRule).not.toHaveBeenCalled();
  });
});

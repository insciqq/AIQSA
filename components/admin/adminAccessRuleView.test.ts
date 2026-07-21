import { describe, expect, it } from "vitest";
import type { AdminAccessRuleRecord } from "@/lib/contracts/admin";
import { filterAdminAccessRules } from "./adminAccessRuleView";

const emailRule: AdminAccessRuleRecord = {
  defaultGroups: [{ groupId: "group-operators", name: "Operators", role: "member" }],
  enabled: true,
  id: "rule-email",
  kind: "email",
  value: "person@example.com"
};

const domainRule: AdminAccessRuleRecord = {
  defaultGroups: [{ groupId: "group-reviewers", name: "Reviewers", role: "member" }],
  enabled: true,
  id: "rule-domain",
  kind: "domain",
  value: "example.org"
};

describe("adminAccessRuleView", () => {
  it("filters rules by kind, value, or default-group text without changing server order", () => {
    const rules = [domainRule, emailRule];

    expect(filterAdminAccessRules(rules, "")).toEqual(rules);
    expect(filterAdminAccessRules(rules, "DOMAIN")).toEqual([domainRule]);
    expect(filterAdminAccessRules(rules, "person@example.com")).toEqual([emailRule]);
    expect(filterAdminAccessRules(rules, "operators")).toEqual([emailRule]);
    expect(filterAdminAccessRules(rules, "missing")).toEqual([]);
  });
});

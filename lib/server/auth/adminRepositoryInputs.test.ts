import { describe, expect, it } from "vitest";
import {
  adminProvisioningGroupInputs,
  normalizeAdminGroupName,
  normalizeAdminRuleValue
} from "./adminRepositoryInputs";

describe("admin repository inputs", () => {
  it("deduplicates provisioning groups in first-seen order and assigns the member role", () => {
    expect(adminProvisioningGroupInputs(undefined)).toEqual([]);
    expect(adminProvisioningGroupInputs([])).toEqual([]);
    expect(adminProvisioningGroupInputs(["group-b", "group-a", "group-b", "group-c", "group-a"])).toEqual([
      {
        groupId: "group-b",
        role: "member"
      },
      {
        groupId: "group-a",
        role: "member"
      },
      {
        groupId: "group-c",
        role: "member"
      }
    ]);
  });

  it("normalizes valid exact email and domain rules and rejects malformed values", () => {
    expect(normalizeAdminRuleValue("email", "  Person@Example.COM  ")).toBe("person@example.com");
    expect(normalizeAdminRuleValue("domain", "  Example.COM  ")).toBe("example.com");

    expect(normalizeAdminRuleValue("email", "person@example")).toBeNull();
    expect(normalizeAdminRuleValue("email", "person @example.com")).toBeNull();
    expect(normalizeAdminRuleValue("domain", "example")).toBeNull();
    expect(normalizeAdminRuleValue("domain", "person@example.com")).toBeNull();
    expect(normalizeAdminRuleValue("domain", "bad example.com")).toBeNull();
  });

  it("collapses group-name whitespace and enforces the inclusive length bounds", () => {
    expect(normalizeAdminGroupName("  Reviewers\n\tNorth  ")).toBe("Reviewers North");
    expect(normalizeAdminGroupName("a")).toBeNull();
    expect(normalizeAdminGroupName("ab")).toBe("ab");
    expect(normalizeAdminGroupName("x".repeat(80))).toBe("x".repeat(80));
    expect(normalizeAdminGroupName("x".repeat(81))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import {
  filterAdminGroups,
  groupDeletionInfo,
  resolveAdminGroupSelection
} from "./adminGroupView";

const catalog: AdminCatalog = {
  models: [{ displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" }],
  providers: [{ id: "openai", name: "OpenAI" }],
  searchStrategies: [{ displayName: "Web search", strategyId: "web" }]
};

const operators: AdminGroup = {
  accessGrants: [
    {
      enabled: true,
      groupId: "group-operators",
      id: "grant-provider",
      modelId: null,
      provider: "openai",
      searchStrategy: null,
      userId: null
    }
  ],
  archivedAt: null,
  id: "group-operators",
  name: "Operators",
  systemRole: null,
  userCount: 2
};

const reviewers: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-reviewers",
  name: "Reviewers",
  systemRole: null,
  userCount: 1
};

const archived: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators",
  systemRole: null,
  userCount: 0
};

describe("adminGroupView", () => {
  it("filters the Groups surface by status, name, and readable access summary", () => {
    const groups = [archived, reviewers, operators];

    expect(filterAdminGroups(groups, catalog, "all openai models", "active")).toEqual([operators]);
    expect(filterAdminGroups(groups, catalog, "former", "archived")).toEqual([archived]);
    expect(filterAdminGroups(groups, catalog, "", "active")).toEqual([reviewers, operators]);
    expect(filterAdminGroups(groups, catalog, "former", "active")).toEqual([]);
  });

  it("never auto-selects a group and resolves only an explicit visible id", () => {
    const groups = [archived, reviewers, operators];

    expect(resolveAdminGroupSelection(groups, null)).toBeNull();
    expect(resolveAdminGroupSelection(groups, "missing")).toBeNull();
    expect(resolveAdminGroupSelection(groups, archived.id)).toBe(archived);
    expect(resolveAdminGroupSelection([], operators.id)).toBeNull();
  });

  it("uses authoritative server deletion metadata for the built-in group", () => {
    const fullAccess: AdminGroup = {
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: false,
        reason: "system_group_forbidden",
        summary: "Full access is built in and cannot be deleted."
      },
      id: "full-access",
      name: "Full access",
      systemRole: "full_access",
      userCount: 1
    };

    expect(groupDeletionInfo(fullAccess)).toBe(fullAccess.deletion);
  });
});

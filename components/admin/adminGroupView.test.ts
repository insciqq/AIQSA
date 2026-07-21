import { describe, expect, it } from "vitest";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import {
  filterAdminGroups,
  filterAdminModelAccessGroups,
  resolveAdminGroupSelection,
  resolveAdminModelAccessGroupSelection
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
  userCount: 2
};

const reviewers: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-reviewers",
  name: "Reviewers",
  userCount: 1
};

const archived: AdminGroup = {
  accessGrants: [],
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Former operators",
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

  it("keeps archived groups searchable in Model access and preserves its active-first fallback", () => {
    const groups = [archived, reviewers, operators];
    const visible = filterAdminModelAccessGroups(groups, catalog, "");

    expect(visible).toEqual(groups);
    expect(filterAdminModelAccessGroups(groups, catalog, "archived groups no longer")).toEqual([archived]);
    expect(resolveAdminGroupSelection(visible, "missing")?.id).toBe(archived.id);
    expect(resolveAdminModelAccessGroupSelection(visible, "missing")?.id).toBe(reviewers.id);
    expect(resolveAdminModelAccessGroupSelection(visible, archived.id)?.id).toBe(archived.id);
    expect(resolveAdminModelAccessGroupSelection([archived], "missing")?.id).toBe(archived.id);
    expect(resolveAdminGroupSelection([], operators.id)).toBeNull();
  });
});

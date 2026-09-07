import { describe, expect, it } from "vitest";
import type { AdminAccessGrantRecord, AdminCatalog, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import { fixtureConnection, fixtureCredential } from "@/components/admin/providers/providerFixtures";
import {
  adminGroupFilterCounts,
  deriveAdminGroupRows,
  groupAccessCounts,
  groupAccessSummary,
  groupDeletionInfo,
  groupHeaderSummary,
  groupMemberCandidates,
  groupMembers,
  groupProviderKey,
  providerAccess,
  providerAccessLabel,
  providerModelChanges
} from "./groupsView";

const catalog: AdminCatalog = {
  models: [
    { displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "conn-openai" },
    { displayName: "GPT Mini", modelId: "gpt-mini", provider: "conn-openai" },
    { displayName: "Claude Opus 5", modelId: "opus-5", provider: "conn-anthropic" },
    { displayName: "Claude Sonnet 5", modelId: "sonnet-5", provider: "conn-anthropic" }
  ],
  providers: [{ id: "conn-openai", name: "OpenAI" }, { id: "conn-anthropic", name: "Anthropic" }],
  searchStrategies: [{ displayName: "OpenAI Search", strategyId: "openai-search" }]
};

function grant(overrides: Partial<AdminAccessGrantRecord> & { id: string }): AdminAccessGrantRecord {
  return { enabled: true, groupId: "group-research", modelId: null, provider: null, searchStrategy: null, userId: null, ...overrides };
}

function group(overrides: Partial<AdminGroup> & { id: string; name: string }): AdminGroup {
  return { accessGrants: [], archivedAt: null, systemRole: null, userCount: 0, ...overrides };
}

const research = group({
  accessGrants: [
    grant({ id: "g1", provider: "conn-openai" }),
    grant({ id: "g2", modelId: "opus-5", provider: "conn-anthropic" }),
    grant({ id: "g3", modelId: "retired", provider: "conn-anthropic" }),
    grant({ enabled: false, id: "g4", modelId: "sonnet-5", provider: "conn-anthropic" }),
    grant({ id: "g5", searchStrategy: "openai-search" }),
    grant({ id: "g6", searchStrategy: "gone-search" })
  ],
  id: "group-research",
  name: "Profile · Research",
  userCount: 3
});
const empty = group({ id: "group-empty", name: "Empty" });
const archived = group({ archivedAt: "2026-07-01T00:00:00.000Z", id: "group-old", name: "Former", userCount: 1 });
const fullAccess = group({ id: "group-full", name: "Full access", systemRole: "full_access", userCount: 1 });

function user(overrides: Partial<AdminUserRecord> & { id: string }): AdminUserRecord {
  return {
    displayName: overrides.id,
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: `${overrides.id}@example.com`,
    groups: [],
    hasVerifiedIdentity: true,
    lastSessionAt: null,
    role: "user",
    status: "active",
    ...overrides
  };
}

describe("groupsView", () => {
  it("reads provider access as all, some or none and labels it against the current catalog", () => {
    expect(providerAccess(research, "conn-openai")).toEqual({ kind: "all" });
    expect(providerAccess(research, "conn-anthropic")).toEqual({ kind: "some", modelIds: ["opus-5", "retired"] });
    expect(providerAccess(empty, "conn-openai")).toEqual({ kind: "none" });
    expect(providerAccessLabel({ kind: "all" }, 2)).toBe("All models, including ones added later");
    expect(providerAccessLabel({ kind: "some", modelIds: ["opus-5"] }, 2)).toBe("1 of 2 models");
    expect(providerAccessLabel({ kind: "some", modelIds: ["opus-5", "sonnet-5"] }, 2)).toBe("All current models");
    expect(providerAccessLabel({ kind: "none" }, 2)).toBe("No access");
  });

  it("counts effective access and ignores grants on models or Search sources the catalog no longer has", () => {
    expect(groupAccessCounts(research, catalog)).toEqual({ models: 3, providers: 2, search: 1 });
    expect(groupAccessSummary(research, catalog)).toBe("3 models · 1 Search source");
    expect(groupAccessSummary(empty, catalog)).toBe("No access");
    expect(groupAccessSummary(archived, catalog)).toBe("Archived · grants no longer apply");
    expect(groupAccessSummary(fullAccess, catalog)).toMatch(/^Everything/u);
    expect(groupHeaderSummary(research, catalog, 4)).toBe("3 members · 3 models · 1 Search source · 4 MCP servers");
    expect(groupHeaderSummary(research, catalog, null)).toBe("3 members · 3 models · 1 Search source");
    expect(groupHeaderSummary(fullAccess, catalog, null)).toBe("1 member · every provider, model, Search source and MCP server");
  });

  it("filters the list by status and query, keeps Full access first and counts the pills", () => {
    const groups = [research, archived, empty, fullAccess];
    expect(deriveAdminGroupRows({ catalog, filter: "active", groups, query: "" }).map((entry) => entry.id))
      .toEqual(["group-full", "group-empty", "group-research"]);
    expect(deriveAdminGroupRows({ catalog, filter: "archived", groups, query: "" }).map((entry) => entry.id))
      .toEqual(["group-old"]);
    expect(deriveAdminGroupRows({ catalog, filter: "all", groups, query: "research" }).map((entry) => entry.id))
      .toEqual(["group-research"]);
    expect(deriveAdminGroupRows({ catalog, filter: "all", groups, query: "no access" }).map((entry) => entry.id))
      .toEqual(["group-empty"]);
    expect(adminGroupFilterCounts(groups)).toEqual({ active: 3, all: 4, archived: 1 });
  });

  it("derives members, candidates and deletion blockers from the dashboard", () => {
    const users = [
      user({ displayName: "Camila", groups: [{ groupId: "group-research", name: "Profile · Research", role: "member" }], id: "camila" }),
      user({ displayName: "Ada", groups: [{ groupId: "group-research", name: "Profile · Research", role: "member" }], id: "ada" }),
      user({ displayName: "Grace", id: "grace" }),
      user({ displayName: "Paused", id: "paused", status: "disabled" })
    ];
    expect(groupMembers(users, "group-research").map((entry) => entry.id)).toEqual(["ada", "camila"]);
    expect(groupMemberCandidates(users, "group-research").map((entry) => entry.id)).toEqual(["grace"]);
    expect(groupDeletionInfo(research)).toMatchObject({ canDelete: false, reason: "group_has_members" });
    expect(groupDeletionInfo(group({ accessGrants: [grant({ id: "g", provider: "conn-openai" })], id: "granted", name: "Granted" })))
      .toMatchObject({ canDelete: false, reason: "group_has_grants" });
    expect(groupDeletionInfo(empty)).toMatchObject({ canDelete: true, reason: null });
    expect(groupDeletionInfo(fullAccess)).toMatchObject({ canDelete: false, reason: "system_group_forbidden" });
    expect(groupDeletionInfo({ ...empty, deletion: { canDelete: false, reason: "group_has_members", summary: "Server says no." } }).summary)
      .toBe("Server says no.");
  });

  it("shows the group's key override before the provider default and nothing without a key", () => {
    const connection = fixtureConnection({
      assignments: [{
        connectionId: "conn-openai",
        credentialId: "cred-research",
        group: { archivedAt: null, id: "group-research", name: "Profile · Research" },
        updatedAt: "2026-09-01T00:00:00.000Z"
      }],
      credentials: [
        fixtureCredential({ id: "cred-primary", label: "Primary" }),
        fixtureCredential({ id: "cred-research", label: "Research team" })
      ],
      defaultCredentialId: "cred-primary",
      displayName: "OpenAI",
      id: "conn-openai"
    });
    expect(groupProviderKey(connection, "group-research")).toEqual({ label: "Key: Research team", override: true });
    expect(groupProviderKey(connection, "group-empty")).toEqual({ label: "Key: Primary (default)", override: false });
    expect(groupProviderKey({ ...connection, defaultCredentialId: null }, "group-empty")).toBeNull();
    expect(groupProviderKey(null, "group-empty")).toBeNull();
  });

  it("builds one change per current provider model for the bulk actions", () => {
    expect(providerModelChanges(catalog, "conn-anthropic", true)).toEqual([
      { enabled: true, modelId: "opus-5", provider: "conn-anthropic" },
      { enabled: true, modelId: "sonnet-5", provider: "conn-anthropic" }
    ]);
    expect(providerModelChanges(catalog, "conn-none", false)).toEqual([]);
  });
});

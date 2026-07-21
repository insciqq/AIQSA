import { describe, expect, it } from "vitest";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import {
  activeGroupIdsForUser,
  deriveAdminUsersView,
  entitlementCountLabel,
  sortValueForUser,
  type AdminUsersViewInput,
  userDeletionInfo
} from "./adminUserView";

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-active",
  name: "Active group",
  userCount: 1
};

const archivedGroup: AdminGroup = {
  ...activeGroup,
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Archived group"
};

function user(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  return {
    displayName: "Active User",
    effectiveEntitlements: {
      models: [{ modelId: "gpt-5.5", provider: "openai" }],
      providers: ["openai"],
      searchStrategies: ["web"]
    },
    email: "active@example.com",
    groups: [
      { groupId: activeGroup.id, name: activeGroup.name, role: "member" },
      { groupId: archivedGroup.id, name: archivedGroup.name, role: "member" }
    ],
    hasVerifiedIdentity: true,
    id: "user-active",
    lastSessionAt: "2026-07-12T08:00:00.000Z",
    role: "user",
    status: "active",
    ...overrides
  };
}

describe("adminUserView", () => {
  it("derives every user sort key and entitlement label deterministically", () => {
    const record = user();

    expect(sortValueForUser(record, "access")).toBe(3);
    expect(sortValueForUser(record, "groups")).toBe("active group, archived group");
    expect(sortValueForUser(record, "lastSession")).toBe(Date.parse("2026-07-12T08:00:00.000Z"));
    expect(sortValueForUser(record, "role")).toBe("user");
    expect(sortValueForUser(record, "status")).toBe("active");
    expect(sortValueForUser(record, "user")).toBe("active user active@example.com");
    expect(entitlementCountLabel(record.effectiveEntitlements)).toBe("1 provider / 1 model / 1 search");
  });

  it("filters archived memberships and preserves deletion safety fallbacks", () => {
    const record = user({ deletion: undefined, status: "disabled" });

    expect(activeGroupIdsForUser(record, [activeGroup, archivedGroup])).toEqual([activeGroup.id]);
    expect(userDeletionInfo(record, "admin-current")).toEqual({
      canDelete: true,
      reason: null,
      summary: "No app-owned records detected; auth request data can be removed."
    });
    expect(userDeletionInfo(record, record.id)).toEqual({
      canDelete: false,
      reason: "active_user",
      summary: "Your current admin account cannot delete itself."
    });
  });

  it("filters, sorts, and clamps pagination without overwriting the requested selection", () => {
    const alpha = user({ displayName: "Alpha User", email: "alpha@example.com", id: "user-alpha" });
    const beta = user({ displayName: "Beta User", email: "beta@example.com", id: "user-beta" });
    const pending = user({
      displayName: "Pending User",
      email: "pending@example.com",
      id: "user-pending",
      status: "pending"
    });
    const input: AdminUsersViewInput = {
      pageIndex: 8,
      pageSize: 2,
      query: "",
      selectedUserId: beta.id,
      sortDirection: "asc",
      sortKey: "user",
      statusFilter: "all",
      users: [pending, beta, alpha]
    };
    const lastPage = deriveAdminUsersView(input);

    expect(lastPage.filteredUsers.map((record) => record.id)).toEqual([alpha.id, beta.id, pending.id]);
    expect(lastPage.pageCount).toBe(2);
    expect(lastPage.pageIndex).toBe(1);
    expect(lastPage.pageStart).toBe(3);
    expect(lastPage.pageEnd).toBe(3);
    expect(lastPage.pageUsers.map((record) => record.id)).toEqual([pending.id]);
    expect(lastPage.selectedUser?.id).toBe(pending.id);
    expect(input.selectedUserId).toBe(beta.id);

    const selectedPage = deriveAdminUsersView({ ...input, pageIndex: 0 });
    expect(selectedPage.selectedUser?.id).toBe(beta.id);
  });

  it("matches user status and searchable identity, role, status, and group text", () => {
    const pending = user({
      displayName: "Waiting Person",
      email: "pending@example.com",
      id: "user-pending",
      status: "pending"
    });
    const active = user({ id: "user-active" });

    expect(
      deriveAdminUsersView({
        pageIndex: 0,
        pageSize: 25,
        query: "ARCHIVED GROUP",
        selectedUserId: null,
        sortDirection: "desc",
        sortKey: "status",
        statusFilter: "active",
        users: [pending, active]
      }).filteredUsers.map((record) => record.id)
    ).toEqual([active.id]);
    expect(
      deriveAdminUsersView({
        pageIndex: 0,
        pageSize: 25,
        query: "pending@example.com",
        selectedUserId: null,
        sortDirection: "asc",
        sortKey: "user",
        statusFilter: "pending",
        users: [active, pending]
      }).filteredUsers.map((record) => record.id)
    ).toEqual([pending.id]);
  });
});

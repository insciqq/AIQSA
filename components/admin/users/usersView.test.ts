import { describe, expect, it } from "vitest";
import type { AdminGroup, AdminInviteRecord, AdminUserRecord } from "@/lib/contracts/admin";
import {
  adminUserFilterCounts,
  deriveAdminUserRows,
  formatLastSeen,
  inviteDeletionInfo,
  inviteDeliveryLabel,
  inviteExpiryLabel,
  inviteStaleLabel,
  openInvites,
  parseAdminUserListFilter,
  staleInvites,
  userAccessSummary,
  userDeletionInfo,
  userInitials,
  userStatusRowClass,
  visibleAdminUserFilters
} from "./usersView";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

const operators: AdminGroup = {
  accessGrants: [
    { enabled: true, groupId: "group-ops", id: "g1", modelId: "gpt-5.5", provider: "openai", searchStrategy: null, userId: null },
    { enabled: true, groupId: "group-ops", id: "g2", modelId: null, provider: null, searchStrategy: "web", userId: null },
    { enabled: false, groupId: "group-ops", id: "g3", modelId: "gpt-mini", provider: "openai", searchStrategy: null, userId: null }
  ],
  archivedAt: null,
  id: "group-ops",
  name: "operators",
  systemRole: null,
  userCount: 2
};
const archived: AdminGroup = { ...operators, accessGrants: [], archivedAt: "2026-07-01T00:00:00.000Z", id: "group-old", name: "old" };
const fullAccess: AdminGroup = { ...operators, accessGrants: [], id: "group-full", name: "Full access", systemRole: "full_access" };
const groups = [operators, archived, fullAccess];

function user(overrides: Partial<AdminUserRecord>): AdminUserRecord {
  return {
    directGrants: [],
    displayName: "Ada Analyst",
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: "ada@example.com",
    groups: [],
    hasVerifiedIdentity: true,
    id: "ada",
    lastSessionAt: null,
    role: "user",
    status: "active",
    ...overrides
  };
}

function invite(overrides: Partial<AdminInviteRecord>): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [],
    email: "new@example.com",
    expiresAt: "2026-09-13T12:00:00.000Z",
    id: "invite",
    normalizedEmail: "new@example.com",
    revokedAt: null,
    ...overrides
  };
}

describe("usersView", () => {
  it("summarizes access per status and membership", () => {
    const withAccess = user({
      effectiveEntitlements: { models: [{ modelId: "a", provider: "openai" }, { modelId: "b", provider: "openai" }], providers: ["openai"], searchStrategies: ["web"] },
      groups: [{ groupId: "group-ops", name: "operators", role: "member" }]
    });
    expect(userAccessSummary(withAccess, groups)).toEqual({ label: "1 provider · 2 models · 1 search", tone: "normal" });
    expect(userAccessSummary(user({}), groups)).toEqual({ label: "No model access", tone: "caution" });
    expect(userAccessSummary(user({ groups: [{ groupId: "group-full", name: "Full access", role: "owner" }] }), groups))
      .toEqual({ label: "everything", tone: "normal" });
    expect(userAccessSummary(user({ status: "pending" }), groups)).toEqual({ label: "via group after approval", tone: "normal" });
    expect(userAccessSummary(user({ status: "disabled" }), groups)).toEqual({ label: "—", tone: "muted" });
    expect(userAccessSummary(user({ status: "denied" }), groups)).toEqual({ label: "—", tone: "muted" });
  });

  it("derives initials and last-seen labels", () => {
    expect(userInitials({ displayName: "Ada Analyst", email: null })).toBe("AA");
    expect(userInitials({ displayName: "Profile shadow owner", email: null })).toBe("PO");
    expect(userInitials({ displayName: "Solo", email: null })).toBe("SO");
    expect(userInitials({ displayName: " ", email: "zed@example.com" })).toBe("Z");
    const now = new Date(NOW);
    expect(formatLastSeen(null, now)).toBe("never");
    expect(formatLastSeen("2026-09-07T11:59:30.000Z", now)).toBe("just now");
    expect(formatLastSeen("2026-09-03T16:04:00.000Z", now)).toMatch(/^Sep 3, \d{2}:\d{2}$/u);
    expect(formatLastSeen("2025-09-03T16:04:00.000Z", now)).toMatch(/^Sep 3, 2025, \d{2}:\d{2}$/u);
    expect(formatLastSeen("not-a-date", now)).toBe("never");
  });

  it("orders pending users first, applies query and filter, and counts every pill", () => {
    const users = [
      user({ displayName: "Zoe", id: "zoe", groups: [{ groupId: "group-ops", name: "operators", role: "member" }], effectiveEntitlements: { models: [{ modelId: "a", provider: "openai" }], providers: [], searchStrategies: [] } }),
      user({ displayName: "Bob", email: "bob@example.com", id: "bob", status: "disabled" }),
      user({ displayName: "Pat", email: "pat@example.com", id: "pat", status: "pending" }),
      user({ displayName: "Dan", email: "dan@example.com", id: "dan", status: "denied" }),
      user({ displayName: "Nia", email: "nia@example.com", id: "nia" })
    ];
    expect(deriveAdminUserRows({ filter: "all", groups, query: "", users }).map((row) => row.id))
      .toEqual(["pat", "nia", "zoe", "bob", "dan"]);
    expect(deriveAdminUserRows({ filter: "all", groups, query: "OPERATORS", users }).map((row) => row.id)).toEqual(["zoe"]);
    expect(deriveAdminUserRows({ filter: "pending", groups, query: "", users }).map((row) => row.id)).toEqual(["pat"]);
    expect(deriveAdminUserRows({ filter: "no-model-access", groups, query: "", users }).map((row) => row.id)).toEqual(["nia"]);
    expect(deriveAdminUserRows({ filter: "invited", groups, query: "", users })).toEqual([]);

    const counts = adminUserFilterCounts({ groups, openInviteCount: 2, users });
    expect(counts).toEqual({ all: 5, denied: 1, disabled: 1, invited: 2, "no-model-access": 1, pending: 1 });
    expect(visibleAdminUserFilters(counts, "all")).toEqual(["all", "pending", "invited", "disabled", "denied", "no-model-access"]);
    expect(visibleAdminUserFilters({ ...counts, "no-model-access": 0 }, "all")).toEqual(["all", "pending", "invited", "disabled", "denied"]);
    expect(visibleAdminUserFilters({ ...counts, "no-model-access": 0 }, "no-model-access")).toContain("no-model-access");
    expect(parseAdminUserListFilter("pending")).toBe("pending");
    expect(parseAdminUserListFilter("no-model-access")).toBe("no-model-access");
    expect(parseAdminUserListFilter("nonsense")).toBe("all");
    expect(parseAdminUserListFilter(null)).toBe("all");
  });

  it("keeps deletion safety fallbacks and the status row treatment", () => {
    const disabled = user({ status: "disabled" });
    expect(userDeletionInfo(disabled, "admin-current")).toEqual({
      canDelete: true,
      reason: null,
      summary: "No app-owned records detected; auth request data can be removed."
    });
    expect(userDeletionInfo(disabled, disabled.id).canDelete).toBe(false);
    expect(userDeletionInfo(user({ deletion: { canDelete: false, reason: "user_has_owned_data", summary: "Owns data." } }), "x").summary)
      .toBe("Owns data.");
    expect(userStatusRowClass("pending")).toContain("caution");
    expect(userStatusRowClass("active")).toContain("positive");
  });

  it("splits invites into open and stale with expiry, delivery and deletion labels", () => {
    const open = invite({ id: "open" });
    const soon = invite({ expiresAt: "2026-09-08T09:00:00.000Z", id: "soon" });
    const expired = invite({ expiresAt: "2026-09-01T12:00:00.000Z", id: "expired" });
    const revoked = invite({ id: "revoked", revokedAt: "2026-09-03T12:00:00.000Z" });
    const accepted = invite({ acceptedAt: "2026-09-02T12:00:00.000Z", id: "accepted" });
    expect(openInvites([open, soon, expired, revoked, accepted], NOW).map((entry) => entry.id)).toEqual(["soon", "open"]);
    expect(staleInvites([open, soon, expired, revoked, accepted], NOW).map((entry) => entry.id)).toEqual(["revoked", "expired"]);
    expect(inviteExpiryLabel(open, NOW)).toBe("expires in 6 days");
    expect(inviteExpiryLabel(soon, NOW)).toBe("expires today");
    expect(inviteExpiryLabel(invite({ expiresAt: "2026-09-08T13:00:00.000Z" }), NOW)).toBe("expires in 1 day");
    expect(inviteStaleLabel(revoked, NOW)).toBe("revoked Sep 3");
    expect(inviteStaleLabel(expired, NOW)).toBe("expired Sep 1");
    expect(inviteDeliveryLabel("sent")).toBe("email sent");
    expect(inviteDeliveryLabel("failed")).toBe("email failed — share the link manually");
    expect(inviteDeletionInfo(open, NOW)).toMatchObject({ canDelete: false, reason: "invite_open" });
    expect(inviteDeletionInfo(expired, NOW)).toMatchObject({ canDelete: true, reason: null });
    expect(inviteDeletionInfo(accepted, NOW)).toMatchObject({ canDelete: false, reason: "invite_accepted" });
    expect(inviteDeletionInfo(invite({ deletion: { canDelete: false, reason: "invite_open", summary: "Server says no." } }), NOW).summary)
      .toBe("Server says no.");
  });
});

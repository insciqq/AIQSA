import { describe, expect, it } from "vitest";
import type { AdminDashboard, AdminInviteRecord, AdminUserRecord } from "@/lib/contracts/admin";
import { deriveAdminDashboardOverview } from "./adminDashboardView";

const nowMs = Date.parse("2026-07-12T00:00:00.000Z");

function user(
  id: string,
  status: AdminUserRecord["status"],
  hasAccess = false
): AdminUserRecord {
  return {
    displayName: id,
    effectiveEntitlements: {
      models: hasAccess ? [{ modelId: "gpt-5.5", provider: "openai" }] : [],
      providers: [],
      searchStrategies: []
    },
    email: `${id}@example.com`,
    groups: [],
    hasVerifiedIdentity: true,
    id,
    lastSessionAt: null,
    role: "user",
    status
  };
}

function invite(id: string, overrides: Partial<AdminInviteRecord> = {}): AdminInviteRecord {
  return {
    acceptedAt: null,
    defaultGroups: [],
    email: `${id}@example.com`,
    expiresAt: "2026-07-20T00:00:00.000Z",
    id,
    normalizedEmail: `${id}@example.com`,
    revokedAt: null,
    ...overrides
  };
}

const dashboard: AdminDashboard = {
  accessRules: [
    {
      defaultGroups: [],
      enabled: true,
      id: "rule-1",
      kind: "email",
      value: "person@example.com"
    }
  ],
  catalog: {
    models: [
      { displayName: "GPT 5.5", modelId: "gpt-5.5", provider: "openai" },
      { displayName: "GPT Mini", modelId: "gpt-mini", provider: "openai" }
    ],
    providers: [{ id: "openai", name: "OpenAI" }],
    searchStrategies: [{ displayName: "Web search", strategyId: "web" }]
  },
  groups: [
    {
      accessGrants: [],
      archivedAt: null,
      id: "group-active",
      name: "Active",
      userCount: 1
    },
    {
      accessGrants: [],
      archivedAt: "2026-07-01T00:00:00.000Z",
      id: "group-archived",
      name: "Archived",
      userCount: 0
    }
  ],
  invites: [
    invite("open"),
    invite("soon", { expiresAt: "2026-07-15T00:00:00.000Z" }),
    invite("accepted", { acceptedAt: "2026-07-11T00:00:00.000Z" }),
    invite("revoked", { revokedAt: "2026-07-11T00:00:00.000Z" }),
    invite("expired", { expiresAt: "2026-07-11T00:00:00.000Z" })
  ],
  usage: {
    byGroup: [],
    byUser: [],
    totals: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      lastUsedAt: null,
      outputTokens: 0,
      reasoningTokens: 0,
      runCount: 0,
      totalTokens: 0
    }
  },
  users: [
    user("active-no-access", "active"),
    user("active-with-access", "active", true),
    user("pending", "pending"),
    user("disabled", "disabled"),
    user("denied", "denied")
  ]
};

describe("adminDashboardView", () => {
  it("derives summary and attention inventory against the supplied refresh clock", () => {
    const overview = deriveAdminDashboardOverview(dashboard, nowMs);

    expect(overview).toMatchObject({
      acceptedInvites: 1,
      accessRules: 1,
      activeGroups: 1,
      activeUsers: 2,
      hasAttention: true,
      inactiveUsers: 2,
      revokedInvites: 1,
      totalGroups: 2,
      totalInvites: 5,
      totalUsers: 5
    });
    expect(overview.pendingUsers.map((record) => record.id)).toEqual(["pending"]);
    expect(overview.noAccessUsers.map((record) => record.id)).toEqual(["active-no-access"]);
    expect(overview.openInvites.map((record) => record.id)).toEqual(["open", "soon"]);
    expect(overview.soonExpiringInvites.map((record) => record.id)).toEqual(["soon"]);

    expect(
      deriveAdminDashboardOverview(dashboard, Date.parse("2026-07-21T00:00:00.000Z")).openInvites
    ).toEqual([]);
  });

  it("provides a stable empty overview before the dashboard is available", () => {
    expect(deriveAdminDashboardOverview(null, 0)).toEqual({
      acceptedInvites: 0,
      accessRules: 0,
      activeGroups: 0,
      activeUsers: 0,
      hasAttention: false,
      inactiveUsers: 0,
      noAccessUsers: [],
      openInvites: [],
      pendingUsers: [],
      revokedInvites: 0,
      soonExpiringInvites: [],
      totalGroups: 0,
      totalInvites: 0,
      totalUsers: 0
    });
  });
});

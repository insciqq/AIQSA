import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { adminActionNames, isAdminDashboard } from "@/lib/contracts/admin";
import type { AdminActionRequest, AdminActionResponse, AdminDashboard } from "@/lib/contracts/admin";
import {
  adminActionErrorMessage,
  adminDashboardErrorMessage,
  readAdminActionResult,
  requestAdminAction,
  requestAdminDashboard
} from "./adminApi";

function emptyDashboard(): AdminDashboard {
  return {
    accessRules: [],
    catalog: {
      models: [],
      providers: [],
      searchStrategies: []
    },
    groups: [],
    invites: [],
    navigation: {
      advancedConfigured: false,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 0,
        pendingUsers: 0
      },
      teamConfigured: false
    },
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
    users: []
  };
}

function invalidJsonResponse(status = 200): Response {
  return new Response("{", {
    headers: {
      "content-type": "application/json"
    },
    status
  });
}

describe("admin API client", () => {
  it("keeps the exact shared action discriminant inventory visible", () => {
    expect(adminActionNames).toHaveLength(17);
    expectTypeOf<Exclude<AdminActionRequest["action"], (typeof adminActionNames)[number]>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<(typeof adminActionNames)[number], AdminActionRequest["action"]>>().toEqualTypeOf<never>();
  });

  it("accepts the intentionally shallow dashboard shape and additive fields", () => {
    const dashboard = {
      ...emptyDashboard(),
      futureRootField: true,
      users: [{ futureUserShape: true }]
    };

    expect(isAdminDashboard(dashboard)).toBe(true);
  });

  it.each([
    ["access rules", { ...emptyDashboard(), accessRules: null }],
    ["catalog models", { ...emptyDashboard(), catalog: { ...emptyDashboard().catalog, models: null } }],
    ["catalog providers", { ...emptyDashboard(), catalog: { ...emptyDashboard().catalog, providers: null } }],
    [
      "catalog search strategies",
      { ...emptyDashboard(), catalog: { ...emptyDashboard().catalog, searchStrategies: null } }
    ],
    ["groups", { ...emptyDashboard(), groups: null }],
    ["invites", { ...emptyDashboard(), invites: null }],
    ["navigation", { ...emptyDashboard(), navigation: null }],
    [
      "navigation attention",
      { ...emptyDashboard(), navigation: { ...emptyDashboard().navigation, attention: null } }
    ],
    [
      "navigation disclosure booleans",
      { ...emptyDashboard(), navigation: { ...emptyDashboard().navigation, teamConfigured: null } }
    ],
    [
      "navigation attention counts",
      {
        ...emptyDashboard(),
        navigation: {
          ...emptyDashboard().navigation,
          attention: { ...emptyDashboard().navigation.attention, pendingUsers: -1 }
        }
      }
    ],
    ["usage groups", { ...emptyDashboard(), usage: { ...emptyDashboard().usage, byGroup: null } }],
    ["usage users", { ...emptyDashboard(), usage: { ...emptyDashboard().usage, byUser: null } }],
    ["usage totals", { ...emptyDashboard(), usage: { byGroup: [], byUser: [] } }],
    ["users", { ...emptyDashboard(), users: null }]
  ])("rejects a dashboard without the required shallow %s collection", (_label, dashboard) => {
    expect(isAdminDashboard(dashboard)).toBe(false);
  });

  it("loads the bare dashboard from the unchanged GET endpoint", async () => {
    const dashboard = emptyDashboard();
    const fetcher = vi.fn(async () => Response.json(dashboard));

    await expect(requestAdminDashboard(fetcher)).resolves.toEqual({ dashboard, ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/admin");
  });

  it("disambiguates duplicate dashboard connection names at the client boundary", async () => {
    const dashboard = emptyDashboard();
    dashboard.catalog.providers = [
      { id: "connection-a", name: "Shared gateway" },
      { id: "connection-b", name: " shared   gateway " }
    ];

    const result = await requestAdminDashboard(async () => Response.json(dashboard));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dashboard.catalog.providers.map(({ name }) => name)).toEqual([
      expect.stringMatching(/^Shared gateway · ref [0-9A-Z]{6,}$/u),
      expect.stringMatching(/^ shared   gateway  · ref [0-9A-Z]{6,}$/u)
    ]);
  });

  it.each([
    ["invalid JSON", invalidJsonResponse()],
    ["an empty response", new Response(null, { status: 200 })],
    ["a malformed dashboard", Response.json({ users: [] })]
  ])("maps successful %s to the stable dashboard fallback", async (_label, response) => {
    await expect(requestAdminDashboard(async () => response)).resolves.toEqual({
      error: "admin_dashboard_failed",
      ok: false
    });
  });

  it("preserves a non-success dashboard error code and maps fetch failures", async () => {
    await expect(
      requestAdminDashboard(async () => Response.json({ error: "forbidden" }, { status: 403 }))
    ).resolves.toEqual({ error: "forbidden", ok: false });
    await expect(
      requestAdminDashboard(async () => {
        throw new Error("offline");
      })
    ).resolves.toEqual({ error: "network_error", ok: false });
    await expect(
      requestAdminDashboard(async () => new Response(null, { status: 503 }))
    ).resolves.toEqual({ error: "admin_dashboard_failed", ok: false });
  });

  it("posts the exact shared action body and preserves a successful invite result", async () => {
    const body = {
      action: "create_invite",
      email: "person@example.com",
      groupIds: ["group-1"],
      sendEmail: true
    } satisfies AdminActionRequest;
    const response = {
      emailDelivery: "sent",
      invite: {
        acceptedAt: null,
        defaultGroups: [],
        email: "person@example.com",
        expiresAt: "2026-07-19T00:00:00.000Z",
        id: "invite-1",
        normalizedEmail: "person@example.com",
        revokedAt: null
      },
      inviteUrl: "https://aiqsa.example/login?invite=secret"
    } satisfies AdminActionResponse;
    const fetcher = vi.fn(async () => Response.json(response));

    await expect(requestAdminAction(body, fetcher)).resolves.toMatchObject({
      emailDelivery: "sent",
      inviteUrl: "https://aiqsa.example/login?invite=secret"
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/action", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
  });

  it.each([
    ["invalid JSON", invalidJsonResponse()],
    ["an empty response", new Response(null, { status: 204 })]
  ])("keeps a successful action with %s compatible as an empty result", async (_label, response) => {
    await expect(readAdminActionResult(response)).resolves.toEqual({});
  });

  it("preserves action errors and applies stable failed-response and network fallbacks", async () => {
    await expect(
      readAdminActionResult(Response.json({ error: "group_has_grants" }, { status: 400 }))
    ).resolves.toEqual({ error: "group_has_grants" });
    for (const response of [invalidJsonResponse(500), new Response(null, { status: 500 })]) {
      await expect(readAdminActionResult(response)).resolves.toEqual({
        error: "admin_action_failed"
      });
    }
    await expect(
      requestAdminAction(
        { action: "revoke_all_sessions" },
        async () => {
          throw new Error("offline");
        }
      )
    ).resolves.toEqual({ error: "network_error" });
  });

  it("keeps stable readable error mappings and their historical unknown fallbacks", () => {
    expect(adminActionErrorMessage("invalid_origin")).toContain("same-origin security check");
    expect(adminActionErrorMessage("clipboard_unavailable")).toContain("copied");
    expect(adminActionErrorMessage("invite_email_delivery_invalid")).toContain("whether to email");
    expect(adminActionErrorMessage("self_disable_forbidden")).toContain("cannot disable itself");
    expect(adminActionErrorMessage("last_admin_forbidden")).toContain("final active administrator");
    expect(adminActionErrorMessage("future_action_error")).toBe(
      "The admin action could not be completed. Review the current data and try again."
    );
    expect(adminDashboardErrorMessage("Server maintenance in progress")).toBe("Server maintenance in progress");
    expect(adminDashboardErrorMessage("future_dashboard_error")).toBe(
      "Admin data could not be loaded. Check the server and try Refresh."
    );
  });

  it.each([
    ["admin_dashboard_failed", "Admin data could not be loaded. Check the server and try Refresh."],
    ["forbidden", "Your account no longer has permission to view the admin console."],
    ["network_error", "Could not reach the admin API. Check the connection and try Refresh."],
    ["unauthorized", "Your admin session is no longer valid. Sign in again to continue."]
  ] as const)("maps the stable dashboard code %s", (code, message) => {
    expect(adminDashboardErrorMessage(code)).toBe(message);
  });
});

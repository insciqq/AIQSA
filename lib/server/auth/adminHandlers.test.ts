import { describe, expect, it, vi } from "vitest";
import {
  createAdminActionHandler,
  createAdminDashboardHandler
} from "./adminHandlers";
import type {
  AdminAccessRuleRecord,
  AdminDashboard,
  AdminInviteRecord
} from "@/lib/contracts/admin";
import type { AdminRepository } from "./adminRepositoryContract";
import { createMemoryAuthMailer, createNoopAuthMailer } from "./mailer";
import { createTestAuth } from "./testRequestAuth";
import { hashToken } from "./token";

const admin = createTestAuth();
const baseDashboard = {
  accessRules: [],
  catalog: {
    models: [],
    providers: [],
    searchStrategies: []
  },
  groups: [
    {
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No members or active grants; this group can be deleted."
      },
      id: "group-1",
      name: "operators",
      systemRole: null,
      userCount: 0
    }
  ],
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
} satisfies AdminDashboard;

function jsonRequest(body: Record<string, unknown>, cookie = admin.cookie): Request {
  return new Request("https://aiqsa.local/api/admin/action", {
    body: JSON.stringify(body),
    headers: {
      cookie,
      "content-type": "application/json"
    },
    method: "POST"
  });
}

function createRepository(
  overrides: Partial<AdminRepository> = {},
  user: { role: "admin" | "user"; status: "active" | "disabled" | "pending" | "denied" } = {
    role: "admin",
    status: "active"
  }
): AdminRepository {
  return {
    archiveGroup: async () => true,
    approveUser: async () => "approved",
    createAccessRule: async (input) =>
      ({
        defaultGroups: [],
        enabled: true,
        id: "rule-1",
        kind: input.kind,
        value: input.value
      }) satisfies AdminAccessRuleRecord,
    createInvite: async (input) =>
      ({
        acceptedAt: null,
        deletion: {
          canDelete: false,
          reason: "invite_open",
          summary: "Revoke this open invite before deleting it."
        },
        defaultGroups: [],
        email: input.email,
        expiresAt: input.expiresAt.toISOString(),
        id: "invite-1",
        normalizedEmail: input.email.toLowerCase(),
        revokedAt: null
      }) satisfies AdminInviteRecord,
    createGroup: async (input) => ({
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No members or active grants; this group can be deleted."
      },
      id: "group-created",
      name: input.name,
      systemRole: null,
      userCount: 0
    }),
    deleteAccessRule: async () => true,
    deleteEmptyGroup: async () => "deleted",
    deleteStaleInvite: async () => "deleted",
    deleteStaleUser: async () => "deleted",
    disableUser: async () => "disabled",
    findAdminUser: async () => ({
      id: admin.session.userId,
      role: user.role,
      status: user.status
    }),
    listDashboard: async () => baseDashboard,
    rejectUser: async () => "rejected",
    renameGroup: async (input) => ({
      accessGrants: [],
      archivedAt: null,
      deletion: {
        canDelete: true,
        reason: null,
        summary: "No members or active grants; this group can be deleted."
      },
      id: input.groupId,
      name: input.name,
      systemRole: null,
      userCount: 0
    }),
    revokeAllSessions: async () => 3,
    revokeInvite: async () => true,
    revokeUserSessions: async () => 2,
    setGroupGrant: async () => true,
    setUserGroups: async () => true,
    ...overrides
  };
}

describe("admin route handlers", () => {
  it("requires an active admin user for dashboard data", async () => {
    const anonymousListDashboard = vi.fn(async () => baseDashboard);
    const nonAdminListDashboard = vi.fn(async () => baseDashboard);
    const anonymousGET = createAdminDashboardHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      repository: createRepository({
        listDashboard: anonymousListDashboard
      }),
      resolveAuth: async () => null
    });
    const nonAdminGET = createAdminDashboardHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      repository: createRepository(
        {
          listDashboard: nonAdminListDashboard
        },
        { role: "user", status: "active" }
      ),
      resolveAuth: createTestAuth({ user: { role: "user" } }).resolveAuth
    });

    const anonymousResponse = await anonymousGET(new Request("https://aiqsa.local/api/admin"));
    const nonAdminResponse = await nonAdminGET(
      new Request("https://aiqsa.local/api/admin", { headers: { cookie: admin.cookie } })
    );

    expect(anonymousResponse.status).toBe(401);
    await expect(anonymousResponse.json()).resolves.toEqual({ error: "unauthorized" });
    expect(nonAdminResponse.status).toBe(403);
    await expect(nonAdminResponse.json()).resolves.toEqual({ error: "forbidden" });
    expect(anonymousListDashboard).not.toHaveBeenCalled();
    expect(nonAdminListDashboard).not.toHaveBeenCalled();
  });

  it("returns the bare dashboard to an active admin with exactly one dashboard read", async () => {
    const listDashboard = vi.fn(async () => baseDashboard);
    const GET = createAdminDashboardHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      repository: createRepository({
        listDashboard
      }),
      resolveAuth: admin.resolveAuth
    });

    const response = await GET(
      new Request("https://aiqsa.local/api/admin", {
        headers: {
          cookie: admin.cookie
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(baseDashboard);
    expect(listDashboard).toHaveBeenCalledOnce();
    expect(listDashboard).toHaveBeenCalledWith(admin.session.userId);
  });

  it("preserves request-format and action-discriminant errors", async () => {
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository(),
      resolveAuth: admin.resolveAuth
    });
    const wrongContentType = await POST(
      new Request("https://aiqsa.local/api/admin/action", {
        body: "{}",
        headers: { cookie: admin.cookie, "content-type": "text/plain" },
        method: "POST"
      })
    );
    const malformedJson = await POST(
      new Request("https://aiqsa.local/api/admin/action", {
        body: "{",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        method: "POST"
      })
    );
    const missingAction = await POST(jsonRequest({}));
    const unknownAction = await POST(jsonRequest({ action: "future_admin_action" }));

    expect(wrongContentType.status).toBe(415);
    await expect(wrongContentType.json()).resolves.toEqual({ error: "json_required" });
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toEqual({ error: "action_required" });
    expect(missingAction.status).toBe(400);
    await expect(missingAction.json()).resolves.toEqual({ error: "action_required" });
    expect(unknownAction.status).toBe(400);
    await expect(unknownAction.json()).resolves.toEqual({ error: "action_unknown" });
  });

  it("preserves validation and nonuniform repository failure statuses", async () => {
    const failureCases: {
      body: Record<string, unknown>;
      error: string;
      name: string;
      overrides?: Partial<AdminRepository>;
      status: number;
    }[] = [
      { body: { action: "approve_user" }, error: "user_required", name: "user required", status: 400 },
      { body: { action: "create_group" }, error: "group_required", name: "group required", status: 400 },
      {
        body: { action: "set_group_grant", groupId: "group-1" },
        error: "group_grant_required",
        name: "grant required",
        status: 400
      },
      {
        body: { action: "create_access_rule", kind: "prefix", value: "example.com" },
        error: "access_rule_required",
        name: "rule required",
        status: 400
      },
      { body: { action: "create_invite" }, error: "email_required", name: "email required", status: 400 },
      { body: { action: "revoke_invite" }, error: "invite_required", name: "invite required", status: 400 },
      {
        body: { action: "create_invite", email: "friend@example.com", sendEmail: "yes" },
        error: "invite_email_delivery_invalid",
        name: "invite email delivery invalid",
        status: 400
      },
      {
        body: { action: "approve_user", userId: "user-1" },
        error: "user_not_verified",
        name: "approve unverified",
        overrides: { approveUser: async () => "not_verified" },
        status: 400
      },
      {
        body: { action: "approve_user", userId: "user-1" },
        error: "user_not_found",
        name: "approve missing keeps historical 400",
        overrides: { approveUser: async () => "not_found" },
        status: 400
      },
      {
        body: { action: "disable_user", userId: "user-1" },
        error: "user_not_found",
        name: "disable missing",
        overrides: { disableUser: async () => "not_found" },
        status: 404
      },
      {
        body: { action: "disable_user", userId: "user-1" },
        error: "self_disable_forbidden",
        name: "self disable forbidden",
        overrides: { disableUser: async () => "self_disable_forbidden" },
        status: 403
      },
      {
        body: { action: "disable_user", userId: "user-1" },
        error: "last_admin_forbidden",
        name: "last active admin forbidden",
        overrides: { disableUser: async () => "last_admin_forbidden" },
        status: 409
      },
      {
        body: { action: "reject_user", userId: "user-1" },
        error: "user_not_found",
        name: "reject missing",
        overrides: { rejectUser: async () => "not_found" },
        status: 404
      },
      {
        body: { action: "create_group", name: "duplicate" },
        error: "group_invalid",
        name: "invalid group",
        overrides: { createGroup: async () => null },
        status: 400
      },
      {
        body: { action: "rename_group", groupId: "group-1", name: "missing" },
        error: "group_not_found",
        name: "rename missing",
        overrides: { renameGroup: async () => null },
        status: 404
      },
      {
        body: { action: "set_group_grant", enabled: true, groupId: "group-1" },
        error: "group_grant_invalid",
        name: "invalid grant",
        overrides: { setGroupGrant: async () => false },
        status: 400
      },
      {
        body: { action: "create_access_rule", groupIds: [], kind: "domain", value: "example.com" },
        error: "access_rule_invalid",
        name: "invalid rule",
        overrides: { createAccessRule: async () => null },
        status: 400
      },
      {
        body: { action: "delete_access_rule", ruleId: "rule-1" },
        error: "access_rule_not_found",
        name: "delete missing rule",
        overrides: { deleteAccessRule: async () => false },
        status: 404
      },
      {
        body: { action: "delete_user", userId: "user-1" },
        error: "self_delete_forbidden",
        name: "self delete",
        overrides: { deleteStaleUser: async () => "self_delete_forbidden" },
        status: 403
      },
      {
        body: { action: "delete_user", userId: "user-1" },
        error: "user_active",
        name: "active user delete",
        overrides: { deleteStaleUser: async () => "user_active" },
        status: 400
      },
      {
        body: { action: "delete_user", userId: "user-1" },
        error: "user_has_owned_data",
        name: "owned user delete",
        overrides: { deleteStaleUser: async () => "user_has_owned_data" },
        status: 400
      },
      {
        body: { action: "create_invite", email: "invalid" },
        error: "email_invalid",
        name: "invalid invite email",
        overrides: { createInvite: async () => null },
        status: 400
      },
      {
        body: { action: "revoke_invite", inviteId: "invite-1" },
        error: "invite_not_found",
        name: "revoke missing invite",
        overrides: { revokeInvite: async () => false },
        status: 404
      },
      {
        body: { action: "delete_group", groupId: "group-1" },
        error: "group_has_members",
        name: "group members block delete",
        overrides: { deleteEmptyGroup: async () => "group_has_members" },
        status: 400
      },
      {
        body: { action: "delete_group", groupId: "group-1" },
        error: "group_has_grants",
        name: "group grants block delete",
        overrides: { deleteEmptyGroup: async () => "group_has_grants" },
        status: 400
      },
      {
        body: { action: "delete_invite", inviteId: "invite-1" },
        error: "invite_accepted",
        name: "accepted invite block delete",
        overrides: { deleteStaleInvite: async () => "invite_accepted" },
        status: 400
      },
      {
        body: { action: "delete_invite", inviteId: "invite-1" },
        error: "invite_open",
        name: "open invite block delete",
        overrides: { deleteStaleInvite: async () => "invite_open" },
        status: 400
      }
    ];

    for (const failureCase of failureCases) {
      const POST = createAdminActionHandler({
        getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
        mailer: createNoopAuthMailer(),
        repository: createRepository(failureCase.overrides),
        resolveAuth: admin.resolveAuth
      });
      const response = await POST(jsonRequest(failureCase.body));

      expect(response.status, failureCase.name).toBe(failureCase.status);
      expect(await response.json(), failureCase.name).toEqual({ error: failureCase.error });
    }
  });

  it("approves users with selected groups", async () => {
    const calls: unknown[] = [];
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository({
        approveUser: async (input) => {
          calls.push(input);
          return "approved";
        }
      }),
      resolveAuth: admin.resolveAuth
    });

    const response = await POST(
      jsonRequest({
        action: "approve_user",
        groupIds: ["group-1"],
        userId: "user-1"
      })
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        groupIds: ["group-1"],
        userId: "user-1"
      }
    ]);
  });

  it("passes the acting admin to global session revocation", async () => {
    const revokeAllSessions = vi.fn(async () => 3);
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository({ revokeAllSessions }),
      resolveAuth: admin.resolveAuth
    });

    const response = await POST(jsonRequest({ action: "revoke_all_sessions" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 3 });
    expect(revokeAllSessions).toHaveBeenCalledWith({
      revokedByUserId: admin.session.userId
    });
  });

  it("passes the acting admin to destructive actions and access artifacts", async () => {
    const calls: unknown[] = [];
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository({
        createAccessRule: async (input) => {
          calls.push({ input, type: "rule" });
          return {
            defaultGroups: [],
            enabled: true,
            id: "rule-1",
            kind: input.kind,
            value: input.value
          };
        },
        disableUser: async (input) => {
          calls.push({ input, type: "disable" });
          return "disabled";
        }
      }),
      resolveAuth: admin.resolveAuth
    });

    await POST(
      jsonRequest({
        action: "create_access_rule",
        kind: "email",
        value: "user@example.com"
      })
    );
    await POST(
      jsonRequest({
        action: "disable_user",
        userId: "target-user"
      })
    );

    expect(calls).toEqual([
      {
        input: {
          createdByUserId: admin.session.userId,
          groupIds: [],
          kind: "email",
          value: "user@example.com"
        },
        type: "rule"
      },
      {
        input: {
          revokedByUserId: admin.session.userId,
          userId: "target-user"
        },
        type: "disable"
      }
    ]);
  });

  it("manages groups, memberships, and group grants", async () => {
    const calls: unknown[] = [];
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository({
        archiveGroup: async (groupId) => {
          calls.push({ groupId, type: "archive" });
          return true;
        },
        createGroup: async (input) => {
          calls.push({ input, type: "create_group" });
          return {
            accessGrants: [],
            archivedAt: null,
            deletion: {
              canDelete: true,
              reason: null,
              summary: "No members or active grants; this group can be deleted."
            },
            id: "group-created",
            name: input.name,
            systemRole: null,
            userCount: 0
          };
        },
        renameGroup: async (input) => {
          calls.push({ input, type: "rename_group" });
          return {
            accessGrants: [],
            archivedAt: null,
            deletion: {
              canDelete: true,
              reason: null,
              summary: "No members or active grants; this group can be deleted."
            },
            id: input.groupId,
            name: input.name,
            systemRole: null,
            userCount: 0
          };
        },
        setGroupGrant: async (input) => {
          calls.push({ input, type: "grant" });
          return true;
        },
        setUserGroups: async (input) => {
          calls.push({ input, type: "membership" });
          return true;
        }
      }),
      resolveAuth: admin.resolveAuth
    });

    await POST(
      jsonRequest({
        action: "create_group",
        name: "Reviewers"
      })
    );
    await POST(
      jsonRequest({
        action: "rename_group",
        groupId: "group-1",
        name: "Operators"
      })
    );
    await POST(
      jsonRequest({
        action: "set_user_groups",
        groupIds: ["group-1", "group-1", "group-2"],
        userId: "user-1"
      })
    );
    await POST(
      jsonRequest({
        action: "set_group_grant",
        enabled: true,
        groupId: "group-1",
        modelId: "gpt-5.5",
        provider: "openai"
      })
    );
    await POST(
      jsonRequest({
        action: "archive_group",
        groupId: "group-1"
      })
    );

    expect(calls).toEqual([
      {
        input: {
          name: "Reviewers"
        },
        type: "create_group"
      },
      {
        input: {
          groupId: "group-1",
          name: "Operators"
        },
        type: "rename_group"
      },
      {
        input: {
          groupIds: ["group-1", "group-2"],
          userId: "user-1"
        },
        type: "membership"
      },
      {
        input: {
          enabled: true,
          groupId: "group-1",
          modelId: "gpt-5.5",
          provider: "openai",
          searchStrategy: null
        },
        type: "grant"
      },
      {
        groupId: "group-1",
        type: "archive"
      }
    ]);
  });

  it("creates invite links without handing raw tokens to the repository", async () => {
    let tokenHash = "";
    const mailer = createMemoryAuthMailer();
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer,
      repository: createRepository({
        createInvite: async (input) => {
          tokenHash = input.tokenHash;
          return {
            acceptedAt: null,
            deletion: {
              canDelete: false,
              reason: "invite_open",
              summary: "Revoke this open invite before deleting it."
            },
            defaultGroups: [],
            email: input.email,
            expiresAt: input.expiresAt.toISOString(),
            id: "invite-1",
            normalizedEmail: input.email.toLowerCase(),
            revokedAt: null
          };
        }
      }),
      resolveAuth: admin.resolveAuth
    });

    const response = await POST(
      jsonRequest({
        action: "create_invite",
        email: "friend@example.com",
        groupIds: ["private-operators"],
        sendEmail: true
      })
    );
    const body = (await response.json()) as { emailDelivery: string; inviteUrl: string };
    const token = new URL(body.inviteUrl).searchParams.get("invite")!;

    expect(response.status).toBe(200);
    expect(body.emailDelivery).toBe("sent");
    expect(token).toBeTruthy();
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).not.toBe(token);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      subject: "You're invited to AIQSA",
      to: "friend@example.com"
    });
    expect(mailer.sent[0]?.text).toContain(body.inviteUrl);
    expect(mailer.sent[0]?.text).toContain("is bound to the email address that received this message");
    expect(mailer.sent[0]?.text).toContain("It expires at ");
    expect(mailer.sent[0]?.text).toContain("choose your name and password to enter AIQSA directly");
    expect(mailer.sent[0]?.text).not.toContain("verification email");
    expect(mailer.sent[0]?.text).not.toContain("private-operators");
  });

  it("keeps the one-time link when invite email is not requested, unavailable, or fails", async () => {
    const notRequestedSend = vi.fn(async () => undefined);
    const omittedSend = vi.fn(async () => undefined);
    const unavailableSend = vi.fn(async () => ({ kind: "unavailable" as const }));
    const failedSend = vi.fn(async () => ({ code: "smtp_tls_failed" as const, kind: "failed" as const }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const cases = [
        {
          expected: "not_requested",
          mailer: { send: notRequestedSend },
          sendEmail: false
        },
        {
          expected: "not_requested",
          mailer: { send: omittedSend },
          sendEmail: undefined
        },
        {
          expected: "unavailable",
          mailer: { send: unavailableSend },
          sendEmail: true
        },
        {
          expected: "failed",
          mailer: { send: failedSend },
          sendEmail: true
        }
      ] as const;

      for (const testCase of cases) {
        const POST = createAdminActionHandler({
          getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
          mailer: testCase.mailer,
          repository: createRepository(),
          resolveAuth: admin.resolveAuth
        });
        const response = await POST(
          jsonRequest({
            action: "create_invite",
            email: "friend@example.com",
            sendEmail: testCase.sendEmail
          })
        );
        const body = (await response.json()) as { emailDelivery: string; inviteUrl: string };

        expect(response.status, testCase.expected).toBe(200);
        expect(body.emailDelivery, testCase.expected).toBe(testCase.expected);
        expect(body.inviteUrl, testCase.expected).toMatch(/^https:\/\/aiqsa\.local\/login\?invite=/);
      }

      expect(notRequestedSend).not.toHaveBeenCalled();
      expect(omittedSend).not.toHaveBeenCalled();
      expect(unavailableSend).toHaveBeenCalledOnce();
      expect(failedSend).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("invite_email_failed");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("smtp_tls_failed");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects an invalid invite email-delivery flag before persistence or mail", async () => {
    const createInvite = vi.fn<AdminRepository["createInvite"]>();
    const send = vi.fn(async () => undefined);
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: { send },
      repository: createRepository({ createInvite }),
      resolveAuth: admin.resolveAuth
    });

    const response = await POST(
      jsonRequest({
        action: "create_invite",
        email: "friend@example.com",
        sendEmail: "yes"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invite_email_delivery_invalid" });
    expect(createInvite).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("routes safe deletion actions and returns structured block reasons", async () => {
    const calls: unknown[] = [];
    const POST = createAdminActionHandler({
      getConfig: () => ({ appBaseUrl: "https://aiqsa.local" }),
      mailer: createNoopAuthMailer(),
      repository: createRepository({
        deleteEmptyGroup: async (groupId) => {
          calls.push({ groupId, type: "delete_group" });
          return "deleted";
        },
        deleteStaleInvite: async (input) => {
          calls.push({ inviteId: input.inviteId, type: "delete_invite" });
          return "deleted";
        },
        deleteStaleUser: async (input) => {
          calls.push({ input, type: "delete_user" });
          return input.userId === admin.session.userId ? "self_delete_forbidden" : "deleted";
        }
      }),
      resolveAuth: admin.resolveAuth
    });

    await expect(
      (
        await POST(
          jsonRequest({
            action: "delete_user",
            userId: "stale-user"
          })
        )
      ).json()
    ).resolves.toEqual({ ok: true });
    await expect(
      (
        await POST(
          jsonRequest({
            action: "delete_group",
            groupId: "empty-group"
          })
        )
      ).json()
    ).resolves.toEqual({ ok: true });
    await expect(
      (
        await POST(
          jsonRequest({
            action: "delete_invite",
            inviteId: "stale-invite"
          })
        )
      ).json()
    ).resolves.toEqual({ ok: true });

    const selfDelete = await POST(
      jsonRequest({
        action: "delete_user",
        userId: admin.session.userId
      })
    );

    expect(selfDelete.status).toBe(403);
    await expect(selfDelete.json()).resolves.toEqual({
      error: "self_delete_forbidden"
    });
    expect(calls).toEqual([
      {
        input: {
          actingAdminUserId: admin.session.userId,
          userId: "stale-user"
        },
        type: "delete_user"
      },
      {
        groupId: "empty-group",
        type: "delete_group"
      },
      {
        inviteId: "stale-invite",
        type: "delete_invite"
      },
      {
        input: {
          actingAdminUserId: admin.session.userId,
          userId: admin.session.userId
        },
        type: "delete_user"
      }
    ]);
  });
});

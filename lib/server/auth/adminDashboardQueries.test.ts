import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import {
  hasTeamMcpGroupGrants,
  listAdminDashboard,
  summarizeAdminNavigation
} from "./adminDashboardQueries";
import { loadAdminUsageQueryRows } from "./adminUsageQueries";

async function withAdminQueryData<T>(
  run: (fixture: Readonly<{ domain: string; marker: string }>) => Promise<T>
): Promise<T> {
  const marker = `admin-query-${randomUUID()}`;
  const domain = `${marker}.example.com`;

  try {
    return await run({ domain, marker });
  } finally {
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        OR: [
          {
            value: domain
          },
          {
            value: {
              endsWith: `@${domain}`
            }
          }
        ]
      }
    });
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.group.deleteMany({
      where: {
        name: {
          startsWith: marker
        }
      }
    });
    await prisma.mcpServer.deleteMany({
      where: {
        namespace: {
          startsWith: marker
        }
      }
    });
    await prisma.providerModel.deleteMany({
      where: {
        provider: {
          startsWith: marker
        }
      }
    });
    await prisma.providerConnection.deleteMany({
      where: {
        family: {
          startsWith: marker
        }
      }
    });
    await prisma.searchStrategy.deleteMany({
      where: {
        strategyId: {
          startsWith: marker
        }
      }
    });
  }
}

describe("admin dashboard queries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("derives authoritative personal/team, advanced, and attention navigation state", () => {
    const actingAdmin = {
      effectiveEntitlements: {
        models: [],
        providers: [],
        searchStrategies: ["search-only"]
      },
      id: "admin-1",
      role: "admin" as const,
      status: "active" as const
    };
    const personal = {
      actingAdminUserId: actingAdmin.id,
      hasAccessRules: false,
      hasEnabledGroupAccessGrants: false,
      hasMcpGroupGrants: false,
      hasMcpServers: false,
      hasProviderGroupCredentialAssignments: false,
      hasSmtpConfiguration: false,
      invites: [],
      users: [actingAdmin]
    };

    expect(summarizeAdminNavigation(personal)).toEqual({
      advancedConfigured: false,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 0,
        pendingUsers: 0
      },
      teamConfigured: false
    });

    const pendingUser = {
      effectiveEntitlements: {
        models: [],
        providers: [],
        searchStrategies: []
      },
      id: "pending-1",
      role: "user" as const,
      status: "pending" as const
    };
    const openInvite = {
      deletion: {
        canDelete: false,
        reason: "invite_open" as const,
        summary: "Revoke this open invite before deleting it."
      }
    };

    expect(summarizeAdminNavigation({
      ...personal,
      hasMcpServers: true,
      invites: [openInvite],
      users: [actingAdmin, pendingUser]
    })).toEqual({
      advancedConfigured: true,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 1,
        pendingUsers: 1
      },
      teamConfigured: true
    });

    for (const signal of [
      "hasAccessRules",
      "hasEnabledGroupAccessGrants",
      "hasMcpGroupGrants",
      "hasProviderGroupCredentialAssignments"
    ] as const) {
      expect(summarizeAdminNavigation({ ...personal, [signal]: true }).teamConfigured).toBe(true);
    }
    expect(summarizeAdminNavigation({ ...personal, hasSmtpConfiguration: true }).advancedConfigured).toBe(true);
    expect(summarizeAdminNavigation({
      ...personal,
      actingAdminUserId: "unknown-admin"
    }).teamConfigured).toBe(true);
    expect(summarizeAdminNavigation({
      ...personal,
      users: [actingAdmin, { ...pendingUser, id: "active-1", status: "active" }]
    }).attention.activeUsersWithoutModelAccess).toBe(1);
  });

  it("does not treat built-in Full access MCP coverage as team configuration", () => {
    expect(hasTeamMcpGroupGrants([
      {
        mcpGrants: [{ canUse: true }],
        systemRole: "full_access"
      }
    ])).toBe(false);
    expect(hasTeamMcpGroupGrants([
      {
        mcpGrants: [{ canUse: true }],
        systemRole: null
      }
    ])).toBe(true);
  });

  it("preserves query ordering, catalog filters, captured invite time, and secret redaction", async () => {
    await withAdminQueryData(async ({ domain, marker }) => {
      const now = new Date("2026-07-12T12:00:00.000Z");
      const providerAlpha = `${marker}-provider-alpha`;
      const providerBeta = `${marker}-provider-beta`;
      const providerDisabled = `${marker}-provider-disabled`;
      const strategyAlpha = `${marker}-strategy-alpha`;
      const strategyZulu = `${marker}-strategy-zulu`;
      const passwordHash = `${marker}-password-hash-must-not-leak`;
      const sessionTokenHash = `${marker}-session-hash-must-not-leak`;
      const inviteTokenHash = `${marker}-invite-hash-must-not-leak`;
      const [groupZulu, groupAlpha] = await Promise.all([
        prisma.group.create({
          data: {
            name: `${marker}-zulu`
          }
        }),
        prisma.group.create({
          data: {
            name: `${marker}-alpha`
          }
        })
      ]);
      await prisma.providerConnection.createMany({
        data: [
          {
            activeConfig: {},
            activeVersion: 1,
            activatedAt: now,
            displayName: providerAlpha,
            enabled: true,
            family: `${providerAlpha}-family`,
            id: providerAlpha
          },
          {
            activeConfig: {},
            activeVersion: 1,
            activatedAt: now,
            displayName: providerBeta,
            enabled: true,
            family: `${providerBeta}-family`,
            id: providerBeta
          },
          {
            displayName: providerDisabled,
            enabled: false,
            family: `${providerDisabled}-family`,
            id: providerDisabled
          }
        ]
      });

      await prisma.providerModel.createMany({
        data: [
          {
            activeConfig: {},
            activeVersion: 1,
            activatedAt: now,
            capabilities: {},
            connectionId: providerAlpha,
            contextWindow: 128_000,
            defaultParams: {},
            displayName: "Zulu enabled",
            id: `${marker}-model-zulu`,
            modelId: `${marker}-model-zulu`,
            provider: providerAlpha
          },
          {
            activeConfig: { upstreamModelId: `${marker}-upstream-alpha` },
            activeVersion: 1,
            activatedAt: now,
            capabilities: {},
            connectionId: providerAlpha,
            contextWindow: 128_000,
            defaultParams: {},
            displayName: "Alpha enabled",
            id: `${marker}-model-alpha`,
            modelId: `${marker}-model-alpha`,
            provider: providerAlpha
          },
          {
            activeConfig: {},
            activeVersion: 1,
            activatedAt: now,
            capabilities: {},
            connectionId: providerBeta,
            contextWindow: 128_000,
            defaultParams: {},
            displayName: "Beta enabled",
            id: `${marker}-model-beta`,
            modelId: `${marker}-model-beta`,
            provider: providerBeta
          },
          {
            capabilities: {},
            connectionId: providerDisabled,
            contextWindow: 128_000,
            defaultParams: {},
            displayName: "Disabled",
            enabled: false,
            id: `${marker}-model-disabled`,
            modelId: `${marker}-model-disabled`,
            provider: providerDisabled
          }
        ]
      });
      await prisma.searchStrategy.createMany({
        data: [
          {
            config: {},
            description: "Fixture enabled strategy Z",
            displayName: "Zulu strategy",
            kind: "openai_native_web_search",
            provider: providerAlpha,
            strategyId: strategyZulu
          },
          {
            config: {},
            description: "Fixture enabled strategy A",
            displayName: "Alpha strategy",
            kind: "openai_native_web_search",
            provider: providerAlpha,
            strategyId: strategyAlpha
          },
          {
            config: {},
            description: "Fixture disabled strategy",
            displayName: "Disabled strategy",
            enabled: false,
            kind: "openai_native_web_search",
            provider: providerAlpha,
            strategyId: `${marker}-strategy-disabled`
          }
        ]
      });

      const activeUser = await prisma.user.create({
        data: {
          authIdentities: {
            create: {
              emailVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
              normalizedEmail: `active@${domain}`,
              passwordHash,
              provider: "password",
              providerAccountId: `active@${domain}`
            }
          },
          createdAt: new Date("2026-07-10T00:00:00.000Z"),
          displayName: "Query Active User",
          email: `active@${domain}`,
          groups: {
            create: {
              groupId: groupAlpha.id,
              role: "owner"
            }
          },
          role: "user",
          settings: {
            create: {
              defaultControlValues: {},
              defaultProviderModelId: `${marker}-model-alpha`
            }
          },
          status: "active"
        }
      });
      const pendingUser = await prisma.user.create({
        data: {
          authIdentities: {
            create: {
              emailVerifiedAt: null,
              normalizedEmail: `pending@${domain}`,
              passwordHash: `${marker}-pending-password-hash`,
              provider: "password",
              providerAccountId: `pending@${domain}`
            }
          },
          createdAt: new Date("2026-07-09T00:00:00.000Z"),
          displayName: "Query Pending User",
          email: `pending@${domain}`,
          status: "pending"
        }
      });
      const mcpServer = await prisma.mcpServer.create({
        data: {
          displayName: "Dashboard deletion eligibility MCP",
          namespace: `${marker}-mcp`
        }
      });
      await prisma.mcpGrant.createMany({
        data: [
          {
            canUse: true,
            serverId: mcpServer.id,
            userId: pendingUser.id
          },
          {
            canUse: true,
            groupId: groupZulu.id,
            serverId: mcpServer.id
          }
        ]
      });

      await prisma.authSession.createMany({
        data: [
          {
            createdAt: new Date("2026-07-10T01:00:00.000Z"),
            expiresAt: new Date("2026-08-01T00:00:00.000Z"),
            lastSeenAt: new Date("2026-07-12T09:00:00.000Z"),
            tokenHash: sessionTokenHash,
            userId: activeUser.id
          },
          {
            createdAt: new Date("2026-07-11T08:00:00.000Z"),
            expiresAt: new Date("2026-08-01T00:00:00.000Z"),
            tokenHash: `${marker}-second-session-hash`,
            userId: activeUser.id
          }
        ]
      });

      const grants = await Promise.all([
        prisma.accessGrant.create({
          data: {
            groupId: groupAlpha.id,
            providerModelId: `${marker}-model-zulu`
          }
        }),
        prisma.accessGrant.create({
          data: {
            groupId: groupAlpha.id,
            providerModelId: `${marker}-model-alpha`
          }
        }),
        prisma.accessGrant.create({
          data: {
            enabled: false,
            groupId: groupAlpha.id,
            providerConnectionId: providerBeta
          }
        }),
        prisma.accessGrant.create({
          data: {
            groupId: groupAlpha.id,
            searchStrategy: strategyAlpha
          }
        }),
        prisma.accessGrant.create({
          data: {
            providerConnectionId: providerBeta,
            userId: activeUser.id
          }
        })
      ]);

      const [emailZuluRule, emailAlphaRule, domainRule] = await Promise.all([
        prisma.authAccessRule.create({
          data: {
            defaultGroups: {
              create: {
                groupId: groupZulu.id,
                role: "member"
              }
            },
            kind: "email",
            value: `zulu@${domain}`
          }
        }),
        prisma.authAccessRule.create({
          data: {
            defaultGroups: {
              create: {
                groupId: groupAlpha.id,
                role: "owner"
              }
            },
            kind: "email",
            value: `alpha@${domain}`
          }
        }),
        prisma.authAccessRule.create({
          data: {
            kind: "domain",
            value: domain
          }
        })
      ]);
      const [boundaryInvite, openInvite] = await Promise.all([
        prisma.authInvite.create({
          data: {
            createdAt: new Date("2026-07-10T00:00:00.000Z"),
            defaultGroups: {
              create: {
                groupId: groupZulu.id,
                role: "member"
              }
            },
            email: `boundary@${domain}`,
            expiresAt: now,
            normalizedEmail: `boundary@${domain}`
          }
        }),
        prisma.authInvite.create({
          data: {
            createdAt: new Date("2026-07-11T00:00:00.000Z"),
            defaultGroups: {
              create: {
                groupId: groupAlpha.id,
                role: "owner"
              }
            },
            email: `open@${domain}`,
            expiresAt: new Date(now.getTime() + 1),
            normalizedEmail: `open@${domain}`
          }
        })
      ]);
      await prisma.authFlowToken.create({
        data: {
          expiresAt: openInvite.expiresAt,
          inviteId: openInvite.id,
          normalizedEmail: openInvite.normalizedEmail,
          purpose: "invite_acceptance",
          sentToEmail: openInvite.email,
          tokenHash: inviteTokenHash
        }
      });

      const userFindMany = vi.spyOn(prisma.user, "findMany");
      const inviteFindMany = vi.spyOn(prisma.authInvite, "findMany");
      const mcpServerFindFirst = vi.spyOn(prisma.mcpServer, "findFirst");
      const smtpControlFindFirst = vi.spyOn(prisma.smtpControl, "findFirst");
      const dashboard = await listAdminDashboard(prisma, {
        actingAdminUserId: activeUser.id,
        now
      });
      const catalog = dashboard.catalog;
      const fixtureModels = catalog.models.filter((model) => model.provider.startsWith(marker));
      const fixtureProviders = catalog.providers.filter((provider) => provider.id.startsWith(marker));
      const fixtureStrategies = catalog.searchStrategies.filter((strategy) =>
        strategy.strategyId.startsWith(marker)
      );

      expect(fixtureModels).toEqual([
        {
          displayName: "Alpha enabled",
          modelId: `${marker}-model-alpha`,
          provider: providerAlpha,
          providerFamily: `${providerAlpha}-family`,
          upstreamModelId: `${marker}-upstream-alpha`
        },
        {
          displayName: "Zulu enabled",
          modelId: `${marker}-model-zulu`,
          provider: providerAlpha
        },
        {
          displayName: "Beta enabled",
          modelId: `${marker}-model-beta`,
          provider: providerBeta
        }
      ]);
      expect(fixtureProviders).toEqual([
        { id: providerAlpha, name: providerAlpha },
        { id: providerBeta, name: providerBeta }
      ]);
      expect(fixtureStrategies).toEqual([
        { displayName: "Alpha strategy", strategyId: strategyAlpha },
        { displayName: "Zulu strategy", strategyId: strategyZulu }
      ]);
      expect(catalog.models.some((model) => model.modelId === `${marker}-model-disabled`)).toBe(false);
      expect(catalog.providers.some((provider) => provider.id === providerDisabled)).toBe(false);
      expect(
        catalog.searchStrategies.some((strategy) => strategy.strategyId === `${marker}-strategy-disabled`)
      ).toBe(false);
      expect(catalog.searchStrategies.some((strategy) => strategy.strategyId === "search-disabled")).toBe(false);

      expect(userFindMany).toHaveBeenCalledOnce();
      expect(userFindMany.mock.calls[0]?.[0]).toMatchObject({
        select: {
          authIdentities: {
            select: {
              emailVerifiedAt: true
            }
          },
          authSessions: {
            select: {
              createdAt: true,
              lastSeenAt: true
            }
          },
          _count: {
            select: {
              mcpGrants: true,
              mcpOAuthConnections: true,
              mcpUserServers: true
            }
          },
          settings: {
            select: {
              id: true
            }
          }
        }
      });
      expect(inviteFindMany).toHaveBeenCalledOnce();
      expect(mcpServerFindFirst).toHaveBeenCalledWith({
        select: { id: true },
        where: { archivedAt: null }
      });
      expect(smtpControlFindFirst).toHaveBeenCalledWith({
        select: { id: true },
        where: {
          OR: [
            { activeConfig: { not: expect.anything() } },
            { draftConfig: { not: expect.anything() } }
          ]
        }
      });
      expect(inviteFindMany.mock.calls[0]?.[0]).toMatchObject({
        select: {
          acceptedAt: true,
          defaultGroups: {
            select: {
              groupId: true,
              role: true
            }
          },
          email: true,
          expiresAt: true,
          id: true,
          normalizedEmail: true,
          revokedAt: true
        }
      });
      const serializedQueryShapes = JSON.stringify({
        invites: inviteFindMany.mock.calls[0]?.[0],
        mcpServer: mcpServerFindFirst.mock.calls[0]?.[0],
        smtp: smtpControlFindFirst.mock.calls[0]?.[0],
        users: userFindMany.mock.calls[0]?.[0]
      });
      expect(serializedQueryShapes).not.toContain("passwordHash");
      expect(serializedQueryShapes).not.toContain("tokenHash");
      expect(serializedQueryShapes).not.toContain("flowTokens");
      expect(serializedQueryShapes).not.toContain("PasswordEnvelope");

      expect(
        dashboard.users
          .filter((user) => user.id === activeUser.id || user.id === pendingUser.id)
          .map((user) => user.id)
      ).toEqual([activeUser.id, pendingUser.id]);
      const serializedActiveUser = dashboard.users.find((user) => user.id === activeUser.id);
      const serializedPendingUser = dashboard.users.find((user) => user.id === pendingUser.id);

      expect(serializedActiveUser).toMatchObject({
        deletion: {
          canDelete: false,
          reason: "active_user"
        },
        groups: [
          {
            groupId: groupAlpha.id,
            name: groupAlpha.name,
            role: "owner"
          }
        ],
        hasVerifiedIdentity: true,
        lastSessionAt: "2026-07-12T09:00:00.000Z"
      });
      expect(serializedActiveUser?.effectiveEntitlements).toEqual({
        models: [
          {
            modelId: `${marker}-model-alpha`,
            provider: providerAlpha
          },
          {
            modelId: `${marker}-model-zulu`,
            provider: providerAlpha
          }
        ],
        providers: [providerBeta],
        searchStrategies: [strategyAlpha]
      });
      expect(serializedPendingUser).toMatchObject({
        deletion: {
          canDelete: false,
          reason: "user_has_owned_data"
        },
        hasVerifiedIdentity: false,
        lastSessionAt: null
      });

      expect(
        dashboard.groups
          .filter((group) => group.id === groupAlpha.id || group.id === groupZulu.id)
          .map((group) => group.id)
      ).toEqual([groupAlpha.id, groupZulu.id]);
      const serializedAlphaGroup = dashboard.groups.find((group) => group.id === groupAlpha.id);
      const serializedZuluGroup = dashboard.groups.find((group) => group.id === groupZulu.id);
      expect(serializedAlphaGroup).toMatchObject({
        deletion: {
          canDelete: false,
          reason: "group_has_members"
        },
        userCount: 1
      });
      expect(serializedAlphaGroup?.accessGrants.map((grant) => grant.id)).toEqual([
        grants[2].id,
        grants[1].id,
        grants[0].id,
        grants[3].id
      ]);
      expect(serializedZuluGroup).toMatchObject({
        deletion: {
          canDelete: false,
          reason: "group_has_grants"
        },
        userCount: 0
      });
      expect(serializedZuluGroup?.accessGrants).toEqual([]);

      expect(
        dashboard.accessRules
          .filter((rule) => [emailZuluRule.id, emailAlphaRule.id, domainRule.id].includes(rule.id))
          .map((rule) => rule.id)
      ).toEqual([emailAlphaRule.id, emailZuluRule.id, domainRule.id]);
      expect(dashboard.accessRules.find((rule) => rule.id === emailAlphaRule.id)?.defaultGroups).toEqual([
        {
          groupId: groupAlpha.id,
          name: groupAlpha.name,
          role: "owner"
        }
      ]);

      expect(
        dashboard.invites
          .filter((invite) => invite.id === boundaryInvite.id || invite.id === openInvite.id)
          .map((invite) => invite.id)
      ).toEqual([openInvite.id, boundaryInvite.id]);
      expect(dashboard.invites.find((invite) => invite.id === openInvite.id)).toMatchObject({
        defaultGroups: [
          {
            groupId: groupAlpha.id,
            name: groupAlpha.name,
            role: "owner"
          }
        ],
        deletion: {
          canDelete: false,
          reason: "invite_open"
        }
      });
      expect(dashboard.invites.find((invite) => invite.id === boundaryInvite.id)?.deletion).toMatchObject({
        canDelete: true,
        reason: null
      });

      const serializedDashboard = JSON.stringify(dashboard);
      expect(serializedDashboard).not.toContain(passwordHash);
      expect(serializedDashboard).not.toContain(sessionTokenHash);
      expect(serializedDashboard).not.toContain(inviteTokenHash);
      expect(serializedDashboard).not.toContain("passwordHash");
      expect(serializedDashboard).not.toContain("tokenHash");
    });
  });

  it("loads usage groupBy rows and attributes usage to every current membership without archived entitlements", async () => {
    await withAdminQueryData(async ({ domain, marker }) => {
      const activeProvider = `${marker}-active-provider`;
      const archivedProvider = `${marker}-archived-provider`;
      const directProvider = `${marker}-direct-provider`;
      const activeSearch = `${marker}-active-search`;
      const archivedAt = new Date("2026-07-01T00:00:00.000Z");
      const [activeAlpha, activeBeta, archivedGroup] = await Promise.all([
        prisma.group.create({
          data: {
            name: `${marker}-active-alpha`
          }
        }),
        prisma.group.create({
          data: {
            name: `${marker}-active-beta`
          }
        }),
        prisma.group.create({
          data: {
            archivedAt,
            name: `${marker}-archived`
          }
        })
      ]);
      const user = await prisma.user.create({
        data: {
          displayName: "Usage Query User",
          email: `usage@${domain}`,
          status: "active"
        }
      });

      await prisma.providerConnection.createMany({
        data: [activeProvider, archivedProvider, directProvider].map((id) => ({
          displayName: id,
          family: `${id}-family`,
          id
        }))
      });
      await prisma.providerModel.createMany({
        data: [
          {
            capabilities: {},
            connectionId: archivedProvider,
            contextWindow: 1,
            defaultParams: {},
            displayName: `${marker}-archived-model`,
            id: `${marker}-archived-model`,
            modelId: `${marker}-archived-model`,
            provider: archivedProvider
          },
          {
            capabilities: {},
            connectionId: directProvider,
            contextWindow: 1,
            defaultParams: {},
            displayName: `${marker}-direct-model`,
            id: `${marker}-direct-model`,
            modelId: `${marker}-direct-model`,
            provider: directProvider
          }
        ]
      });

      await prisma.userGroup.createMany({
        data: [
          { groupId: activeAlpha.id, role: "member", userId: user.id },
          { groupId: activeBeta.id, role: "owner", userId: user.id },
          { groupId: archivedGroup.id, role: "member", userId: user.id }
        ]
      });
      await prisma.accessGrant.createMany({
        data: [
          {
            groupId: activeAlpha.id,
            providerConnectionId: activeProvider
          },
          {
            groupId: activeBeta.id,
            searchStrategy: activeSearch
          },
          {
            groupId: archivedGroup.id,
            providerModelId: `${marker}-archived-model`
          },
          {
            providerModelId: `${marker}-direct-model`,
            userId: user.id
          }
        ]
      });
      await prisma.usageEvent.createMany({
        data: [
          {
            cachedInputTokens: 3,
            cacheWriteInputTokens: 2,
            createdAt: new Date("2026-07-12T10:00:00.000Z"),
            inputTokens: 10,
            modelId: `${marker}-model-alpha`,
            outputTokens: 20,
            provider: activeProvider,
            reasoningTokens: 5,
            totalTokens: 30,
            userId: user.id
          },
          {
            cachedInputTokens: 4,
            createdAt: new Date("2026-07-12T11:00:00.000Z"),
            inputTokens: 7,
            modelId: `${marker}-model-beta`,
            outputTokens: 8,
            provider: directProvider,
            reasoningTokens: 1,
            totalTokens: 15,
            userId: user.id
          }
        ]
      });

      const usageRows = await loadAdminUsageQueryRows(prisma);
      const userRow = usageRows.userRows.find((row) => row.userId === user.id);
      const providerModelRows = usageRows.providerModelRows.filter((row) => row.userId === user.id);

      expect(userRow).toEqual({
        _count: {
          _all: 0
        },
        _max: {
          createdAt: new Date("2026-07-12T11:00:00.000Z")
        },
        _sum: {
          cachedInputTokens: 7,
          cacheWriteInputTokens: 2,
          inputTokens: 17,
          outputTokens: 28,
          reasoningTokens: 6,
          totalTokens: 45
        },
        userId: user.id
      });
      expect(providerModelRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _count: { _all: 0 },
            modelId: `${marker}-model-alpha`,
            provider: activeProvider,
            userId: user.id
          }),
          expect.objectContaining({
            _count: { _all: 0 },
            modelId: `${marker}-model-beta`,
            provider: directProvider,
            userId: user.id
          })
        ])
      );

      const dashboard = await listAdminDashboard(prisma, {
        actingAdminUserId: user.id,
        now: new Date("2026-07-12T12:00:00.000Z")
      });
      const dashboardUser = dashboard.users.find((candidate) => candidate.id === user.id);

      expect(dashboardUser?.effectiveEntitlements).toEqual({
        models: [
          {
            modelId: `${marker}-direct-model`,
            provider: directProvider
          }
        ],
        providers: [activeProvider],
        searchStrategies: [activeSearch]
      });
      expect(dashboardUser?.effectiveEntitlements.models).not.toContainEqual({
        modelId: `${marker}-archived-model`,
        provider: archivedProvider
      });
      expect(dashboardUser?.groups.map((group) => group.groupId).sort()).toEqual(
        [activeAlpha.id, activeBeta.id, archivedGroup.id].sort()
      );

      const usageUser = dashboard.usage.byUser.find((candidate) => candidate.userId === user.id);
      expect(usageUser).toMatchObject({
        cachedInputTokens: 7,
        cacheWriteInputTokens: 2,
        inputTokens: 17,
        lastUsedAt: "2026-07-12T11:00:00.000Z",
        outputTokens: 28,
        reasoningTokens: 6,
        runCount: 0,
        totalTokens: 45
      });
      expect(usageUser?.groups.map((group) => group.groupId).sort()).toEqual(
        [activeAlpha.id, activeBeta.id, archivedGroup.id].sort()
      );

      const fixtureGroupUsage = dashboard.usage.byGroup.filter((group) =>
        [activeAlpha.id, activeBeta.id, archivedGroup.id].includes(group.groupId)
      );
      expect(fixtureGroupUsage.map((group) => group.groupId)).toEqual([
        activeAlpha.id,
        activeBeta.id,
        archivedGroup.id
      ]);
      expect(fixtureGroupUsage).toEqual([
        expect.objectContaining({
          contributingUsers: 1,
          groupId: activeAlpha.id,
          runCount: 0,
          totalTokens: 45,
          userCount: 1
        }),
        expect.objectContaining({
          contributingUsers: 1,
          groupId: activeBeta.id,
          runCount: 0,
          totalTokens: 45,
          userCount: 1
        }),
        expect.objectContaining({
          archivedAt: archivedAt.toISOString(),
          contributingUsers: 1,
          groupId: archivedGroup.id,
          runCount: 0,
          totalTokens: 45,
          userCount: 1
        })
      ]);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  adminProviderName,
  serializeAdminEntitlements,
  serializeAdminGrant,
  serializeAdminGroup,
  serializeAdminInvite,
  serializeAdminLastSession,
  serializeAdminRule
} from "./adminRepositorySerializers";

function stableGrant(input: {
  enabled: boolean;
  groupId: string | null;
  id: string;
  modelId: string | null;
  provider: string | null;
  searchStrategy: string | null;
  userId: string | null;
}) {
  return {
    enabled: input.enabled,
    groupId: input.groupId,
    id: input.id,
    providerConnectionId: input.modelId ? null : input.provider,
    providerModel: input.modelId && input.provider
      ? { connectionId: input.provider }
      : null,
    providerModelId: input.modelId,
    searchStrategy: input.searchStrategy,
    userId: input.userId
  };
}

describe("admin repository serializers", () => {
  it("serializes rules with exact fields and membership fallback semantics", () => {
    expect(
      serializeAdminRule(
        {
          defaultGroups: [
            { groupId: "group-fallback", role: "member" },
            { groupId: "group-missing", role: "member" }
          ],
          enabled: false,
          id: "rule-1",
          kind: "domain",
          value: "example.com"
        },
        new Map([["group-fallback", { name: "Fallback group" }]])
      )
    ).toEqual({
      defaultGroups: [
        {
          groupId: "group-fallback",
          name: "Fallback group",
          role: "member"
        }
      ],
      enabled: false,
      id: "rule-1",
      kind: "domain",
      value: "example.com"
    });
  });

  it("serializes invite dates, deletion metadata, and group names against an injected clock", () => {
    expect(
      serializeAdminInvite(
        {
          acceptedAt: null,
          defaultGroups: [{ groupId: "group-1", role: "member" }],
          email: "Person@Example.com",
          expiresAt: new Date("2026-07-19T12:00:00.000Z"),
          id: "invite-1",
          normalizedEmail: "person@example.com",
          revokedAt: null
        },
        new Map([["group-1", { name: "Operators" }]]),
        new Date("2026-07-12T12:00:00.000Z")
      )
    ).toEqual({
      acceptedAt: null,
      defaultGroups: [
        {
          groupId: "group-1",
          name: "Operators",
          role: "member"
        }
      ],
      deletion: {
        canDelete: false,
        reason: "invite_open",
        summary: "Revoke this open invite before deleting it."
      },
      email: "Person@Example.com",
      expiresAt: "2026-07-19T12:00:00.000Z",
      id: "invite-1",
      normalizedEmail: "person@example.com",
      revokedAt: null
    });

    expect(
      serializeAdminInvite(
        {
          acceptedAt: new Date("2026-07-10T09:00:00.000Z"),
          defaultGroups: [],
          email: "accepted@example.com",
          expiresAt: new Date("2026-07-11T12:00:00.000Z"),
          id: "invite-accepted",
          normalizedEmail: "accepted@example.com",
          revokedAt: new Date("2026-07-10T10:00:00.000Z")
        },
        undefined,
        new Date("2026-07-12T12:00:00.000Z")
      )
    ).toEqual({
      acceptedAt: "2026-07-10T09:00:00.000Z",
      defaultGroups: [],
      deletion: {
        canDelete: false,
        reason: "invite_accepted",
        summary: "Accepted invites are kept for audit history."
      },
      email: "accepted@example.com",
      expiresAt: "2026-07-11T12:00:00.000Z",
      id: "invite-accepted",
      normalizedEmail: "accepted@example.com",
      revokedAt: "2026-07-10T10:00:00.000Z"
    });
  });

  it("preserves every grant field and grant order in serialized groups", () => {
    const disabledSearchGrant = stableGrant({
      enabled: false,
      groupId: "group-1",
      id: "grant-search",
      modelId: null,
      provider: null,
      searchStrategy: "web-search",
      userId: null
    });
    const modelGrant = stableGrant({
      enabled: true,
      groupId: "group-1",
      id: "grant-model",
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategy: null,
      userId: null
    });

    const disabledSearchWire = {
      enabled: false,
      groupId: "group-1",
      id: "grant-search",
      modelId: null,
      provider: null,
      searchStrategy: "web-search",
      userId: null
    };
    const modelWire = {
      enabled: true,
      groupId: "group-1",
      id: "grant-model",
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategy: null,
      userId: null
    };

    expect(serializeAdminGrant(disabledSearchGrant)).toEqual(disabledSearchWire);
    expect(
      serializeAdminGroup({
        _count: { users: 0 },
        accessGrants: [disabledSearchGrant, modelGrant],
        archivedAt: new Date("2026-07-01T00:00:00.000Z"),
        id: "group-1",
        mcpGrants: [],
        name: "Operators",
        systemRole: null
      })
    ).toEqual({
      accessGrants: [disabledSearchWire, modelWire],
      archivedAt: "2026-07-01T00:00:00.000Z",
      deletion: {
        canDelete: false,
        reason: "group_has_grants",
        summary: "Remove 1 active grant before deleting this group."
      },
      id: "group-1",
      name: "Operators",
      systemRole: null,
      userCount: 0
    });
  });

  it("serializes authoritative deletion metadata for the built-in group", () => {
    expect(
      serializeAdminGroup({
        _count: { providerCredentialAssignments: 1, users: 1 },
        accessGrants: [],
        archivedAt: null,
        id: "full-access",
        mcpGrants: [{ canUse: true }],
        name: "Full access",
        systemRole: "full_access"
      }).deletion
    ).toEqual({
      canDelete: false,
      reason: "system_group_forbidden",
      summary: "Full access is built in and cannot be deleted."
    });
  });

  it("combines only applicable enabled entitlements and emits exact lexical order", () => {
    const entitlements = serializeAdminEntitlements({
      catalog: {
        models: [],
        providers: [],
        searchStrategies: []
      },
      fullAccess: false,
      grants: [
        stableGrant({
          enabled: true,
          groupId: "group-current",
          id: "grant-model-anthropic",
          modelId: "a-model",
          provider: "anthropic",
          searchStrategy: null,
          userId: null
        }),
        stableGrant({
          enabled: true,
          groupId: null,
          id: "grant-model-openai",
          modelId: "z-model",
          provider: "openai",
          searchStrategy: null,
          userId: "user-1"
        }),
        stableGrant({
          enabled: true,
          groupId: null,
          id: "grant-provider-openrouter",
          modelId: null,
          provider: "openrouter",
          searchStrategy: null,
          userId: "user-1"
        }),
        stableGrant({
          enabled: true,
          groupId: "group-current",
          id: "grant-provider-anthropic",
          modelId: null,
          provider: "anthropic",
          searchStrategy: null,
          userId: null
        }),
        stableGrant({
          enabled: true,
          groupId: "group-current",
          id: "grant-search-z",
          modelId: null,
          provider: null,
          searchStrategy: "z-search",
          userId: null
        }),
        stableGrant({
          enabled: true,
          groupId: null,
          id: "grant-search-a",
          modelId: null,
          provider: null,
          searchStrategy: "a-search",
          userId: "user-1"
        }),
        stableGrant({
          enabled: true,
          groupId: "group-current",
          id: "grant-model-duplicate",
          modelId: "a-model",
          provider: "anthropic",
          searchStrategy: null,
          userId: null
        }),
        stableGrant({
          enabled: false,
          groupId: null,
          id: "grant-disabled",
          modelId: "disabled-model",
          provider: "disabled-provider",
          searchStrategy: "disabled-search",
          userId: "user-1"
        }),
        stableGrant({
          enabled: true,
          groupId: "group-other",
          id: "grant-unrelated",
          modelId: "other-model",
          provider: "other-provider",
          searchStrategy: "other-search",
          userId: null
        })
      ],
      groupIds: ["group-current"],
      userId: "user-1"
    });

    expect(entitlements).toEqual({
      models: [
        {
          modelId: "a-model",
          provider: "anthropic"
        },
        {
          modelId: "z-model",
          provider: "openai"
        }
      ],
      providers: ["anthropic", "openrouter"],
      searchStrategies: ["a-search", "z-search"]
    });
  });

  it("projects the full-access wildcard as every current grantable catalog item", () => {
    const entitlements = serializeAdminEntitlements({
      catalog: {
        models: [
          { displayName: "Future", modelId: "future-model", provider: "provider-z" },
          { displayName: "Current", modelId: "current-model", provider: "provider-a" }
        ],
        providers: [
          { id: "provider-z", name: "Provider Z" },
          { id: "provider-a", name: "Provider A" }
        ],
        searchStrategies: [
          { displayName: "Future search", strategyId: "future-search" },
          { displayName: "Current search", strategyId: "current-search" }
        ]
      },
      fullAccess: true,
      grants: [],
      groupIds: ["full-access"],
      userId: "user-1"
    });

    expect(entitlements).toEqual({
      models: [
        { modelId: "current-model", provider: "provider-a" },
        { modelId: "future-model", provider: "provider-z" }
      ],
      providers: ["provider-a", "provider-z"],
      searchStrategies: ["current-search", "future-search"]
    });
  });

  it("selects the latest session activity without depending on source order", () => {
    expect(serializeAdminLastSession([])).toBeNull();
    expect(
      serializeAdminLastSession([
        {
          createdAt: new Date("2026-07-12T12:00:00.000Z"),
          lastSeenAt: null
        },
        {
          createdAt: new Date("2026-07-10T12:00:00.000Z"),
          lastSeenAt: new Date("2026-07-12T13:00:00.000Z")
        },
        {
          createdAt: new Date("2026-07-11T12:00:00.000Z"),
          lastSeenAt: new Date("2026-07-11T14:00:00.000Z")
        }
      ])
    ).toBe("2026-07-12T13:00:00.000Z");
  });

  it("maps known provider labels and preserves unknown provider ids", () => {
    expect([
      adminProviderName("anthropic"),
      adminProviderName("fake"),
      adminProviderName("openai"),
      adminProviderName("openrouter"),
      adminProviderName("private-provider")
    ]).toEqual(["Anthropic", "Fake", "OpenAI", "OpenRouter", "private-provider"]);
  });
});

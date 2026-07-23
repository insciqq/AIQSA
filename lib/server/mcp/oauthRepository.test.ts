// @vitest-environment node

import type { PrismaClient } from "@prisma/client";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { hashCanonicalMcpValue } from "./definitions";
import { decryptMcpEnvelope } from "./encryption";
import {
  buildMcpOAuthPolicy,
  mcpOAuthPolicyFingerprint,
  mcpOAuthRegistrationKey,
  type McpOAuthPolicy
} from "./oauthPolicy";
import {
  createPrismaMcpOAuthRepository,
  isMcpOAuthConnectionEligible
} from "./oauthRepository";

const KEY = Buffer.alloc(32, 0x62);
const NOW = new Date("2026-07-22T16:00:00.000Z");
const SERVER_ID = "server-1";
const USER_ID = "user-1";
const REDIRECT_URI = `https://aiqsa.example.test/api/me/mcp/${SERVER_ID}/oauth/callback`;
const draft: McpDraftConfiguration = {
  auth: {
    allowedAuthorizationServerOrigins: ["https://auth.example.test"],
    mode: "oauth",
    scopes: ["mcp.read"]
  },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 30_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};
const policy = buildMcpOAuthPolicy({
  configurationIdentity: "revision-1",
  draft,
  purpose: "user",
  redirectUri: REDIRECT_URI,
  serverId: SERVER_ID,
  userId: USER_ID
});
const discoveryState: OAuthDiscoveryState = {
  authorizationServerMetadata: {
    authorization_endpoint: "https://auth.example.test/authorize",
    code_challenge_methods_supported: ["S256"],
    issuer: "https://auth.example.test",
    registration_endpoint: "https://auth.example.test/register",
    response_types_supported: ["code"],
    token_endpoint: "https://auth.example.test/token"
  },
  authorizationServerUrl: "https://auth.example.test",
  resourceMetadata: {
    authorization_servers: ["https://auth.example.test"],
    resource: "https://mcp.example.test/mcp"
  }
};

type ClientRow = {
  clientId: string;
  clientMetadata: object;
  clientSecretEnvelope: string | null;
  createdAt: Date;
  id: string;
  registrationKey: string;
  updatedAt: Date;
};

type ConnectionRow = {
  createdAt: Date;
  disconnectRequestedAt: Date | null;
  expiresAt: Date | null;
  externalAccountLabel: string | null;
  id: string;
  oauthClientId: string | null;
  policyFingerprint: string;
  purpose: "user" | "validation";
  scopes: string[];
  serverId: string;
  state: "ready" | "reauthorization_required" | "disconnecting" | "disconnected";
  tokenEnvelope: string | null;
  updatedAt: Date;
  userId: string;
};

function fakePrisma() {
  let clientRow: ClientRow | null = null;
  let connectionRow: ConnectionRow | null = null;
  let activeDraft = draft;
  let eligibility = {
    archivedAt: null as Date | null,
    grants: [{ canUse: true, groupId: null as string | null, userId: USER_ID as string | null }],
    groupIds: [] as string[],
    role: "user" as "admin" | "user",
    status: "active" as "active" | "disabled"
  };
  const mcpOAuthClient = {
    async findUnique(input: { where: { id?: string; registrationKey?: string } }) {
      if (!clientRow) return null;
      return input.where.id === clientRow.id || input.where.registrationKey === clientRow.registrationKey
        ? clientRow
        : null;
    },
    async findUniqueOrThrow(input: { where: { id: string } }) {
      if (!clientRow || clientRow.id !== input.where.id) throw new Error("not found");
      return clientRow;
    },
    async upsert(input: {
      create: Omit<ClientRow, "createdAt" | "id" | "updatedAt">;
      update: Pick<ClientRow, "clientId" | "clientMetadata" | "clientSecretEnvelope">;
    }) {
      clientRow = clientRow
        ? { ...clientRow, ...input.update, updatedAt: NOW }
        : { ...input.create, createdAt: NOW, id: "oauth-client-1", updatedAt: NOW };
      return clientRow;
    }
  };
  const mcpOAuthConnection = {
    async create(input: { data: Omit<ConnectionRow, "createdAt" | "id" | "updatedAt"> }) {
      connectionRow = { ...input.data, createdAt: NOW, id: "connection-1", updatedAt: NOW };
      return connectionRow;
    },
    async findUnique(input: { where: { id: string } }) {
      return connectionRow?.id === input.where.id ? connectionRow : null;
    },
    async findMany() {
      if (!connectionRow || !["ready", "reauthorization_required"].includes(connectionRow.state) ||
        !connectionRow.tokenEnvelope) return [];
      return [{
        id: connectionRow.id,
        oauthClient: clientRow ? { clientId: clientRow.clientId } : null,
        policyFingerprint: connectionRow.policyFingerprint,
        purpose: connectionRow.purpose,
        server: {
          activeRevision: { configuration: activeDraft, id: "revision-1" },
          archivedAt: eligibility.archivedAt,
          draft: activeDraft,
          grants: eligibility.grants,
          testedDraftHash: hashCanonicalMcpValue(activeDraft)
        },
        serverId: connectionRow.serverId,
        tokenEnvelope: connectionRow.tokenEnvelope,
        user: {
          groups: eligibility.groupIds.map((groupId) => ({ groupId })),
          role: eligibility.role,
          status: eligibility.status
        },
        userId: connectionRow.userId
      }];
    },
    async updateMany(input: {
      data: Partial<ConnectionRow>;
      where: { id?: string; tokenEnvelope?: string | { not: null } };
    }) {
      if (!connectionRow) return { count: 0 };
      if (input.where.id && input.where.id !== connectionRow.id) return { count: 0 };
      if (typeof input.where.tokenEnvelope === "string" &&
        input.where.tokenEnvelope !== connectionRow.tokenEnvelope) {
        return { count: 0 };
      }
      connectionRow = { ...connectionRow, ...input.data, updatedAt: NOW };
      return { count: 1 };
    }
  };
  const mcpUserServer = { updateMany: vi.fn(async () => ({ count: 1 })) };
  const dataClient = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(dataClient),
    mcpOAuthClient,
    mcpOAuthConnection,
    mcpRuntimeGeneration: { findFirst: vi.fn(async () => null) },
    mcpServer: {
      findFirst: vi.fn(async () => ({
        activeRevision: { configuration: draft, id: "revision-1" },
        grants: [{ canUse: true, groupId: null, personalSlotKeys: [], userId: USER_ID }]
      }))
    },
    mcpUserServer,
    user: {
      findUnique: vi.fn(async () => ({ groups: [], role: "user", status: "active" }))
    }
  };
  return {
    client: dataClient as unknown as PrismaClient,
    getClientRow: () => clientRow,
    getConnectionRow: () => connectionRow,
    mcpUserServer,
    setConnectionState: (state: ConnectionRow["state"]) => {
      if (connectionRow) connectionRow = { ...connectionRow, state };
    },
    setActiveDraft: (value: McpDraftConfiguration) => { activeDraft = value; },
    setEligibility: (value: Partial<typeof eligibility>) => {
      eligibility = { ...eligibility, ...value };
    }
  };
}

describe("Prisma MCP OAuth repository", () => {
  it("derives connection eligibility from archival, user status, role, and effective grants", () => {
    type EligibilityRecord = Parameters<typeof isMcpOAuthConnectionEligible>[0];
    const record = (overrides: Partial<EligibilityRecord> = {}): EligibilityRecord => ({
      id: "connection-eligibility",
      oauthClient: { clientId: "client-id" },
      policyFingerprint: "fingerprint",
      purpose: "user",
      server: {
        activeRevision: { configuration: draft, id: "revision-1" },
        archivedAt: null,
        draft,
        grants: [{ canUse: true, groupId: null, userId: USER_ID }],
        testedDraftHash: hashCanonicalMcpValue(draft)
      },
      serverId: SERVER_ID,
      tokenEnvelope: "encrypted",
      user: { groups: [], role: "user", status: "active" },
      userId: USER_ID,
      ...overrides
    });

    expect(isMcpOAuthConnectionEligible(record())).toBe(true);
    expect(isMcpOAuthConnectionEligible(record({
      server: {
        activeRevision: { configuration: draft, id: "revision-1" },
        archivedAt: null,
        draft,
        grants: [{ canUse: true, groupId: "group-1", userId: null }],
        testedDraftHash: hashCanonicalMcpValue(draft)
      },
      user: { groups: [{ groupId: "group-1" }], role: "user", status: "active" }
    }))).toBe(true);
    expect(isMcpOAuthConnectionEligible(record({
      server: {
        activeRevision: { configuration: draft, id: "revision-1" },
        archivedAt: null,
        draft,
        grants: [{ canUse: true, groupId: "group-1", userId: null }],
        testedDraftHash: hashCanonicalMcpValue(draft)
      }
    }))).toBe(false);
    expect(isMcpOAuthConnectionEligible(record({
      server: {
        activeRevision: { configuration: draft, id: "revision-1" },
        archivedAt: null,
        draft,
        grants: [],
        testedDraftHash: hashCanonicalMcpValue(draft)
      }
    }))).toBe(false);
    expect(isMcpOAuthConnectionEligible(record({
      server: {
        activeRevision: { configuration: draft, id: "revision-1" },
        archivedAt: NOW,
        draft,
        grants: [{ canUse: true, groupId: null, userId: USER_ID }],
        testedDraftHash: hashCanonicalMcpValue(draft)
      }
    }))).toBe(false);
    expect(isMcpOAuthConnectionEligible(record({
      user: { groups: [], role: "user", status: "disabled" }
    }))).toBe(false);
    expect(isMcpOAuthConnectionEligible(record({
      purpose: "validation",
      user: { groups: [], role: "admin", status: "active" }
    }))).toBe(true);
    expect(isMcpOAuthConnectionEligible(record({ purpose: "validation" }))).toBe(false);
  });

  it("encrypts client secrets and rotating tokens while preserving policy fences", async () => {
    const fake = fakePrisma();
    const repository = createPrismaMcpOAuthRepository({
      encryptionKey: () => KEY,
      prisma: fake.client
    });
    const metadata: OAuthClientMetadata = {
      client_name: "AIQSA fixture",
      redirect_uris: [REDIRECT_URI]
    };
    const registrationKey = mcpOAuthRegistrationKey(policy, discoveryState.authorizationServerUrl);
    const saved = await repository.saveClient({
      clientInformation: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: [REDIRECT_URI]
      },
      clientMetadata: metadata,
      discoveryState,
      registrationKey
    });
    const rawClient = fake.getClientRow();
    expect(rawClient?.clientSecretEnvelope).toMatch(/^v1\./u);
    expect(JSON.stringify(rawClient)).not.toContain("client-secret");
    expect(decryptMcpEnvelope<{ clientSecret: string }>(rawClient!.clientSecretEnvelope!, KEY))
      .toEqual(expect.objectContaining({ clientSecret: "client-secret" }));
    expect((await repository.findClient(registrationKey))?.clientInformation.client_secret)
      .toBe("client-secret");

    const policyFingerprint = mcpOAuthPolicyFingerprint(policy, "client-id");
    const created = await repository.createConnection({
      clientId: "client-id",
      configurationIdentity: "revision-1",
      externalAccountLabel: "Fixture Workspace",
      oauthClientId: saved.id,
      policyFingerprint,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: SERVER_ID,
      tokens: {
        access_token: "access-secret",
        expires_in: 3_600,
        refresh_token: "refresh-secret",
        scope: "mcp.read",
        token_type: "Bearer"
      },
      userId: USER_ID
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    const rawConnection = fake.getConnectionRow();
    expect(rawConnection?.tokenEnvelope).toMatch(/^v1\./u);
    expect(JSON.stringify(rawConnection)).not.toContain("access-secret");
    expect(JSON.stringify(rawConnection)).not.toContain("refresh-secret");
    const decoded = decryptMcpEnvelope<{
      policy: McpOAuthPolicy;
      tokens: { access_token: string; refresh_token: string };
    }>(rawConnection!.tokenEnvelope!, KEY);
    expect(decoded.tokens).toMatchObject({
      access_token: "access-secret",
      refresh_token: "refresh-secret"
    });
    expect(decoded.policy.configurationIdentity).toBe("revision-1");

    const rotated = await repository.rotateTokens({
      connectionId: created.value.id,
      expectedTokenVersion: created.value.tokenVersion,
      tokens: {
        access_token: "rotated-access-secret",
        expires_in: 3_600,
        refresh_token: "rotated-refresh-secret",
        token_type: "Bearer"
      }
    });
    expect(rotated?.tokens).toMatchObject({
      access_token: "rotated-access-secret",
      refresh_token: "rotated-refresh-secret"
    });
    expect(JSON.stringify(fake.getConnectionRow())).not.toContain("rotated-access-secret");

    fake.setConnectionState("reauthorization_required");
    await expect(repository.requestDisconnectForIneligibleConnections()).resolves.toBe(0);
    fake.setActiveDraft({
      ...draft,
      auth: {
        allowedAuthorizationServerOrigins: ["https://auth.example.test"],
        mode: "oauth",
        scopes: ["mcp.read", "mcp.write"]
      }
    });
    await expect(repository.requestDisconnectForIneligibleConnections()).resolves.toBe(1);
    expect(fake.getConnectionRow()?.state).toBe("disconnecting");

    fake.setActiveDraft(draft);
    fake.setConnectionState("reauthorization_required");
    fake.mcpUserServer.updateMany.mockClear();
    fake.setEligibility({ archivedAt: NOW });
    await expect(repository.requestDisconnectForIneligibleConnections()).resolves.toBe(1);
    expect(fake.getConnectionRow()).toMatchObject({
      disconnectRequestedAt: expect.any(Date),
      state: "disconnecting"
    });
    expect(fake.mcpUserServer.updateMany).toHaveBeenCalledWith({
      data: { desiredRuntimeGenerationId: null },
      where: { serverId: SERVER_ID, userId: USER_ID }
    });

    await expect(repository.createConnection({
      clientId: "client-id",
      configurationIdentity: "stale-revision",
      externalAccountLabel: null,
      oauthClientId: saved.id,
      policyFingerprint,
      purpose: "user",
      redirectUri: REDIRECT_URI,
      serverId: SERVER_ID,
      tokens: { access_token: "must-not-persist", token_type: "Bearer" },
      userId: USER_ID
    })).resolves.toEqual({ kind: "configuration_changed" });
    expect(JSON.stringify(fake.getConnectionRow())).not.toContain("must-not-persist");
  });
});

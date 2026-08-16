import type { PrismaClient } from "@prisma/client";
import type { McpDraftConfiguration, McpSlotValue } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext
} from "./encryption";
import {
  buildMcpOAuthPolicy,
  mcpOAuthPolicyFingerprint
} from "./oauthPolicy";
import {
  createPrismaMcpRuntimeRepository,
  localRuntimeCandidate,
  remoteRuntimeCandidate
} from "./runtimeRepository";

const KEY = Buffer.alloc(32, 0x4d);
const NOW = new Date("2026-07-22T19:00:00.000Z");
const USER_ID = "user-1";
const SERVER_ID = "server-1";
const REVISION_ID = "revision-1";
const USER_SERVER_ID = "user-server-1";

type RuntimeRecord = Parameters<typeof remoteRuntimeCandidate>[0]["record"];

type GrantFixture = {
  canUse: boolean;
  groupId: string | null;
  personalSlotKeys: string[];
  userId: string | null;
};

type RecordOptions = {
  activeRevision?: boolean;
  archivedAt?: Date | null;
  configuration?: McpDraftConfiguration | Record<string, unknown>;
  enabled?: boolean;
  grants?: GrantFixture[];
  groupIds?: string[];
  personalValues?: Record<string, McpSlotValue>;
  personalVersion?: number;
  resolvedArtifact?: Record<string, unknown> | null;
  serverEnabled?: boolean;
  sharedValues?: Record<string, McpSlotValue>;
  sharedVersion?: number;
};

const configuration: McpDraftConfiguration = {
  auth: { mode: "static" },
  runtime: { callTimeoutMs: 28_000, startupTimeoutMs: 41_000 },
  slots: [
    {
      label: "Authorization",
      policy: { allowPersonalOverride: true, kind: "shared" },
      sensitive: true,
      slotKey: "authorization",
      target: { kind: "header", name: "Authorization" },
      valueType: "secret"
    },
    {
      label: "Workspace",
      policy: { kind: "personal", required: true },
      sensitive: false,
      slotKey: "workspace",
      target: { kind: "header", name: "X-Workspace" },
      valueType: "string"
    },
    {
      label: "Tenant",
      policy: { allowPersonalOverride: false, kind: "shared" },
      sensitive: false,
      slotKey: "tenant",
      target: { kind: "header", name: "X-Tenant" },
      valueType: "number"
    },
    {
      label: "Mode",
      policy: { kind: "literal", value: "sync" },
      sensitive: false,
      slotKey: "mode",
      target: { kind: "header", name: "X-Mode" },
      valueType: "string"
    }
  ],
  source: { kind: "remote", url: "https://mcp.example.test/rpc" },
  transport: "streamable_http"
};

const sharedOnlyConfiguration: McpDraftConfiguration = {
  ...configuration,
  slots: [configuration.slots[0]!]
};

const localConfiguration: McpDraftConfiguration = {
  auth: { mode: "static" },
  runtime: { callTimeoutMs: 15_000, startupTimeoutMs: 120_000 },
  slots: [{
    label: "API key",
    policy: { allowPersonalOverride: true, kind: "shared" },
    sensitive: true,
    slotKey: "api-key",
    target: { kind: "environment", name: "API_KEY" },
    valueType: "secret"
  }, {
    label: "Mode",
    policy: { kind: "literal", value: "safe" },
    sensitive: false,
    slotKey: "mode",
    target: { kind: "environment", name: "MODE" },
    valueType: "string"
  }],
  source: {
    args: ["--stdio"],
    kind: "npm",
    packageName: "example-mcp",
    versionSelector: "^1.0.0"
  },
  transport: "stdio"
};

const oauthConfiguration: McpDraftConfiguration = {
  auth: {
    allowedAuthorizationServerOrigins: ["https://auth.example.test"],
    mode: "oauth",
    scopes: ["mcp.read"]
  },
  runtime: { callTimeoutMs: 28_000, startupTimeoutMs: 41_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/rpc" },
  transport: "streamable_http"
};

const localArtifact = {
  exactVersion: "1.2.3",
  imageRef: "toolhivelocal/example-mcp:resolved-1-2-3",
  imageReferenceKind: "toolhive_generated_tag",
  kind: "toolhive_local",
  materializer: "npx",
  packageName: "example-mcp",
  registryArtifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
  registryIntegrity: "sha512-YWJjZA==",
  sourceKind: "npm",
  toolhiveVersion: "v0.40.1"
};

function grant(input: GrantFixture, index: number) {
  return {
    ...input,
    createdAt: NOW,
    id: `grant-${index}`,
    serverId: SERVER_ID,
    updatedAt: NOW
  };
}

function runtimeRecord(options: RecordOptions = {}): RuntimeRecord {
  const hasRevision = options.activeRevision ?? true;
  const selectedConfiguration = options.configuration ?? configuration;
  const grants = options.grants ?? [
    {
      canUse: false,
      groupId: null,
      personalSlotKeys: ["authorization", "workspace"],
      userId: USER_ID
    },
    {
      canUse: true,
      groupId: "group-1",
      personalSlotKeys: [],
      userId: null
    }
  ];
  const sharedValues = options.sharedValues ?? {
    authorization: "Bearer shared-secret",
    tenant: 42
  };
  const personalValues = options.personalValues ?? {
    authorization: "Bearer personal-secret",
    workspace: "workspace-a"
  };
  const personalVersion = options.personalVersion ?? 9;
  const sharedVersion = options.sharedVersion ?? 4;

  return {
    createdAt: NOW,
    desiredRuntimeGenerationId: null,
    enabled: options.enabled ?? true,
    id: USER_SERVER_ID,
    personalConfigEnvelope: encryptMcpEnvelope(
      { values: personalValues, version: 1 },
      KEY,
      mcpPersonalConfigEnvelopeContext(USER_SERVER_ID, personalVersion)
    ),
    personalConfigVersion: personalVersion,
    server: {
      activeRevision: hasRevision ? {
        configuration: selectedConfiguration,
        createdAt: NOW,
        draftHash: "draft-hash",
        id: REVISION_ID,
        resolvedArtifact: options.resolvedArtifact ?? null,
        revisionNumber: 1,
        serverId: SERVER_ID,
        validationEvidence: {}
      } : null,
      activeRevisionId: hasRevision ? REVISION_ID : null,
      archivedAt: options.archivedAt ?? null,
      createdAt: NOW,
      description: "Remote MCP",
      displayName: "Remote MCP",
      draft: selectedConfiguration,
      draftTestEvidence: null,
      enabled: options.serverEnabled ?? true,
      grants: grants.map(grant),
      id: SERVER_ID,
      namespace: "remote-mcp",
      sharedConfigEnvelope: encryptMcpEnvelope(
        { values: sharedValues, version: 1 },
        KEY,
        mcpSharedConfigEnvelopeContext(SERVER_ID, sharedVersion)
      ),
      sharedConfigVersion: sharedVersion,
      testedDraftHash: "draft-hash",
      updatedAt: NOW
    },
    serverId: SERVER_ID,
    updatedAt: NOW,
    user: {
      groups: (options.groupIds ?? ["group-1"]).map((groupId) => ({ groupId })),
      id: USER_ID
    },
    userId: USER_ID
  } as unknown as RuntimeRecord;
}

describe("remote MCP runtime candidates", () => {
  it("unions group use with direct-only personal permissions and decrypts the effective headers", () => {
    const candidate = remoteRuntimeCandidate({ key: KEY, record: runtimeRecord() });

    expect(candidate).not.toBeNull();
    expect(candidate).toMatchObject({
      callTimeoutMs: 28_000,
      credentialSources: ["personal"],
      headers: {
        Authorization: "Bearer personal-secret",
        "X-Mode": "sync",
        "X-Tenant": "42",
        "X-Workspace": "workspace-a"
      },
      revisionId: REVISION_ID,
      startupTimeoutMs: 41_000,
      url: "https://mcp.example.test/rpc",
      userId: USER_ID,
      userServerId: USER_SERVER_ID
    });
    expect(candidate?.effectiveEnvelope).toEqual({
      plan: [
        {
          authorized: true,
          slotKey: "authorization",
          source: "personal",
          valueVersion: 9
        },
        {
          authorized: true,
          slotKey: "workspace",
          source: "personal",
          valueVersion: 9
        },
        {
          authorized: true,
          slotKey: "tenant",
          source: "shared",
          valueVersion: 4
        },
        {
          authorized: true,
          slotKey: "mode",
          source: "literal",
          valueVersion: null
        }
      ],
      values: {
        authorization: "Bearer personal-secret",
        mode: "sync",
        tenant: 42,
        workspace: "workspace-a"
      },
      version: 1
    });
  });

  it("accepts either a direct use grant or a matching group use grant", () => {
    const direct = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        configuration: sharedOnlyConfiguration,
        grants: [{
          canUse: true,
          groupId: null,
          personalSlotKeys: [],
          userId: USER_ID
        }],
        groupIds: [],
        personalValues: {},
        sharedValues: { authorization: "Bearer shared" }
      })
    });
    const group = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        configuration: sharedOnlyConfiguration,
        grants: [{
          canUse: true,
          groupId: "group-2",
          personalSlotKeys: [],
          userId: null
        }],
        groupIds: ["group-2"],
        personalValues: {},
        sharedValues: { authorization: "Bearer shared" }
      })
    });

    expect(direct?.headers.Authorization).toBe("Bearer shared");
    expect(group?.headers.Authorization).toBe("Bearer shared");
  });

  it("never derives personal-slot permission from a group grant", () => {
    const candidate = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        configuration: sharedOnlyConfiguration,
        grants: [{
          canUse: true,
          groupId: "group-1",
          personalSlotKeys: ["authorization"],
          userId: null
        }],
        personalValues: { authorization: "Bearer unauthorized-personal" },
        sharedValues: { authorization: "Bearer shared" }
      })
    });

    expect(candidate?.headers.Authorization).toBe("Bearer shared");
    expect(candidate?.effectiveEnvelope.plan).toEqual([{
      authorized: true,
      slotKey: "authorization",
      source: "shared",
      valueVersion: 4
    }]);
  });

  it("filters missing or mismatched access grants", () => {
    const noGrant = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({ grants: [], groupIds: [] })
    });
    const unrelatedGroup = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        grants: [{
          canUse: true,
          groupId: "group-elsewhere",
          personalSlotKeys: [],
          userId: null
        }],
        groupIds: ["group-1"]
      })
    });
    const deniedDirect = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        grants: [{
          canUse: false,
          groupId: null,
          personalSlotKeys: ["authorization", "workspace"],
          userId: USER_ID
        }],
        groupIds: []
      })
    });

    expect(noGrant).toBeNull();
    expect(unrelatedGroup).toBeNull();
    expect(deniedDirect).toBeNull();
  });

  it("selects only a ready per-user OAuth connection for the exact active policy", () => {
    const redirectUri = `https://aiqsa.example.test/api/me/mcp/${SERVER_ID}/oauth/callback`;
    const policy = buildMcpOAuthPolicy({
      configurationIdentity: REVISION_ID,
      draft: oauthConfiguration,
      purpose: "user",
      redirectUri,
      serverId: SERVER_ID,
      userId: USER_ID
    });
    const expectedFingerprint = mcpOAuthPolicyFingerprint(policy, "oauth-client-id");
    const base = runtimeRecord({ configuration: oauthConfiguration });
    const record = {
      ...base,
      server: {
        ...base.server,
        oauthConnections: [{
          createdAt: NOW,
          disconnectRequestedAt: null,
          expiresAt: new Date(NOW.getTime() + 3_600_000),
          externalAccountLabel: "Workspace",
          id: "oauth-connection-1",
          oauthClient: { clientId: "oauth-client-id" },
          oauthClientId: "oauth-client-1",
          policyFingerprint: expectedFingerprint,
          purpose: "user",
          scopes: ["mcp.read"],
          serverId: SERVER_ID,
          state: "ready",
          tokenEnvelope: "encrypted-token-envelope",
          updatedAt: NOW,
          userId: USER_ID
        }]
      }
    } as unknown as RuntimeRecord;

    const candidate = remoteRuntimeCandidate({
      key: KEY,
      oauthRedirectUri: () => redirectUri,
      record
    });
    expect(candidate).toMatchObject({
      credentialSources: ["oauth"],
      externalAccountLabel: "Workspace",
      oauthConnectionId: "oauth-connection-1",
      url: oauthConfiguration.source.kind === "remote" ? oauthConfiguration.source.url : ""
    });
    expect(candidate?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(remoteRuntimeCandidate({ key: KEY, record })).toBeNull();

    const stale = {
      ...record,
      server: {
        ...record.server,
        oauthConnections: record.server.oauthConnections.map((connection) => ({
          ...connection,
          policyFingerprint: "stale-policy"
        }))
      }
    } as RuntimeRecord;
    expect(remoteRuntimeCandidate({
      key: KEY,
      oauthRedirectUri: () => redirectUri,
      record: stale
    })).toBeNull();
  });

  it.each([
    { label: "disabled preference", overrides: { enabled: false } },
    { label: "disabled server", overrides: { serverEnabled: false } },
    { label: "archived server", overrides: { archivedAt: NOW } },
    { label: "missing active revision", overrides: { activeRevision: false } }
  ] as const)("filters a $label", ({ overrides }) => {
    expect(remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord(overrides)
    })).toBeNull();
  });

  it("requires a complete valid static remote configuration", () => {
    const missingRequiredPersonal = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        personalValues: { authorization: "Bearer personal" }
      })
    });
    const oauth = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        configuration: {
          ...sharedOnlyConfiguration,
          auth: {
            allowedAuthorizationServerOrigins: ["https://auth.example.test"],
            mode: "oauth",
            scopes: ["tools"]
          }
        }
      })
    });

    expect(missingRequiredPersonal).toBeNull();
    expect(oauth).toBeNull();
  });

  it("derives deterministic sanitized fingerprints from selected sources and value versions", () => {
    const firstRecord = runtimeRecord();
    const secondRecord = runtimeRecord();
    expect(firstRecord.personalConfigEnvelope).not.toBe(secondRecord.personalConfigEnvelope);

    const first = remoteRuntimeCandidate({ key: KEY, record: firstRecord });
    const second = remoteRuntimeCandidate({ key: KEY, record: secondRecord });
    const nextVersion = remoteRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({ personalVersion: 10 })
    });

    expect(first?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(nextVersion?.fingerprint).not.toBe(first?.fingerprint);
    const safeIdentity = JSON.stringify({
      fingerprint: first?.fingerprint,
      plan: first?.effectiveEnvelope.plan,
      revisionId: first?.revisionId,
      userId: first?.userId
    });
    expect(safeIdentity).not.toContain("personal-secret");
    expect(safeIdentity).not.toContain("shared-secret");
    expect(safeIdentity).not.toContain(firstRecord.personalConfigEnvelope ?? "missing-envelope");
  });
});

describe("local MCP runtime candidates", () => {
  it("maps the per-user effective values exactly into the ToolHive workload environment", () => {
    const candidate = localRuntimeCandidate({
      key: KEY,
      record: runtimeRecord({
        configuration: localConfiguration,
        grants: [{
          canUse: true,
          groupId: null,
          personalSlotKeys: ["api-key"],
          userId: USER_ID
        }],
        groupIds: [],
        personalValues: { "api-key": "personal-key" },
        resolvedArtifact: localArtifact,
        sharedValues: { "api-key": "shared-key" }
      })
    });

    expect(candidate).toMatchObject({
      callTimeoutMs: 15_000,
      credentialSources: ["personal"],
      revisionId: REVISION_ID,
      startupTimeoutMs: 120_000,
      toolHive: {
        cmdArguments: ["--stdio"],
        envVars: { API_KEY: "personal-key", MODE: "safe" },
        generationToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
        image: localArtifact.imageRef
      },
      userId: USER_ID,
      userServerId: USER_SERVER_ID
    });
    expect(candidate?.toolHive.generationToken).toBe(candidate?.fingerprint);
    expect(candidate?.effectiveEnvelope.plan).toEqual([{
      authorized: true,
      slotKey: "api-key",
      source: "personal",
      valueVersion: 9
    }, {
      authorized: true,
      slotKey: "mode",
      source: "literal",
      valueVersion: null
    }]);
  });

  it("does not launch a local revision without its matching immutable artifact", () => {
    const record = runtimeRecord({
      configuration: localConfiguration,
      grants: [{
        canUse: true,
        groupId: null,
        personalSlotKeys: [],
        userId: USER_ID
      }],
      groupIds: [],
      personalValues: {},
      resolvedArtifact: null,
      sharedValues: { "api-key": "shared-key" }
    });

    expect(localRuntimeCandidate({ key: KEY, record })).toBeNull();
  });
});

describe("Prisma MCP runtime desired-state snapshots", () => {
  it("keeps background reconciliation dormant and scopes on-demand activation exactly", async () => {
    const findMany = vi.fn(async () => []);
    const client = {
      mcpUserServer: { findMany }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => KEY,
      prisma: client
    });

    await repository.synchronizeDesired({ now: NOW, userId: USER_ID });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ desiredRuntimeGenerationId: { not: null } })
    }));

    await repository.synchronizeDesired({
      now: NOW,
      onDemand: true,
      serverIds: [SERVER_ID],
      userId: USER_ID
    });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ serverId: { in: [SERVER_ID] } })
    }));
  });

  it("persists only an encrypted effective snapshot while returning the required launch headers", async () => {
    const record = runtimeRecord({
      configuration: { ...configuration, disabledToolNames: ["dangerous_tool"] }
    });
    const expected = remoteRuntimeCandidate({ key: KEY, record });
    const createGeneration = vi.fn(async (input: { data: Record<string, unknown> }) => ({
      credentialSources: input.data.credentialSources,
      externalAccountLabel: input.data.externalAccountLabel,
      id: "generation-1",
      // Prisma returns nullable columns as null even when an optional create
      // input was undefined. Match the real client so this fixture catches
      // false runtime-fingerprint collisions for non-OAuth servers.
      oauthConnectionId: input.data.oauthConnectionId ?? null,
      retryAt: null,
      revisionId: input.data.revisionId,
      userServerId: input.data.userServerId
    }));
    const transactionUserUpdate = vi.fn(async () => ({ count: 1 }));
    const transactionClient = {
      mcpRuntimeGeneration: {
        create: createGeneration,
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => undefined)
      },
      mcpUserServer: { updateMany: transactionUserUpdate }
    };
    const client = {
      $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<unknown>) =>
        operation(transactionClient)),
      mcpUserServer: {
        findMany: vi.fn(async () => [record]),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => KEY,
      generationId: () => "generation-1",
      prisma: client
    });

    const launches = await repository.synchronizeDesired({ now: NOW, userId: USER_ID });

    expect(launches).toEqual([{
      allowPrivateNetwork: false,
      callTimeoutMs: 28_000,
      disabledToolNames: ["dangerous_tool"],
      fingerprint: expected?.fingerprint,
      generationId: "generation-1",
      headers: expected?.headers,
      inventoryRefreshRequired: true,
      redactionValues: expected?.redactionValues,
      retryAt: null,
      startupTimeoutMs: 41_000,
      url: "https://mcp.example.test/rpc"
    }]);
    expect(createGeneration).toHaveBeenCalledTimes(1);
    const generationData = createGeneration.mock.calls[0]![0].data;
    const persistedEnvelope = generationData.effectiveConfigEnvelope;
    expect(typeof persistedEnvelope).toBe("string");
    expect(generationData.credentialSources).toEqual(["personal"]);
    expect(generationData.externalAccountLabel).toBeNull();
    expect(generationData.oauthConnectionId).toBeNull();
    expect(JSON.stringify(generationData)).not.toContain("personal-secret");
    expect(JSON.stringify(generationData)).not.toContain("shared-secret");
    expect(decryptMcpEnvelope(
      persistedEnvelope as string,
      KEY,
      mcpRuntimeGenerationEnvelopeContext("generation-1", expected!.fingerprint)
    )).toEqual(expected?.effectiveEnvelope);
    expect(transactionUserUpdate).toHaveBeenCalledWith({
      data: { desiredRuntimeGenerationId: "generation-1" },
      where: {
        enabled: true,
        id: USER_SERVER_ID,
        server: {
          activeRevisionId: REVISION_ID,
          archivedAt: null,
          enabled: true
        }
      }
    });
  });

  it("restores an accepted active-run generation from its immutable revision and effective snapshot", async () => {
    const expected = remoteRuntimeCandidate({ key: KEY, record: runtimeRecord() });
    if (!expected) throw new Error("expected runtime candidate");
    const findFirst = vi.fn(async () => ({
      effectiveConfigEnvelope: encryptMcpEnvelope(
        expected.effectiveEnvelope,
        KEY,
        mcpRuntimeGenerationEnvelopeContext("generation-accepted", expected.fingerprint)
      ),
      fingerprint: expected.fingerprint,
      id: "generation-accepted",
      inventoryUpdatedAt: new Date(NOW.getTime() - 10 * 60_000),
      oauthConnectionId: null,
      retryAt: null,
      revision: {
        configuration: { ...configuration, disabledToolNames: ["historical_tool"] },
        id: REVISION_ID,
        serverId: SERVER_ID
      },
      userServer: {
        serverId: SERVER_ID,
        userId: USER_ID
      }
    }));
    const client = {
      mcpRuntimeGeneration: { findFirst }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => KEY,
      prisma: client
    });

    await expect(repository.loadAcceptedGeneration("generation-accepted", NOW)).resolves.toEqual({
      allowPrivateNetwork: false,
      callTimeoutMs: 28_000,
      disabledToolNames: ["historical_tool"],
      fingerprint: expected.fingerprint,
      generationId: "generation-accepted",
      headers: expected.headers,
      inventoryRefreshRequired: true,
      redactionValues: expected.redactionValues,
      retryAt: null,
      startupTimeoutMs: 41_000,
      url: "https://mcp.example.test/rpc"
    });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "generation-accepted",
        runBindings: {
          some: {
            modelRun: {
              status: { in: ["preparing", "queued", "streaming", "in_progress"] }
            }
          }
        }
      }
    }));
  });

  it("restores an accepted local generation with its exact artifact and effective environment", async () => {
    const record = runtimeRecord({
      configuration: localConfiguration,
      grants: [{
        canUse: true,
        groupId: null,
        personalSlotKeys: ["api-key"],
        userId: USER_ID
      }],
      groupIds: [],
      personalValues: { "api-key": "personal-key" },
      resolvedArtifact: localArtifact,
      sharedValues: { "api-key": "shared-key" }
    });
    const expected = localRuntimeCandidate({ key: KEY, record });
    if (!expected) throw new Error("expected local runtime candidate");
    const client = {
      mcpRuntimeGeneration: {
        findFirst: vi.fn(async () => ({
          effectiveConfigEnvelope: encryptMcpEnvelope(
            expected.effectiveEnvelope,
            KEY,
            mcpRuntimeGenerationEnvelopeContext("generation-local", expected.fingerprint)
          ),
          fingerprint: expected.fingerprint,
          id: "generation-local",
          inventoryUpdatedAt: null,
          oauthConnectionId: null,
          retryAt: null,
          revision: {
            configuration: localConfiguration,
            id: REVISION_ID,
            resolvedArtifact: localArtifact,
            serverId: SERVER_ID
          },
          userServer: { serverId: SERVER_ID, userId: USER_ID }
        }))
      }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => KEY,
      prisma: client
    });

    await expect(repository.loadAcceptedGeneration("generation-local", NOW)).resolves.toEqual({
      callTimeoutMs: 15_000,
      fingerprint: expected.fingerprint,
      generationId: "generation-local",
      headers: {},
      inventoryRefreshRequired: true,
      redactionValues: expected.redactionValues,
      retryAt: null,
      startupTimeoutMs: 120_000,
      toolHive: expected.toolHive
    });
  });

  it("refuses an accepted generation whose stored identity no longer verifies", async () => {
    const expected = remoteRuntimeCandidate({ key: KEY, record: runtimeRecord() });
    if (!expected) throw new Error("expected runtime candidate");
    const client = {
      mcpRuntimeGeneration: {
        findFirst: vi.fn(async () => ({
          effectiveConfigEnvelope: encryptMcpEnvelope(
            expected.effectiveEnvelope,
            KEY,
            mcpRuntimeGenerationEnvelopeContext("generation-tampered", "0".repeat(64))
          ),
          fingerprint: "0".repeat(64),
          id: "generation-tampered",
          inventoryUpdatedAt: null,
          oauthConnectionId: null,
          retryAt: null,
          revision: { configuration, id: REVISION_ID, serverId: SERVER_ID },
          userServer: { serverId: SERVER_ID, userId: USER_ID }
        }))
      }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({
      encryptionKey: () => KEY,
      prisma: client
    });

    await expect(repository.loadAcceptedGeneration("generation-tampered", NOW)).resolves.toBeNull();
  });

  it("retains both user-runtime and live activation workload identities during orphan cleanup", async () => {
    const activationFindMany = vi.fn(async () => [{ workloadToken: "activation-workload" }]);
    const generationFindMany = vi.fn(async () => [{ fingerprint: "runtime-fingerprint" }]);
    const client = {
      mcpActivationJob: { findMany: activationFindMany },
      mcpRuntimeGeneration: { findMany: generationFindMany }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({ prisma: client });

    await expect(repository.listGenerationFingerprints?.()).resolves.toEqual([
      "runtime-fingerprint",
      "activation-workload"
    ]);
    expect(activationFindMany).toHaveBeenCalledWith({
      select: { workloadToken: true },
      where: {
        stage: {
          in: [
            "queued",
            "resolving",
            "preparing_runtime",
            "connecting",
            "discovering_tools",
            "publishing"
          ]
        }
      }
    });
  });

  it("finalizes only tombstoned server graphs that have no runtime generations", async () => {
    const calls: string[] = [];
    const tx = {
      mcpOAuthClient: {
        deleteMany: vi.fn(async () => {
          calls.push("oauth-clients");
          return { count: 1 };
        })
      },
      mcpOAuthConnection: {
        findMany: vi.fn(async () => [{ oauthClientId: "oauth-client-1" }])
      },
      mcpRevision: {
        deleteMany: vi.fn(async () => {
          calls.push("revisions");
          return { count: 2 };
        })
      },
      mcpServer: {
        deleteMany: vi.fn(async () => {
          calls.push("servers");
          return { count: 1 };
        }),
        findMany: vi.fn(async () => [{ id: "server-deleted" }]),
        updateMany: vi.fn(async () => {
          calls.push("detach-active-revision");
          return { count: 1 };
        })
      }
    };
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<number>) => operation(tx))
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRuntimeRepository({ prisma: client });

    await expect(repository.finalizeDeletedServers()).resolves.toBe(1);
    expect(tx.mcpServer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 100,
      where: {
        archivedAt: { not: null },
        revisions: { none: { runtimeGenerations: { some: {} } } }
      }
    }));
    expect(calls).toEqual(["detach-active-revision", "revisions", "servers", "oauth-clients"]);
    expect(tx.mcpServer.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ archivedAt: { not: null }, revisions: { none: {} } })
    }));
    expect(tx.mcpOAuthClient.deleteMany).toHaveBeenCalledWith({
      where: { connections: { none: {} }, id: { in: ["oauth-client-1"] } }
    });
  });
});

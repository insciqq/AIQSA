import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import {
  createPrismaAdminProviderQuickSetupRepository,
  lockAdminProviderQuickSetupState
} from "./quickSetupPrismaRepository";

const now = new Date("2026-07-26T10:00:00.000Z");
const policy = adminProviderQuickSetupPolicy("openai");
const terra = policy.candidates[0];

function canonicalConnection(overrides: Record<string, unknown> = {}) {
  return {
    activeConfig: null,
    activeVersion: 0,
    activatedAt: null,
    connectionId: policy.connection.id,
    credentials: [],
    defaultCredentialId: null,
    displayName: policy.connection.displayName,
    draftConfig: policy.connection.configuration,
    draftVersion: 1,
    enabled: false,
    family: policy.provider,
    id: policy.connection.id,
    models: [],
    templateKey: policy.connection.templateKey,
    unassignedPolicy: "use_default",
    updatedAt: now,
    ...overrides
  };
}

function canonicalModel(overrides: Record<string, unknown> = {}) {
  return {
    activeConfig: null,
    activeCredentialChecks: [],
    activeVersion: 0,
    activatedAt: null,
    connectionId: policy.connection.id,
    displayName: terra.displayName,
    draftChecks: [],
    draftConfig: terra.configuration,
    draftVersion: 1,
    enabled: false,
    id: terra.modelId,
    provider: policy.provider,
    templateKey: terra.templateKey,
    updatedAt: now,
    ...overrides
  };
}

function exactGrant(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    groupId: null,
    id: "grant-openai",
    providerConnectionId: null,
    providerModelId: terra.modelId,
    searchStrategy: null,
    updatedAt: now,
    userId: "admin",
    ...overrides
  };
}

function readyGraph(
  secretEnvelope = "envelope-one",
  historicalSecretEnvelope: string | null = secretEnvelope
) {
  const credentialId = "credential-openai";
  const credentialVersionId = "credential-version-openai";
  const activeVersion = {
    id: credentialVersionId,
    revokedAt: null,
    secretEnvelope,
    testedAt: now,
    version: 1
  };
  const credential = {
    activatedAt: now,
    activeVersion,
    activeVersionId: credentialVersionId,
    draftSecretEnvelope: null,
    draftVersion: 1,
    enabled: true,
    groupAssignments: [],
    id: credentialId,
    label: `Quick setup · ${credentialId}`,
    testedAt: now,
    updatedAt: now,
    userAssignments: [{
      connectionId: policy.connection.id,
      credentialId,
      updatedAt: now,
      userId: "admin"
    }],
    versions: [{
      ...activeVersion,
      activatedAt: now,
      credentialId,
      secretEnvelope: historicalSecretEnvelope
    }]
  };
  const model = canonicalModel({
    activeConfig: terra.configuration,
    activeCredentialChecks: [{
      checkedAt: now,
      connectionId: policy.connection.id,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      id: "active-check-openai",
      modelVersion: 1,
      providerModelId: terra.modelId,
      status: "available"
    }],
    activeVersion: 1,
    activatedAt: now,
    enabled: true
  });
  return {
    connection: canonicalConnection({
      activeConfig: policy.connection.configuration,
      activeVersion: 1,
      activatedAt: now,
      credentials: [credential],
      defaultCredentialId: null,
      enabled: true,
      models: [model]
    }),
    credential,
    model
  };
}

function inspectionRepository(input: Readonly<{
  connections?: unknown[];
  grants?: unknown[];
  memberships?: unknown[];
}> = {}) {
  const db = {
    accessGrant: { findMany: vi.fn(async () => input.grants ?? []) },
    authSession: {
      findUnique: vi.fn(async () => ({
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        id: "session-admin",
        revokedAt: null,
        userId: "admin"
      }))
    },
    providerConnection: {
      findMany: vi.fn(async () => input.connections ?? [canonicalConnection()])
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "admin",
        role: "admin",
        status: "active",
        updatedAt: now
      }))
    },
    userSettings: {
      findUnique: vi.fn(async () => ({
        defaultProviderModelId: null,
        id: "settings-admin",
        updatedAt: now
      }))
    },
    userGroup: {
      findMany: vi.fn(async () => input.memberships ?? [])
    }
  };
  return {
    db,
    repository: createPrismaAdminProviderQuickSetupRepository(db as never)
  };
}

describe("Prisma provider Quick setup repository transaction boundary", () => {
  it("maps a unique race to stale without attempting a second transaction", async () => {
    const transaction = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("unique", {
        clientVersion: "6.19.3",
        code: "P2002"
      });
    });
    const repository = createPrismaAdminProviderQuickSetupRepository({
      $transaction: transaction
    } as never);
    const result = await repository.commit({} as never);
    expect(result).toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("retries only the database transaction on serialization conflicts", async () => {
    const transaction = vi.fn()
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("serialization", {
        clientVersion: "6.19.3",
        code: "P2034"
      }))
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("serialization", {
        clientVersion: "6.19.3",
        code: "P2034"
      }))
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("serialization", {
        clientVersion: "6.19.3",
        code: "P2034"
      }));
    const repository = createPrismaAdminProviderQuickSetupRepository({
      $transaction: transaction
    } as never);
    expect(await repository.commit({} as never)).toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("retries PostgreSQL 40001 surfaced through Prisma raw-query P2010", async () => {
    const serialization = () => new Prisma.PrismaClientKnownRequestError("serialization", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "40001" }
    });
    const transaction = vi.fn()
      .mockRejectedValueOnce(serialization())
      .mockRejectedValueOnce(serialization())
      .mockRejectedValueOnce(serialization());
    const repository = createPrismaAdminProviderQuickSetupRepository({
      $transaction: transaction
    } as never);
    expect(await repository.commit({} as never)).toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not mask other Prisma raw-query failures as serialization conflicts", async () => {
    const rawFailure = new Prisma.PrismaClientKnownRequestError("raw query failed", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "42P01" }
    });
    const transaction = vi.fn().mockRejectedValue(rawFailure);
    const repository = createPrismaAdminProviderQuickSetupRepository({
      $transaction: transaction
    } as never);
    await expect(repository.commit({} as never)).rejects.toBe(rawFailure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("maps a missing fenced row to stale without retrying", async () => {
    const transaction = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("missing", {
        clientVersion: "6.19.3",
        code: "P2025"
      });
    });
    const repository = createPrismaAdminProviderQuickSetupRepository({
      $transaction: transaction
    } as never);
    expect(await repository.commit({} as never)).toBe("stale");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("locks provider draft checks without any run-profile fence", async () => {
    const queryRaw = vi.fn(async (_statement: unknown) => []);
    const basePlan = {
      actor: { sessionId: "session-admin", userId: "admin" },
      provider: "openai"
    } as const;
    await lockAdminProviderQuickSetupState(
      { $queryRaw: queryRaw } as never,
      { ...basePlan, mode: "replacement" } as never
    );
    const replacementSql = queryRaw.mock.calls.map(([statement]) =>
      (statement as { strings: readonly string[] }).strings.join(" ")
    );
    expect(replacementSql.some((sql) => sql.includes("ProviderDraftCheck"))).toBe(true);
    expect(replacementSql.some((sql) => sql.includes("RunProfile"))).toBe(false);
    expect(replacementSql.findIndex((sql) => sql.includes('FROM "User"'))).toBeLessThan(
      replacementSql.findIndex((sql) => sql.includes('FROM "UserSettings"'))
    );
    expect(replacementSql.findIndex((sql) => sql.includes('FROM "UserSettings"'))).toBeLessThan(
      replacementSql.findIndex((sql) => sql.includes('FROM "ProviderConnection"'))
    );

    queryRaw.mockClear();
    await lockAdminProviderQuickSetupState(
      { $queryRaw: queryRaw } as never,
      { ...basePlan, mode: "initial" } as never
    );
    const initialSql = queryRaw.mock.calls.map(([statement]) =>
      (statement as { strings: readonly string[] }).strings.join(" ")
    );
    expect(initialSql.some((sql) => sql.includes("RunProfile"))).toBe(false);
    // Without the run-profile fence the lock plan is mode-independent: initial
    // mode must take the exact replacement lock set in the same order.
    expect(initialSql).toEqual(replacementSql);
  });
});

describe("Prisma provider Quick setup eligibility", () => {
  it("keeps an additional same-family connection nonblocking", async () => {
    const customConnection = canonicalConnection({
      displayName: "Custom OpenAI",
      id: "custom-openai",
      templateKey: null
    });
    const { repository } = inspectionRepository({
      connections: [canonicalConnection(), customConnection]
    });
    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "recovery", state: "not_configured" });
  });

  it("accepts the normalized code-owned OpenRouter seed configuration", async () => {
    const openrouter = adminProviderQuickSetupPolicy("openrouter");
    const connection = {
      activeConfig: null,
      activeVersion: 0,
      activatedAt: null,
      credentials: [],
      defaultCredentialId: null,
      displayName: openrouter.connection.displayName,
      draftConfig: openrouter.connection.configuration,
      draftVersion: 1,
      enabled: false,
      family: openrouter.provider,
      id: openrouter.connection.id,
      models: openrouter.candidates.map((candidate) => ({
        activeConfig: null,
        activeCredentialChecks: [],
        activeVersion: 0,
        activatedAt: null,
        displayName: candidate.displayName,
        draftChecks: [],
        draftConfig: candidate.configuration,
        draftVersion: 1,
        enabled: false,
        id: candidate.modelId,
        provider: openrouter.provider,
        templateKey: candidate.templateKey,
        updatedAt: now
      })),
      templateKey: openrouter.connection.templateKey,
      unassignedPolicy: "use_default",
      updatedAt: now
    };
    const { repository } = inspectionRepository({ connections: [connection] });

    await expect(repository.inspect({
      now,
      provider: "openrouter",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "initial", state: "not_configured" });
  });

  it.each([
    ["absent", []],
    ["disabled", [exactGrant({ enabled: false })]],
    ["duplicate", [exactGrant(), exactGrant({ id: "grant-duplicate" })]],
    ["connection-wide", [exactGrant({ providerConnectionId: policy.connection.id })]],
    ["another model", [exactGrant({ providerModelId: policy.candidates[1].modelId })]],
    ["mixed search target", [exactGrant({ searchStrategy: "openai-native-web-search" })]]
  ])("keeps an %s acting-user grant shape repairable", async (_label, grants) => {
    const graph = readyGraph();
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants
    });
    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });
    expect(inspection.mode).not.toBeNull();
    expect(inspection.state).not.toBe("advanced_required");
  });

  it.each([
    ["active availability", {
      activeCredentialChecks: [{
        checkedAt: now,
        connectionId: policy.connection.id,
        connectionVersion: 1,
        credentialId: "credential",
        credentialVersionId: "version",
        modelVersion: 1,
        providerModelId: terra.modelId,
        status: "available"
      }]
    }],
    ["draft preflight", {
      draftChecks: [{
        checkedAt: now,
        connectionDraftVersion: 1,
        connectionId: policy.connection.id,
        credentialDraftVersion: 1,
        credentialId: "credential",
        credentialVersionId: null,
        evidence: { detail: "ok" },
        fingerprint: "draft-fingerprint",
        id: "draft-check",
        modelDraftVersion: 1,
        providerModelId: terra.modelId,
        status: "available"
      }]
    }]
  ])("preserves a disabled seed model with a %s check without blocking Quick setup", async (_label, modelState) => {
    const { repository } = inspectionRepository({
      connections: [canonicalConnection({ models: [canonicalModel(modelState)] })]
    });
    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "recovery", state: "not_configured" });
  });

  it("fences active secret-envelope changes without exposing the envelope", async () => {
    const graph = readyGraph("envelope-one");
    const fixture = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });
    const first = await fixture.repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });
    graph.credential.activeVersion.secretEnvelope = "envelope-two";
    graph.credential.versions[0].secretEnvelope = "envelope-two";
    const second = await fixture.repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });
    expect(first).toMatchObject({ mode: "replacement", state: "ready" });
    expect(second).toMatchObject({ mode: "replacement", state: "ready" });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(first.fingerprint).not.toContain("envelope-one");
  });

  it("treats a full-access member as ready without a materialized model grant", async () => {
    const graph = readyGraph();
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [],
      memberships: [{
        group: { archivedAt: null, systemRole: "full_access" },
        groupId: "full-access",
        userId: "admin"
      }]
    });

    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });

    expect(inspection).toMatchObject({ mode: "replacement", state: "ready" });
    expect(inspection.preservedModels).toEqual([{
      id: terra.modelId,
      upstreamModelId: terra.configuration.upstreamModelId
    }]);
  });

  it("distinguishes untouched initial state from canonical recovery", async () => {
    const initial = inspectionRepository();
    await expect(initial.repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "initial", state: "not_configured" });

    const recovery = inspectionRepository({
      connections: [canonicalConnection({
        activeConfig: policy.connection.configuration,
        activeVersion: 1,
        activatedAt: now,
        enabled: true
      })]
    });
    await expect(recovery.repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "recovery", state: "not_configured" });
  });

  it("presents a configured disabled connection as Disabled", async () => {
    const graph = readyGraph();
    graph.connection.enabled = false;
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });

    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "recovery", state: "disabled" });
  });

  it("does not advertise Ready without a canonical connection activation time", async () => {
    const graph = readyGraph();
    graph.connection.activatedAt = null;
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });
    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: null, state: "advanced_required" });
  });

  it("requires Advanced for an impossible inactive connection tuple", async () => {
    const { repository } = inspectionRepository({
      connections: [canonicalConnection({ activeVersion: 1, activatedAt: now })]
    });
    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: null, state: "advanced_required" });
  });

  it("uses a fresh Quick credential when the assigned credential is not safely reusable", async () => {
    const graph = readyGraph();
    graph.credential.draftVersion = 2;
    graph.credential.versions.push({
      ...graph.credential.versions[0],
      id: "credential-version-openai-two",
      version: 2
    });
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });
    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });
    expect(inspection).toMatchObject({ mode: "replacement", state: "ready" });
    expect(inspection.quickSetupAssignment).toEqual({ credentialId: graph.credential.id });
    expect(inspection.quickSetupCredential).toBeNull();
  });

  it("does not adopt a renamed assigned credential for Quick replacement", async () => {
    const graph = readyGraph();
    graph.credential.label = "Enterprise administrator credential";
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });

    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });

    expect(inspection).toMatchObject({ mode: "replacement", state: "ready" });
    expect(inspection.quickSetupAssignment).toEqual({ credentialId: graph.credential.id });
    expect(inspection.quickSetupCredential).toBeNull();
  });

  it("keeps the assigned Quick credential reusable when it is the connection default", async () => {
    const graph = readyGraph();
    (graph.connection as unknown as { defaultCredentialId: string | null }).defaultCredentialId =
      graph.credential.id;
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });

    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });

    expect(inspection).toMatchObject({ mode: "replacement", state: "ready" });
    expect(inspection.quickSetupCredential).toEqual({
      draftVersion: 1,
      id: graph.credential.id
    });
  });

  it("keeps an enabled configured provider with a missing active credential in Needs attention", async () => {
    const graph = readyGraph();
    const credential = graph.credential as unknown as {
      activeVersion: null;
      activeVersionId: null;
    };
    credential.activeVersion = null;
    credential.activeVersionId = null;
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });
    await expect(repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    })).resolves.toMatchObject({ mode: "recovery", state: "needs_attention" });
  });

  it.each([
    ["a version number beyond the draft", readyGraph()],
    ["a null immutable envelope", readyGraph("active-envelope", null)]
  ])("does not flatten credential history with %s", async (label, graph) => {
    if (label === "a version number beyond the draft") {
      graph.credential.versions.push({
        ...graph.credential.versions[0],
        id: "credential-version-openai-two",
        version: 2
      });
    }
    const { repository } = inspectionRepository({
      connections: [graph.connection],
      grants: [exactGrant()]
    });
    const inspection = await repository.inspect({
      now,
      provider: "openai",
      sessionId: "session-admin",
      userId: "admin"
    });
    expect(inspection.state).not.toBe("advanced_required");
    expect(inspection.quickSetupCredential).toBeNull();
  });
});

describe("Prisma provider Quick setup connection summaries", () => {
  it("returns active connection facts without endpoint or credential material", async () => {
    const findMany = vi.fn(async () => [{
      displayName: "Compatible gateway",
      enabled: true,
      family: "openai_compatible",
      id: "connection-compatible",
      models: [{ id: "model-one" }, { id: "model-two" }]
    }]);
    const repository = createPrismaAdminProviderQuickSetupRepository({
      authSession: {
        findUnique: vi.fn(async () => ({
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          revokedAt: null,
          userId: "admin"
        }))
      },
      providerConnection: { findMany },
      user: {
        findUnique: vi.fn(async () => ({ role: "admin", status: "active" }))
      }
    } as never);

    const summaries = await repository.listConfiguredConnections({
      now,
      sessionId: "session-admin",
      userId: "admin"
    });

    expect(summaries).toEqual([{
      activeModelCount: 2,
      displayName: "Compatible gateway",
      enabled: true,
      family: "openai_compatible",
      id: "connection-compatible"
    }]);
    expect(JSON.stringify(summaries)).not.toMatch(/apiRoot|credential|secret/i);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      where: expect.objectContaining({ family: { not: "fake" } })
    }));
  });
});

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createAcceptedEmbeddingRuntime, createPrismaEmbeddingRuntime } from "./embeddingRuntime";

const KEY = Buffer.alloc(32, 23);
const configuration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 4_096,
    providerFamily: "openrouter",
    queryInstructionTemplate: "Query: {text}",
    supportsMrl: true,
    targetDimension: 1_536
  },
  modelClass: "embedding",
  upstreamModelId: "qwen/qwen3-embedding-8b"
} as const;

function model() {
  return {
    activeConfig: configuration,
    activeVersion: 4,
    connection: {
      activeConfig: {
        allowPrivateNetwork: false,
        apiRoot: "https://openrouter.ai/api/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      activeVersion: 3,
      defaultCredentialId: "credential-1",
      displayName: "OpenRouter",
      family: "openrouter",
      unassignedPolicy: "use_default"
    },
    connectionId: "connection-1",
    displayName: "Qwen embedding",
    id: "embedding-1",
    provider: "openrouter"
  };
}

type StoreOptions = Readonly<{
  checkAvailable?: boolean;
  credentialRevoked?: boolean;
  fullAccess?: boolean;
  grantCount?: number;
  modelAvailable?: boolean;
  userActive?: boolean;
}>;

function store(input: StoreOptions = {}) {
  const envelope = encryptProviderCredentialSecret({
    credentialId: "credential-1",
    key: KEY,
    secret: "exact-runtime-key",
    valueId: "credential-version-1"
  });
  return {
    accessGrant: {
      count: vi.fn(async () => input.grantCount ?? 0)
    },
    providerCredential: {
      findMany: vi.fn(async () => [{
        activeVersion: {
          id: "credential-version-1",
          revokedAt: input.credentialRevoked
            ? new Date("2026-08-08T00:00:00.000Z")
            : null
        },
        enabled: true,
        id: "credential-1"
      }])
    },
    providerGroupCredentialAssignment: {
      findMany: vi.fn(async () => [])
    },
    providerModel: {
      findFirst: vi.fn(async () =>
        input.modelAvailable === false
          ? null
          : model()),
      findUnique: vi.fn(async () =>
        input.modelAvailable === false ? null : { connectionId: "connection-1" })
    },
    providerModelCredentialCheck: {
      findFirst: vi.fn(async () =>
        input.checkAvailable === false ? null : { id: "check-1", evidence: { method: "tiny_generation", upstreamModelId: configuration.upstreamModelId,
          selectedProviders: [], embedding: { probeVersion: 1, document: true, query: true, dimensions: 1536 } } })
    },
    providerCredentialVersion: {
      findFirst: vi.fn(async () => ({
        credentialId: "credential-1",
        id: "credential-version-1",
        revokedAt: null,
        secretEnvelope: envelope,
        testEvidence: { authenticationMode: "bearer" }
      }))
    },
    providerUserCredentialAssignment: {
      findUnique: vi.fn(async () => null)
    },
    user: {
      findFirst: vi.fn(async () =>
        input.userActive === false ? null : { id: "user-1" })
    },
    userGroup: {
      findMany: vi.fn(async () => (input.fullAccess ?? true)
        ? [{ group: { systemRole: "full_access" }, groupId: "full-access" }]
        : [])
    }
  };
}

describe("embedding runtime admission", () => {
  it("applies Full access, current availability, and immutable credential resolution", async () => {
    const prisma = store();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 4_096 }, () => 1), index: 0 }],
      model: "qwen/qwen3-embedding-8b",
      usage: { prompt_tokens: 4, total_tokens: 4 }
    }), { status: 200 }));
    const runtime = createPrismaEmbeddingRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    );

    const binding = await runtime.resolveForUser({
      providerModelId: "embedding-1",
      userId: "user-1"
    });
    const result = await binding.adapter.embed({ mode: "document", texts: ["document"] });

    expect(prisma.accessGrant.count).not.toHaveBeenCalled();
    expect(prisma.providerCredential.findMany).toHaveBeenCalledOnce();
    expect(prisma.providerModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modelClass: "embedding" })
      })
    );
    expect(binding).toMatchObject({
      configuration,
      connectionId: "connection-1",
      connectionVersion: 3,
      credentialId: "credential-1",
      credentialSource: "default",
      credentialVersionId: "credential-version-1",
      executionSnapshot: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        credentialVersionId: "credential-version-1",
        model: configuration,
        providerModelId: "embedding-1",
        version: 1
      },
      modelVersion: 4,
      provider: "openrouter",
      providerModelId: "embedding-1"
    });
    expect(result.vectors[0]).toHaveLength(1_536);
    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer exact-runtime-key");
    expect(prisma.providerCredentialVersion.findFirst).toHaveBeenCalledOnce();
  });

  it("fails closed when the user has no model or provider grant", async () => {
    const prisma = store({ fullAccess: false, grantCount: 0 });
    const runtime = createPrismaEmbeddingRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    );

    await expect(runtime.resolveForUser({
      providerModelId: "embedding-1",
      userId: "user-1"
    })).rejects.toMatchObject({ code: "model_not_available" });
    expect(prisma.accessGrant.count).toHaveBeenCalledOnce();
    expect(prisma.providerModelCredentialCheck.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive user", { userActive: false }, "user_not_available"],
    ["unavailable embedding model", { modelAvailable: false }, "model_not_available"],
    ["revoked effective credential", { credentialRevoked: true }, "credential_revoked"],
    ["missing exact availability check", { checkAvailable: false }, "model_not_available"]
  ] as const)("fails closed for %s", async (_label, options, code) => {
    const prisma = store(options);
    const runtime = createPrismaEmbeddingRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    );

    await expect(runtime.resolveForUser({
      providerModelId: "embedding-1",
      userId: "user-1"
    })).rejects.toMatchObject({ code });
  });

  it("reuses an accepted snapshot without live catalog admission and guards its exact credential", async () => {
    const prisma = store();
    const admitted = await createPrismaEmbeddingRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    ).resolveForUser({ providerModelId: "embedding-1", userId: "user-1" });
    for (const delegate of [
      prisma.accessGrant.count,
      prisma.providerCredential.findMany,
      prisma.providerModel.findFirst,
      prisma.providerModel.findUnique,
      prisma.providerModelCredentialCheck.findFirst,
      prisma.providerGroupCredentialAssignment.findMany,
      prisma.providerUserCredentialAssignment.findUnique,
      prisma.user.findFirst,
      prisma.userGroup.findMany
    ]) delegate.mockClear();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 4_096 }, () => 1), index: 0 }],
      model: "qwen/qwen3-embedding-8b",
      usage: { prompt_tokens: 5, total_tokens: 5 }
    }), { status: 200 }));
    const accepted = createAcceptedEmbeddingRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    );

    const runtime = await accepted.resolve({
      connectionId: admitted.connectionId,
      credentialId: admitted.credentialId,
      credentialVersionId: admitted.credentialVersionId,
      executionSnapshot: admitted.executionSnapshot,
      providerModelId: admitted.providerModelId
    });
    await runtime.adapter.embed({ mode: "query", texts: ["literal query"] });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      input: ["Query: literal query"]
    });
    expect(prisma.providerCredentialVersion.findFirst).toHaveBeenCalledOnce();
    for (const delegate of [
      prisma.accessGrant.count,
      prisma.providerCredential.findMany,
      prisma.providerModel.findFirst,
      prisma.providerModel.findUnique,
      prisma.providerModelCredentialCheck.findFirst,
      prisma.providerGroupCredentialAssignment.findMany,
      prisma.providerUserCredentialAssignment.findUnique,
      prisma.user.findFirst,
      prisma.userGroup.findMany
    ]) expect(delegate).not.toHaveBeenCalled();
  });
});

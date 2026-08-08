import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createPrismaEmbeddingRuntime } from "./embeddingRuntime";

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
        apiRoot: "https://openrouter.ai/api/v1"
      },
      activeVersion: 3,
      credentials: [{
        activeVersion: { id: "credential-version-1", revokedAt: null },
        enabled: true,
        id: "credential-1"
      }],
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

function store(input: Readonly<{
  fullAccess: boolean;
  grantCount?: number;
}> = { fullAccess: true }) {
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
    providerGroupCredentialAssignment: {
      findMany: vi.fn(async () => [])
    },
    providerModel: {
      findFirst: vi.fn(async () => model())
    },
    providerModelCredentialCheck: {
      findFirst: vi.fn(async () => ({ id: "check-1" }))
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
      findFirst: vi.fn(async () => ({ id: "user-1" }))
    },
    userGroup: {
      findMany: vi.fn(async () => input.fullAccess
        ? [{ group: { systemRole: "full_access" }, groupId: "full-access" }]
        : [])
    }
  };
}

describe("embedding runtime admission", () => {
  it("applies Full access, current availability, and immutable credential resolution", async () => {
    const prisma = store();
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({
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
    expect(binding).toMatchObject({
      configuration,
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialSource: "default",
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
});

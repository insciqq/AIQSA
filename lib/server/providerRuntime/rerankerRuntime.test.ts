import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createAcceptedRerankerRuntime,
  createPrismaRerankerRuntime
} from "./rerankerRuntime";

const KEY = Buffer.alloc(32, 29);
const configuration = {
  adapterKind: "openrouter_rerank",
  answerSelectable: false,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  modelClass: "reranker",
  openRouterRouting: {
    mode: "only_selected",
    providers: ["Together"]
  },
  upstreamModelId: "qwen/qwen3-reranker-8b"
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
        responseTimeoutMs: 30_000
      },
      activeVersion: 3,
      defaultCredentialId: "credential-1",
      displayName: "OpenRouter",
      enabled: true,
      family: "openrouter",
      id: "connection-1",
      unassignedPolicy: "use_default"
    },
    connectionId: "connection-1",
    displayName: "Qwen reranker",
    enabled: true,
    id: "reranker-1"
  };
}

function store(input: Readonly<{
  checkAvailable?: boolean;
  credentialRevoked?: boolean;
  modelAvailable?: boolean;
}> = {}) {
  const envelope = encryptProviderCredentialSecret({
    credentialId: "credential-1",
    key: KEY,
    secret: "exact-reranker-key",
    valueId: "credential-version-1"
  });
  return {
    providerCredential: {
      findMany: vi.fn(async () => [{
        activeVersion: {
          id: "credential-version-1",
          revokedAt: input.credentialRevoked
            ? new Date("2026-08-27T00:00:00.000Z")
            : null
        },
        enabled: true,
        id: "credential-1"
      }])
    },
    providerCredentialVersion: {
      findFirst: vi.fn(async () => ({
        credentialId: "credential-1",
        id: "credential-version-1",
        revokedAt: input.credentialRevoked
          ? new Date("2026-08-27T00:00:00.000Z")
          : null,
        secretEnvelope: envelope
      }))
    },
    providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
    providerModel: {
      findFirst: vi.fn(async () => input.modelAvailable === false ? null : model()),
      findUnique: vi.fn(async () => input.modelAvailable === false
        ? null
        : { connectionId: "connection-1" })
    },
    providerModelCredentialCheck: {
      findFirst: vi.fn(async () => input.checkAvailable === false
        ? null
        : { evidence: {}, id: "check-1" })
    },
    providerUserCredentialAssignment: { findUnique: vi.fn(async () => null) }
  };
}

function rerankResponse(): Response {
  return new Response(JSON.stringify({
    id: "request-1",
    model: "qwen/qwen3-reranker-8b",
    results: [{ index: 0, relevance_score: 0.93 }],
    usage: { prompt_tokens: 4, total_tokens: 4 }
  }), { status: 200 });
}

describe("reranker runtime admission", () => {
  it("resolves the installation default credential and exact reranker class", async () => {
    const prisma = store();
    const fetchFn = vi.fn<typeof fetch>(async () => rerankResponse());
    const binding = await createPrismaRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    ).resolveForInstallation({ providerModelId: "reranker-1" });

    const result = await binding.adapter.rerank({
      documents: [{ handle: "c0", text: "dated evidence" }],
      query: "query"
    });

    expect(prisma.providerModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modelClass: "reranker" })
      })
    );
    expect(binding).toMatchObject({
      configuration,
      connectionId: "connection-1",
      connectionVersion: 3,
      credentialId: "credential-1",
      credentialSource: "default",
      credentialVersionId: "credential-version-1",
      modelVersion: 4,
      provider: "openrouter",
      providerModelId: "reranker-1"
    });
    expect(result.scores).toEqual([
      { handle: "c0", index: 0, relevanceScore: 0.93 }
    ]);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer exact-reranker-key");
    expect(prisma.providerCredentialVersion.findFirst).toHaveBeenCalledOnce();
  });

  it.each([
    ["unavailable model", { modelAvailable: false }, "model_not_available"],
    ["missing exact health evidence", { checkAvailable: false }, "model_not_available"],
    ["revoked admission credential", { credentialRevoked: true }, "credential_revoked"]
  ] as const)("fails closed for %s", async (_label, options, code) => {
    const prisma = store(options);
    await expect(createPrismaRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    ).resolveForInstallation({ providerModelId: "reranker-1" }))
      .rejects.toMatchObject({ code });
  });

  it("reuses only the accepted snapshot and checks revocation at request time", async () => {
    const prisma = store();
    const admitted = await createPrismaRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    ).resolveForInstallation({ providerModelId: "reranker-1" });
    for (const delegate of [
      prisma.providerCredential.findMany,
      prisma.providerGroupCredentialAssignment.findMany,
      prisma.providerModel.findFirst,
      prisma.providerModel.findUnique,
      prisma.providerModelCredentialCheck.findFirst,
      prisma.providerUserCredentialAssignment.findUnique
    ]) delegate.mockClear();
    prisma.providerCredentialVersion.findFirst.mockResolvedValueOnce({
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: new Date("2026-08-27T01:00:00.000Z"),
      secretEnvelope: encryptProviderCredentialSecret({
        credentialId: "credential-1",
        key: KEY,
        secret: "revoked-key",
        valueId: "credential-version-1"
      })
    });
    const fetchFn = vi.fn<typeof fetch>(async () => rerankResponse());
    const runtime = await createAcceptedRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    ).resolve({
      connectionId: admitted.connectionId,
      credentialId: admitted.credentialId,
      credentialVersionId: admitted.credentialVersionId,
      executionSnapshot: admitted.executionSnapshot,
      providerModelId: admitted.providerModelId
    });

    await expect(runtime.adapter.rerank({
      documents: [{ handle: "c0", text: "evidence" }],
      query: "query"
    })).rejects.toMatchObject({ code: "rerank_provider_request_failed" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(prisma.providerCredentialVersion.findFirst).toHaveBeenCalledOnce();
    for (const delegate of [
      prisma.providerCredential.findMany,
      prisma.providerGroupCredentialAssignment.findMany,
      prisma.providerModel.findFirst,
      prisma.providerModel.findUnique,
      prisma.providerModelCredentialCheck.findFirst,
      prisma.providerUserCredentialAssignment.findUnique
    ]) expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects accepted evidence that does not match the immutable snapshot", async () => {
    const prisma = store();
    const admitted = await createPrismaRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    ).resolveForInstallation({ providerModelId: "reranker-1" });
    await expect(createAcceptedRerankerRuntime(
      prisma as unknown as PrismaClient,
      { createFetch: () => vi.fn<typeof fetch>(), encryptionKey: () => KEY }
    ).resolve({
      connectionId: "another-connection",
      credentialId: admitted.credentialId,
      credentialVersionId: admitted.credentialVersionId,
      executionSnapshot: admitted.executionSnapshot,
      providerModelId: admitted.providerModelId
    })).rejects.toMatchObject({ code: "model_not_available" });
    expect(prisma.providerCredentialVersion.findFirst).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import type {
  EmbeddingProviderAdmissionRole,
  ProviderAdmissionRole
} from "../../providerRuntime/admission";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import {
  preflightMemoryProviderBindings,
  type MemoryProviderBindingPreflightDependencies
} from "./providerPreflight";

const KEY = Buffer.alloc(32, 31);

function systemRole(): ProviderAdmissionRole {
  const capabilities = {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: true,
    structuredOutput: true,
    vision: false
  };
  return {
    authority: {
      connectionId: "system-connection",
      connectionVersion: 2,
      credentialId: "system-credential",
      credentialVersionId: "system-credential-v1",
      modelVersion: 3,
      providerModelId: "system-model"
    },
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_native",
      capabilities,
      defaultParams: {}
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://system.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "System provider",
      connectionId: "system-connection",
      credentialId: "system-credential",
      credentialVersionId: "system-credential-v1",
      model: {
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "system-upstream"
      },
      modelDisplayName: "System model",
      providerFamily: "openai",
      providerModelId: "system-model",
      version: 1
    }
  };
}

function embeddingRole(): EmbeddingProviderAdmissionRole {
  const model = {
    adapterKind: "openai_embeddings_compatible" as const,
    answerSelectable: false,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 1_536,
      providerFamily: "openai" as const,
      queryInstructionTemplate: null,
      supportsMrl: true,
      targetDimension: 768
    },
    modelClass: "embedding" as const,
    upstreamModelId: "embedding-upstream"
  };
  return {
    authority: {
      connectionId: "embedding-connection",
      connectionVersion: 4,
      credentialId: "embedding-credential",
      credentialVersionId: "embedding-credential-v1",
      modelVersion: 5,
      providerModelId: "embedding-model"
    },
    configuration: model,
    credentialSource: "user",
    provider: "openai",
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://embedding.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Embedding provider",
      connectionId: "embedding-connection",
      credentialId: "embedding-credential",
      credentialVersionId: "embedding-credential-v1",
      model,
      modelDisplayName: "Embedding model",
      providerFamily: "openai",
      providerModelId: "embedding-model",
      version: 1
    }
  };
}

function credential(
  credentialId: string,
  credentialVersionId: string,
  key = KEY
) {
  return {
    credentialId,
    id: credentialVersionId,
    revokedAt: null,
    secretEnvelope: encryptProviderCredentialSecret({
      credentialId,
      key,
      secret: `${credentialId}-secret`,
      valueId: credentialVersionId
    }),
    testEvidence: { authenticationMode: "bearer" }
  };
}

function dependencies(
  overrides: Partial<MemoryProviderBindingPreflightDependencies> = {}
): MemoryProviderBindingPreflightDependencies {
  const system = systemRole();
  const embedding = embeddingRole();
  return {
    encryptionKey: KEY,
    listEnabledOwners: async () => [{
      embeddingProviderModelId: "embedding-model",
      userId: "user-1"
    }],
    loadCredentialVersion: async ({ credentialId, credentialVersionId }) =>
      credential(credentialId, credentialVersionId),
    resolveEmbedding: async () => embedding,
    resolveSystemModel: async () => ({
      credentialScope: "installation",
      ok: true,
      policyVersion: 1,
      providerModelId: "system-model",
      reasoningEffort: null,
      role: system
    }),
    ...overrides
  };
}

describe("Memory coordinator provider preflight", () => {
  it("does not block deletion-only work when the System Model is absent", async () => {
    await expect(preflightMemoryProviderBindings(dependencies({
      resolveSystemModel: async () => ({ code: "system_model_absent", ok: false })
    }))).resolves.toBeUndefined();
  });

  it("does not treat a non-provider fake System Model as a credential binding", async () => {
    const loadCredentialVersion = vi.fn();
    await expect(preflightMemoryProviderBindings(dependencies({
      listEnabledOwners: async () => [],
      loadCredentialVersion,
      resolveSystemModel: async () => ({
        credentialScope: "installation",
        ok: true,
        policyVersion: 1,
        providerModelId: "fake-system-model",
        reasoningEffort: null,
        role: {
          authority: null,
          credentialSource: "default",
          modelConfiguration: {
            adapterKind: "fake",
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              streaming: true,
              vision: false
            },
            defaultParams: {}
          },
          snapshot: {
            connection: {
              allowPrivateNetwork: false,
              apiRoot: "http://fake.invalid",
              authenticationMode: "none",
              responseTimeoutMs: 300_000
            },
            connectionDisplayName: "Fake",
            connectionId: "fake-connection",
            credentialId: null,
            credentialVersionId: null,
            model: {
              adapterKind: "fake",
              answerSelectable: true,
              capabilities: {
                nativePdfInput: false,
                nativeSearch: false,
                pdf: false,
                reasoning: false,
                streaming: true,
                vision: false
              },
              defaultParams: {},
              modelClass: "answer",
              upstreamModelId: "fake"
            },
            modelDisplayName: "Fake",
            providerFamily: "fake",
            providerModelId: "fake-system-model",
            version: 1
          }
        }
      })
    }))).resolves.toBeUndefined();
    expect(loadCredentialVersion).not.toHaveBeenCalled();
  });

  it("does not block an enabled owner without an embedding selection", async () => {
    const resolveEmbedding = vi.fn(async () => embeddingRole());
    await expect(preflightMemoryProviderBindings(dependencies({
      listEnabledOwners: async () => [{
        embeddingProviderModelId: null,
        userId: "user-1"
      }],
      resolveEmbedding
    }))).resolves.toBeUndefined();
    expect(resolveEmbedding).not.toHaveBeenCalled();
  });

  it("does not block when a selected per-user embedding is unavailable", async () => {
    await expect(preflightMemoryProviderBindings(dependencies({
      resolveEmbedding: async () => {
        throw new ProviderAdmissionError("credential_assignment_required");
      }
    }))).resolves.toBeUndefined();
  });

  it("decrypts every exact credential version without provider I/O", async () => {
    const loadCredentialVersion = vi.fn(async ({
      credentialId,
      credentialVersionId
    }: Readonly<{ credentialId: string; credentialVersionId: string }>) =>
      credential(credentialId, credentialVersionId));
    await expect(preflightMemoryProviderBindings(dependencies({
      loadCredentialVersion
    }))).resolves.toBeUndefined();
    expect(loadCredentialVersion).toHaveBeenCalledTimes(2);
  });

  it("fails when the worker key cannot decrypt an admitted credential", async () => {
    await expect(preflightMemoryProviderBindings(dependencies({
      loadCredentialVersion: async ({ credentialId, credentialVersionId }) =>
        credential(credentialId, credentialVersionId, Buffer.alloc(32, 7))
    }))).rejects.toThrow("memory_provider_credential_unreadable");
  });

  it("fails closed on a malformed admitted credential envelope", async () => {
    await expect(preflightMemoryProviderBindings(dependencies({
      loadCredentialVersion: async ({ credentialId, credentialVersionId }) => ({
        credentialId,
        id: credentialVersionId,
        revokedAt: null,
        secretEnvelope: "not-an-envelope",
        testEvidence: { authenticationMode: "bearer" }
      })
    }))).rejects.toThrow("memory_provider_credential_unreadable");
  });
});

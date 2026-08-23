import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";

const bindingMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/runtimeFactory", async (importOriginal) => ({
  ...await importOriginal<typeof import("../providers/runtimeFactory")>(),
  createProviderRuntimeBinding: bindingMock
}));

import { createAcceptedProviderRequestExecutor } from "./acceptedRequestExecutor";

const key = Buffer.alloc(32, 7);

function snapshot(): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Connection",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: true,
        nativeSearch: false,
        pdf: true,
        reasoning: false,
        streaming: true,
        vision: true
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "gpt-test"
    },
    modelDisplayName: "Model",
    providerFamily: "openai",
    providerModelId: "deployment-1",
    version: 1
  };
}

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "internal-request",
    content: { blocks: [{ text: "bounded", type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: snapshot().model.capabilities,
    modelId: "gpt-test",
    params: { stream: false },
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

function result(): ProviderRunResult {
  return {
    finalProviderResponsePreview: {},
    finalText: "settled",
    usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }
  };
}

describe("accepted provider request executor", () => {
  beforeEach(() => {
    bindingMock.mockReset();
  });

  it("rechecks and decrypts the exact credential version at the network boundary", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key,
      secret: "private-test-secret",
      valueId: "credential-version-1"
    });
    const query = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const transaction = vi.fn(async (operation) => operation({ $queryRaw: query }));
    bindingMock.mockImplementation(({ secret }) => ({
      adapter: {
        async *stream() {
          expect(await secret()).toBe("private-test-secret");
          return result();
        }
      }
    }));
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), request())).resolves.toMatchObject({ finalText: "settled" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });

  it("fails closed when the pinned credential version was revoked", async () => {
    const transaction = vi.fn(async (operation) => operation({
      $queryRaw: async () => [{
        credentialId: "credential-1",
        id: "credential-version-1",
        revokedAt: new Date(),
        secretEnvelope: "unused",
        testEvidence: { authenticationMode: "bearer" }
      }]
    }));
    bindingMock.mockImplementation(({ secret }) => ({
      adapter: {
        async *stream() {
          await secret();
          return result();
        }
      }
    }));
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), request())).rejects.toThrow("credential_revoked");
  });

  it("rejects streaming or tool-bearing requests before credential access", async () => {
    const transaction = vi.fn();
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), {
      ...request(),
      forceNonStreaming: false
    })).rejects.toThrow("accepted_provider_request_invalid");
    expect(transaction).not.toHaveBeenCalled();
    expect(bindingMock).not.toHaveBeenCalled();
  });
});

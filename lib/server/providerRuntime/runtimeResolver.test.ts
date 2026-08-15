import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createProviderRuntimeResolver,
  type ProviderRuntimeStore,
  type StoredProviderRunBinding
} from "./runtimeResolver";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";

const KEY = Buffer.alloc(32, 4);

function binding(): StoredProviderRunBinding {
  return {
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "version-1",
    executionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Connection",
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "version-1",
      model: {
        adapterKind: "openai_responses_compatible",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "model-1"
      },
      modelDisplayName: "Model",
      providerFamily: "openai_compatible",
      providerModelId: "deployment-1",
      version: 1
    },
    providerModelId: "deployment-1"
  };
}

function noAuthBinding(): StoredProviderRunBinding {
  const stored = binding();
  const snapshot = stored.executionSnapshot as Record<string, unknown>;
  const model = snapshot.model as Record<string, unknown>;
  return {
    ...stored,
    executionSnapshot: {
      ...snapshot,
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      model: {
        ...model,
        adapterKind: "openai_chat_completions_compatible"
      }
    }
  };
}

function store(overrides: Partial<ProviderRuntimeStore> = {}): ProviderRuntimeStore {
  const stored = binding();
  const envelope = encryptProviderCredentialSecret({
    credentialId: "credential-1",
    key: KEY,
    secret: "secret-key",
    valueId: "version-1"
  });
  return {
    async loadBinding() {
      return stored;
    },
    async withLockedCredential(_credentialId, _credentialVersionId, consume) {
      return consume({
        credentialId: "credential-1",
        id: "version-1",
        revokedAt: null,
        secretEnvelope: envelope,
        testEvidence: {}
      });
    },
    ...overrides
  };
}

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Hello", type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [] },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "model-1",
    params: { stream: false },
    prompt: { developer: null, system: null },
    provider: "openai_compatible",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

async function collect(
  stream: AsyncGenerator<unknown, ProviderRunResult>
): Promise<ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value;
}

describe("provider runtime resolver", () => {
  it("locks and decrypts the exact version before every request and blocks a later call after revoke", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      expect(insideLock).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      return new Response(JSON.stringify({
        id: "response-1",
        output_text: "ok",
        status: "completed",
        usage: {}
      }), { status: 200 });
    });
    let insideLock = false;
    let revoked = false;
    let lockCount = 0;
    const base = store();
    const runtimeStore = store({
      async withLockedCredential(credentialId, versionId, consume) {
        return base.withLockedCredential(credentialId, versionId, (version) => {
          lockCount += 1;
          insideLock = true;
          try {
            return consume({
              ...version,
              revokedAt: revoked ? new Date("2026-07-23T12:00:00.000Z") : null
            });
          } finally {
            insideLock = false;
          }
        });
      }
    });
    const resolver = createProviderRuntimeResolver({
      allowFake: false,
      createFetch: () => {
        expect(insideLock).toBe(false);
        return fetchFn;
      },
      encryptionKey: () => KEY,
      store: runtimeStore
    });

    const runtime = await resolver.resolve("run-1", "answer");
    expect(lockCount).toBe(0);

    await expect(collect(runtime.adapter.stream(request()))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(lockCount).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();

    revoked = true;
    await expect(collect(runtime.adapter.stream(request()))).rejects.toThrow("credential_revoked");
    expect(lockCount).toBe(2);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("locks exact explicit no-auth evidence before every request and blocks a later call after revoke", async () => {
    let insideLock = false;
    let lockCount = 0;
    let revoked = false;
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      expect(insideLock).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "ok", role: "assistant" } }],
        id: "chatcmpl-1",
        model: "model-1",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      }));
    });
    const resolver = createProviderRuntimeResolver({
      allowFake: false,
      createFetch(snapshot) {
        expect(snapshot.connection).toMatchObject({
          allowPrivateNetwork: true,
          authenticationMode: "none"
        });
        return fetchFn;
      },
      encryptionKey: () => {
        throw new Error("no_auth_must_not_decrypt");
      },
      store: {
        async loadBinding() {
          return noAuthBinding();
        },
        async withLockedCredential(credentialId, versionId, consume) {
          expect(credentialId).toBe("credential-1");
          expect(versionId).toBe("version-1");
          lockCount += 1;
          insideLock = true;
          try {
            return consume({
              credentialId,
              id: versionId,
              revokedAt: revoked ? new Date("2026-07-23T12:00:00.000Z") : null,
              secretEnvelope: null,
              testEvidence: { authenticationMode: "none", method: "tiny_generation" }
            });
          } finally {
            insideLock = false;
          }
        }
      }
    });

    const runtime = await resolver.resolve("run-1", "answer");
    expect(lockCount).toBe(0);
    await expect(collect(runtime.adapter.stream(request()))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(lockCount).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();

    revoked = true;
    await expect(collect(runtime.adapter.stream(request()))).rejects.toThrow("credential_revoked");
    expect(lockCount).toBe(2);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    { secretEnvelope: "unexpected", testEvidence: { authenticationMode: "none" } },
    { secretEnvelope: null, testEvidence: { authenticationMode: "bearer" } },
    { secretEnvelope: null, testEvidence: {} }
  ])("rejects no-auth envelope/evidence mismatches", async (version) => {
    const fetchFn = vi.fn<typeof fetch>();
    const resolver = createProviderRuntimeResolver({
      allowFake: false,
      createFetch: () => fetchFn,
      encryptionKey: () => KEY,
      store: {
        async loadBinding() {
          return noAuthBinding();
        },
        async withLockedCredential(_credentialId, _versionId, consume) {
          return consume({
            credentialId: "credential-1",
            id: "version-1",
            revokedAt: null,
            ...version
          });
        }
      }
    });

    const runtime = await resolver.resolve("run-1", "answer");
    await expect(collect(runtime.adapter.stream(request()))).rejects.toThrow("credential_revoked");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { revokedAt: new Date(), secretEnvelope: "unused" },
    { revokedAt: null, secretEnvelope: null },
    {
      revokedAt: null,
      secretEnvelope: "unused",
      testEvidence: { authenticationMode: "none" }
    }
  ])("fails closed for revoked, cleared, or no-auth-only bearer evidence", async (version) => {
    const resolver = createProviderRuntimeResolver({
      allowFake: false,
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => KEY,
      store: store({
        async withLockedCredential(_credentialId, _versionId, consume) {
          return consume({
            credentialId: "credential-1",
            id: "version-1",
            testEvidence: {},
            ...version
          });
        }
      })
    });

    const runtime = await resolver.resolve("run-1", "answer");
    await expect(collect(runtime.adapter.stream(request()))).rejects.toThrow("credential_revoked");
  });

  it("rejects a binding whose live lineage disagrees with its snapshot", async () => {
    const resolver = createProviderRuntimeResolver({
      allowFake: false,
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => KEY,
      store: store({
        async loadBinding() {
          return { ...binding(), credentialVersionId: "other-version" };
        }
      })
    });

    await expect(resolver.resolve("run-1", "answer")).rejects.toThrow("provider_run_binding_invalid");
  });
});

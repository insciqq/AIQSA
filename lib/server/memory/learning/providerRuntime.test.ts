import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { ProviderSafeFetchError } from "../../providers/providerSafeFetch";
import type { ProviderRunRequest } from "../../providers/types";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderFailure
} from "./providerRuntime";

const KEY = Buffer.alloc(32, 23);

function snapshot(): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "Local compatible",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind: "openai_chat_completions_compatible",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: false,
        toolCalling: true,
        vision: false
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "local/model"
    },
    modelDisplayName: "Local model",
    providerFamily: "openai_compatible",
    providerModelId: "deployment-1",
    version: 1
  };
}

function openAIResponsesSnapshot(): ProviderExecutionSnapshot {
  const base = snapshot();
  if (base.model.adapterKind === "fake") throw new Error("provider_fixture_invalid");
  return {
    ...base,
    connection: {
      ...base.connection,
      allowPrivateNetwork: false,
      apiRoot: "https://api.openai.example.test/v1",
      authenticationMode: "bearer"
    },
    model: {
      ...base.model,
      adapterKind: "openai_responses_native",
      upstreamModelId: "gpt-test"
    },
    providerFamily: "openai"
  };
}

function request(runtime: ProviderExecutionSnapshot): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Extract facts.", type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: runtime.model.capabilities,
    modelId: runtime.model.upstreamModelId,
    params: { stream: false },
    prompt: { developer: null, system: null },
    provider: runtime.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}

function client(authenticationMode: "bearer" | "none" = "none") {
  const secretEnvelope = authenticationMode === "bearer"
    ? encryptProviderCredentialSecret({
        credentialId: "credential-1",
        key: KEY,
        secret: "provider-test-secret",
        valueId: "credential-version-1"
      })
    : null;
  const queryRaw = vi.fn(async () => [{
    credentialId: "credential-1",
    id: "credential-version-1",
    revokedAt: null,
    secretEnvelope,
    testEvidence: { authenticationMode }
  }]);
  const transaction = vi.fn(async (
    callback: (tx: Readonly<{ $queryRaw: typeof queryRaw }>) => Promise<unknown>
  ) => callback({ $queryRaw: queryRaw }));
  return {
    client: { $transaction: transaction } as never,
    queryRaw,
    transaction
  };
}

function evidence(runtime: ProviderExecutionSnapshot) {
  return {
    connectionId: runtime.connectionId,
    credentialId: runtime.credentialId!,
    credentialVersionId: runtime.credentialVersionId!,
    executionSnapshot: runtime,
    providerModelId: runtime.providerModelId
  };
}

describe("Memory learning provider runtime", () => {
  it("share-locks the immutable no-auth target and returns one bounded result", async () => {
    const runtime = snapshot();
    const fixture = client();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: "ok", role: "assistant" }
        }],
        id: "response-1",
        model: "local/model",
        usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 }
      }));
    });
    const run = createAcceptedMemoryLearningProvider(fixture.client, {
      buildRequest: (accepted) => request(accepted),
      callError: (_usage, cause) =>
        new Error("memory_provider_outcome_unknown", { cause }),
      createFetch: () => fetchFn,
      invalidRuntimeError: "memory_runtime_invalid"
    });

    await expect(run(evidence(runtime), undefined, new AbortController().signal))
      .resolves.toEqual({
        providerResponseId: "response-1",
        toolCalls: [],
        usage: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 3,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 5
        }
      });
    expect(fixture.transaction).toHaveBeenCalledOnce();
    expect(fixture.queryRaw).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("forwards cancellation and wraps the uncertain provider outcome", async () => {
    const runtime = snapshot();
    const fixture = client();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("test_signal_missing"));
          return;
        }
        const rejectFromSignal = () => reject(signal.reason);
        if (signal.aborted) rejectFromSignal();
        else signal.addEventListener("abort", rejectFromSignal, { once: true });
      }));
    const callError = vi.fn((
      usage: MemoryLearningProviderFailure["usage"],
      cause: MemoryLearningProviderFailure["cause"],
      classification: MemoryLearningProviderFailure["classification"]
    ) =>
      Object.assign(
        new Error("memory_provider_outcome_unknown", { cause }),
        { classification, usage }
      ));
    const run = createAcceptedMemoryLearningProvider(fixture.client, {
      buildRequest: (accepted) => request(accepted),
      callError,
      createFetch: () => fetchFn,
      invalidRuntimeError: "memory_runtime_invalid"
    });
    const controller = new AbortController();
    const pending = run(evidence(runtime), undefined, controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    controller.abort(new Error("operator_cancelled"));

    await expect(pending).rejects.toMatchObject({
      classification: "UNKNOWN",
      message: "memory_provider_outcome_unknown",
      usage: null
    });
    expect(callError).toHaveBeenCalledWith(null, expect.anything(), "UNKNOWN");
  });

  it.each([
    ["provider_http_dns_failed", "REPLAY_SAFE_TRANSIENT"],
    ["provider_http_address_forbidden", "PERMANENT"],
    ["provider_http_request_failed", "UNKNOWN"]
  ] as const)(
    "classifies a pre-result %s failure as %s without parsing error text",
    async (code, classification) => {
      const runtime = snapshot();
      const fixture = client();
      const run = createAcceptedMemoryLearningProvider(fixture.client, {
        buildRequest: (accepted) => request(accepted),
        callError: (usage, cause, failureClassification) => Object.assign(
          new Error("memory_provider_failed", { cause }),
          { classification: failureClassification, usage }
        ),
        createFetch: () => vi.fn<typeof fetch>(async () => {
          throw new ProviderSafeFetchError(code);
        }),
        invalidRuntimeError: "memory_runtime_invalid"
      });

      await expect(run(evidence(runtime), undefined, new AbortController().signal))
        .rejects.toMatchObject({ classification, usage: null });
    }
  );

  it.each([
    [429, "REPLAY_SAFE_TRANSIENT"],
    [503, "REPLAY_SAFE_TRANSIENT"],
    [400, "PERMANENT"]
  ] as const)(
    "classifies provider-agnostic HTTP status %s as %s before adapter parsing",
    async (status, classification) => {
      const runtime = snapshot();
      const fixture = client();
      const run = createAcceptedMemoryLearningProvider(fixture.client, {
        buildRequest: (accepted) => request(accepted),
        callError: (usage, cause, failureClassification) => Object.assign(
          new Error("memory_provider_failed", { cause }),
          { classification: failureClassification, usage }
        ),
        createFetch: () => vi.fn<typeof fetch>(async () =>
          new Response("", { status })),
        invalidRuntimeError: "memory_runtime_invalid"
      });

      await expect(run(evidence(runtime), undefined, new AbortController().signal))
        .rejects.toMatchObject({ classification, usage: null });
    }
  );

  it("leaves a post-dispatch 503 to the provider-native retrieve retry", async () => {
    vi.useFakeTimers();
    const runtime = openAIResponsesSnapshot();
    const fixture = client("bearer");
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "response-1", status: "queued" }));
      }
      if (fetchFn.mock.calls.length === 2) {
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify({
        id: "response-1",
        output: [{
          content: [{ text: "done", type: "output_text" }],
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2 }
      }));
    });
    const run = createAcceptedMemoryLearningProvider(fixture.client, {
      buildRequest: (accepted) => request(accepted),
      callError: (usage, cause, classification) => Object.assign(
        new Error("memory_provider_failed", { cause }),
        { classification, usage }
      ),
      createFetch: () => fetchFn,
      encryptionKey: () => KEY,
      invalidRuntimeError: "memory_runtime_invalid"
    });

    try {
      const pending = run(evidence(runtime), undefined, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ providerResponseId: "response-1" });
      expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual([
        "POST",
        "GET",
        "GET"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../providers/types";
import { createAcceptedMemoryLearningProvider } from "./providerRuntime";

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

function client() {
  const queryRaw = vi.fn(async () => [{
    credentialId: "credential-1",
    id: "credential-version-1",
    revokedAt: null,
    secretEnvelope: null,
    testEvidence: { authenticationMode: "none" }
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
      callError: (_usage, cause) => new Error("memory_provider_outcome_unknown", { cause }),
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
    const callError = vi.fn((usage, cause) =>
      Object.assign(new Error("memory_provider_outcome_unknown", { cause }), { usage }));
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
      message: "memory_provider_outcome_unknown",
      usage: null
    });
    expect(callError).toHaveBeenCalledWith(null, expect.anything());
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import {
  createProviderRuntimeBinding,
  createProviderPreviewRuntimeBinding,
  normalizeProviderExecutionSnapshot
} from "./runtimeFactory";

const runtimeAdapterKinds = [
  "deepseek_responses_native",
  "gemini_interactions_native",
  "openai_responses_native",
  "openai_responses_compatible",
  "openai_chat_completions_compatible",
  "anthropic_messages",
  "openrouter_chat_completions"
] as const;

const runtimeDeadlineCases = runtimeAdapterKinds.flatMap((adapterKind) => [
  { adapterKind, streaming: false },
  { adapterKind, streaming: true }
]);

function snapshot(
  adapterKind: Exclude<
    ProviderExecutionSnapshot["model"]["adapterKind"],
    "fake" | "openai_embeddings_compatible"
  >
): ProviderExecutionSnapshot {
  const providerFamily = adapterKind === "gemini_interactions_native"
    ? "gemini"
    : adapterKind === "deepseek_responses_native"
      ? "deepseek"
    : adapterKind === "openai_responses_native"
    ? "openai"
    : adapterKind === "anthropic_messages"
      ? "anthropic"
      : adapterKind === "openrouter_chat_completions"
        ? "openrouter"
        : "openai_compatible";
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: adapterKind === "anthropic_messages"
        ? "https://api.anthropic.com/v1"
        : "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "Connection",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind,
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
      ...(adapterKind === "openrouter_chat_completions"
        ? { openRouterRouting: { mode: "automatic" as const, providers: [] as [] } }
        : {}),
      upstreamModelId: "upstream/model"
    },
    modelDisplayName: "Model",
    providerFamily,
    providerModelId: "deployment-1",
    version: 1
  };
}

function compatibleRequest(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "hello", type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      vision: false
    },
    modelId: "upstream/model",
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
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("provider runtime factory", () => {
  it.each(runtimeAdapterKinds)("constructs %s only with an explicit safe fetch", (adapterKind) => {
    const fetchFn = vi.fn<typeof fetch>();
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "secret",
      snapshot: snapshot(adapterKind)
    });

    expect(runtime.adapter).toBeDefined();
    expect(Boolean(runtime.searchAdapter)).toBe(adapterKind === "openrouter_chat_completions");
    expect(Boolean(runtime.structuredOutputAdapter)).toBe([
      "deepseek_responses_native",
      "openai_responses_native",
      "openai_responses_compatible",
      "openrouter_chat_completions"
    ].includes(adapterKind));
    expect(runtime.toolBridge?.supportsToolCalling({
      modelId: "upstream/model",
      provider: runtime.toolBridge.provider
    })).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resolves connection and model response deadlines into the immutable binding", () => {
    const defaults = snapshot("openai_chat_completions_compatible");
    const connection = {
      ...defaults,
      connection: { ...defaults.connection, responseTimeoutMs: 500_000 }
    };
    const overridden = {
      ...connection,
      model: { ...connection.model, responseTimeoutMs: 800_000 }
    };
    const create = (value: ProviderExecutionSnapshot) => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: value
    });

    expect(create(defaults).responseTimeoutMs).toBe(300_000);
    expect(create(connection).responseTimeoutMs).toBe(500_000);
    expect(create(overridden).responseTimeoutMs).toBe(800_000);
    expect(normalizeProviderExecutionSnapshot(overridden)).toMatchObject({
      connection: { responseTimeoutMs: 500_000 },
      model: { responseTimeoutMs: 800_000 }
    });
  });

  it.each(runtimeDeadlineCases)(
    "classifies the configured deadline and parent cancellation for $adapterKind (streaming=$streaming)",
    async ({ adapterKind, streaming }) => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn<typeof fetch>(async (_request, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("test_signal_missing"));
              return;
            }
            const rejectFromSignal = () => reject(signal.reason);
            if (signal.aborted) rejectFromSignal();
            else signal.addEventListener("abort", rejectFromSignal, { once: true });
          })
        );
        const configured = snapshot(adapterKind);
        const runtime = createProviderRuntimeBinding({
          options: { allowFake: false, fetchFn },
          secret: "secret",
          snapshot: {
            ...configured,
            connection: { ...configured.connection, responseTimeoutMs: 5_000 }
          }
        });
        const request: ProviderRunRequest = {
          ...compatibleRequest(),
          forceNonStreaming: !streaming,
          modelCapabilities: {
            ...compatibleRequest().modelCapabilities,
            streaming
          },
          params: { stream: streaming },
          provider: configured.providerFamily
        };

        const timedOut = collect(runtime.adapter.stream(request));
        const timeoutExpectation = expect(timedOut).rejects.toMatchObject({
          code: "provider_request_timed_out",
          timeoutMs: 5_000
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await timeoutExpectation;
        expect(vi.getTimerCount()).toBe(0);

        const controller = new AbortController();
        const cancelled = collect(runtime.adapter.stream(request, {
          signal: controller.signal
        }));
        const cancellation = new DOMException("operator_cancelled", "AbortError");
        controller.abort(cancellation);
        const cancellationError = await cancelled.then(
          () => null,
          (error: unknown) => error
        );
        expect(cancellationError).toMatchObject({ name: "AbortError" });
        expect(cancellationError).not.toMatchObject({ code: "provider_request_timed_out" });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("keeps native OpenAI polling alive beyond the connection response deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS", "12000");
    try {
      const configured = snapshot("openai_responses_native");
      const fetchFn = vi.fn<typeof fetch>(async (_request, init) =>
        new Response(JSON.stringify({
          id: "resp-background-window",
          status: init?.method === "POST" ? "queued" : "in_progress"
        }), { status: 200 })
      );
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret: "secret",
        snapshot: {
          ...configured,
          connection: { ...configured.connection, responseTimeoutMs: 5_000 }
        }
      });
      const request: ProviderRunRequest = {
        ...compatibleRequest(),
        modelCapabilities: {
          ...compatibleRequest().modelCapabilities,
          nativeBackground: true
        },
        params: { background: true, stream: false },
        provider: "openai"
      };
      let outcome: unknown = "pending";
      const pending = collect(runtime.adapter.stream(request)).then(
        (value) => { outcome = value; },
        (error: unknown) => { outcome = error; }
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(7_000);
      await pending;
      expect(outcome).toMatchObject({
        code: "provider_request_timed_out",
        timeoutMs: 12_000
      });
      expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("bounded-retries transient initial dispatch for stateless compatible Responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let attempts = 0;
      const fetchFn = vi.fn<typeof fetch>(async () =>
        ++attempts === 1
          ? new Response("gateway unavailable", { status: 502 })
          : new Response(JSON.stringify({
              id: "response-retried",
              model: "upstream/model",
              output_text: "ok",
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }))
      );
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret: "secret",
        snapshot: snapshot("openai_responses_compatible")
      });
      const pending = collect(runtime.adapter.stream(compatibleRequest()));

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ finalText: "ok" });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("never falls back to global fetch", () => {
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: "secret",
      snapshot: snapshot("openai_responses_compatible")
    })).toThrow("provider_safe_fetch_required");
  });

  it.each([
    "anthropic_messages",
    "deepseek_responses_native",
    "gemini_interactions_native",
    "openai_responses_native",
    "openai_responses_compatible"
  ] as const)("exposes the dedicated Search adapter only for Search-capable %s models", (adapterKind) => {
    const base = snapshot(adapterKind);
    const searchCapable: ProviderExecutionSnapshot = {
      ...base,
      model: {
        ...base.model,
        capabilities: {
          ...base.model.capabilities,
          defaultReasoningEffort: "medium",
          nativeSearch: true,
          reasoning: true,
          reasoningEfforts: ["none", "low", "medium"]
        }
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: searchCapable
    });

    expect(runtime.searchAdapter).toBeDefined();
    expect(createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: base
    }).searchAdapter).toBeUndefined();
  });

  it("builds a serializer-only preview boundary without a real credential", () => {
    const preview = createProviderPreviewRuntimeBinding(
      snapshot("openai_chat_completions_compatible"),
      false
    );
    expect(preview.adapter.buildRequestPreview).toBeTypeOf("function");
  });

  it("keeps the versioned compatible reasoning mapping in preview serialization", () => {
    const base = snapshot("openai_chat_completions_compatible");
    const mapped = normalizeProviderExecutionSnapshot({
      ...base,
      model: {
        ...base.model,
        capabilities: { ...base.model.capabilities, reasoning: true },
        reasoningRequestMapping: {
          effortPath: "reason.effort",
          modePath: "reason.mode"
        }
      }
    });
    const runtime = createProviderPreviewRuntimeBinding(mapped, false);
    const preview = runtime.adapter.buildRequestPreview?.({
      ...compatibleRequest(),
      params: {
        reasoning: { effort: "max", mode: "pro" },
        stream: false
      }
    });

    expect(mapped.model).toMatchObject({
      reasoningRequestMapping: {
        effortPath: "reason.effort",
        modePath: "reason.mode"
      }
    });
    expect(preview?.body).toMatchObject({
      reason: { effort: "max", mode: "pro" }
    });
  });

  it("selects only the native Gemini adapter/bridge and rejects family mismatches", () => {
    const gemini = snapshot("gemini_interactions_native");
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: gemini
    });

    expect(runtime.toolBridge?.provider).toBe("gemini");
    expect(runtime.toolBridge?.supportsToolCalling({
      modelId: "gemini-3.6-flash",
      provider: "gemini"
    })).toBe(true);
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_chat_completions_compatible"),
      providerFamily: "gemini"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...gemini,
      providerFamily: "openai_compatible"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      providerFamily: "openai_compatible"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_chat_completions_compatible"),
      providerFamily: "openai"
    })).toThrow("provider_execution_snapshot_invalid");
    const deepseek = snapshot("deepseek_responses_native");
    expect(createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: deepseek
    }).toolBridge?.provider).toBe("deepseek");
    expect(() => normalizeProviderExecutionSnapshot({
      ...deepseek,
      providerFamily: "openai"
    })).toThrow("provider_execution_snapshot_invalid");
  });

  it("routes explicit no-auth compatible Chat through the transport without a credential", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "ok", role: "assistant" } }],
        id: "chatcmpl-1",
        model: "upstream/model",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      }));
    });
    const noAuthSnapshot: ProviderExecutionSnapshot = {
      ...snapshot("openai_chat_completions_compatible"),
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: noAuthSnapshot
    });

    await expect(collect(runtime.adapter.stream(compatibleRequest()))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "unexpected",
      snapshot: noAuthSnapshot
    })).toThrow("provider_credential_unexpected");
  });

  it("routes explicit no-auth compatible Responses Search without an authorization header", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe("http://127.0.0.1:11434/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "upstream/model",
        tools: [{ type: "web_search" }]
      });
      return new Response(JSON.stringify({
        id: "response-local-1",
        model: "upstream/model",
        output_text: "ok",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }));
    });
    const base = snapshot("openai_responses_compatible");
    const noAuthSnapshot: ProviderExecutionSnapshot = {
      ...base,
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      model: {
        ...base.model,
        capabilities: { ...base.model.capabilities, nativeSearch: true }
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: noAuthSnapshot
    });
    const request = {
      ...compatibleRequest(),
      modelCapabilities: {
        ...compatibleRequest().modelCapabilities,
        nativeSearch: true
      },
      searchPlan: {
        mode: "model_choice" as const,
        options: [{
          adapterKind: "answer_provider_hosted" as const,
          config: {},
          credentialMode: "answer_provider" as const,
          executionModes: ["model_choice" as const],
          modelId: null,
          optionId: "custom-web-search:connection-1",
          protocol: "openai_responses_web_search" as const,
          provider: "openai_compatible",
          providerModelId: null,
          revisionId: "revision-hosted",
          searchStrategyRowId: "route-hosted"
        }]
      },
    };

    await expect(collect(runtime.adapter.stream(request))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(runtime.toolBridge).toBeDefined();
    expect(runtime.searchAdapter).toBeDefined();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("keeps bearer snapshots fail-closed without a credential", () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: snapshot("openai_chat_completions_compatible")
    })).toThrow("provider_credential_missing");
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: {
        ...snapshot("openai_chat_completions_compatible"),
        connection: {
          ...snapshot("openai_chat_completions_compatible").connection,
          authenticationMode: "bearer"
        }
      }
    })).toThrow("provider_credential_missing");
  });

  it("rejects no-auth outside compatible Chat and Responses", () => {
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      }
    })).toThrow("provider_execution_snapshot_invalid");
  });

  it("injects a deferred Gemini credential only as x-goog-api-key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "interaction-1",
      model: "gemini-3.6-flash",
      status: "completed",
      steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }]
    })));
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: async () => "resolved-google-secret",
      snapshot: snapshot("gemini_interactions_native")
    });
    const request: ProviderRunRequest = {
      attachmentIds: [],
      attachments: [],
      chatId: "chat-1",
      content: { blocks: [{ text: "hello", type: "text" }] },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      toolMode: "auto",
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: false,
        vision: false
      },
      modelId: "gemini-3.6-flash",
      params: { stream: false },
      prompt: { developer: null, system: null },
      provider: "gemini",
      searchPlan: { mode: "all_selected", options: [] }
    };
    const stream = runtime.adapter.stream(request);
    while (!(await stream.next()).done) {
      // Drain the normalized provider events.
    }

    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-goog-api-key")).toBe("resolved-google-secret");
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps Fake behind the explicit test boundary and credential-free", () => {
    const fake: ProviderExecutionSnapshot = {
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Fake",
      connectionId: "fake-connection",
      credentialId: null,
      credentialVersionId: null,
      model: {
        adapterKind: "fake",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        defaultParams: {},
        upstreamModelId: "fake-qsa"
      },
      modelDisplayName: "Fake QSA",
      providerFamily: "fake",
      providerModelId: "fake-model",
      version: 1
    };

    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: null,
      snapshot: fake
    })).toThrow("fake_provider_not_allowed");
    expect(createProviderRuntimeBinding({
      options: { allowFake: true },
      secret: null,
      snapshot: fake
    }).adapter).toBeDefined();
  });

  it("rejects cross-shape, oversized, and credential-less snapshots", () => {
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      credentialVersionId: null
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      modelDisplayName: "x".repeat(100_000)
    })).toThrow("provider_execution_snapshot_invalid");
  });
});

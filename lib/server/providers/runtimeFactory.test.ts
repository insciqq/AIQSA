import { imageModelConfiguration } from "../../domain/imageModels";
import type { ImageProviderProfile } from "../../contracts/imageGeneration";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import {
  createProviderRuntimeBinding,
  createProviderPreviewRuntimeBinding,
  normalizeProviderExecutionSnapshot
} from "./runtimeFactory";
import { markProviderStreamDrop } from "./streamDrop";
import { providerStreamProgress } from "./streamProgress";
import { ProviderStreamIdleTimeoutError } from "./streamSafety";
import { captureRunObservation } from "@/tests/support/runObservation";

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

function geminiRequest(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "hello", type: "text" }] },
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
}

function geminiCompletedInteraction(): Response {
  return new Response(JSON.stringify({
    id: "interaction-1",
    model: "gemini-3.6-flash",
    status: "completed",
    steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }]
  }));
}

async function collect(
  stream: AsyncGenerator<unknown, ProviderRunResult>
): Promise<ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("provider runtime factory", () => {
  it("round-trips accepted verified answer capabilities without trusting mutable config", () => {
    const raw = snapshot("deepseek_responses_native");
    const recovered = normalizeProviderExecutionSnapshot({
      ...raw,
      model: { ...raw.model, capabilities: {
        ...raw.model.capabilities,
        forcedToolCalling: true,
        structuredOutput: true,
        validatedAutoToolCalling: true
      } }
    });
    expect(recovered.model.capabilities).toMatchObject({
      forcedToolCalling: true,
      structuredOutput: true,
      validatedAutoToolCalling: true
    });
    expect(() => normalizeProviderExecutionSnapshot({
      ...raw,
      model: { ...raw.model, capabilities: {
        ...raw.model.capabilities, structuredOutput: "true"
      } }
    })).toThrow("provider_execution_snapshot_invalid");
  });

  it.each(runtimeAdapterKinds)("round-trips accepted capability evidence for %s without changing the snapshot", (adapterKind) => {
    const base = snapshot(adapterKind);
    const normalized = normalizeProviderExecutionSnapshot(base);
    for (const proof of [true, false, undefined]) {
      const admitted = { ...normalized, model: { ...normalized.model, capabilities: {
        ...normalized.model.capabilities,
        ...(proof === undefined ? {} : {
          structuredOutput: proof, forcedToolCalling: proof, validatedAutoToolCalling: proof
        })
      } } };
      const restored = normalizeProviderExecutionSnapshot(JSON.parse(JSON.stringify(admitted)));
      expect(restored).toEqual(admitted);
      expect(normalizeProviderExecutionSnapshot(restored)).toEqual(restored);
    }
  });

  it.each(["structuredOutput", "forcedToolCalling", "validatedAutoToolCalling"])(
    "rejects malformed accepted %s evidence", (key) => {
      const base = snapshot("deepseek_responses_native");
      for (const value of ["true", 1, null, {}]) expect(() => normalizeProviderExecutionSnapshot({
        ...base, model: { ...base.model, capabilities: { ...base.model.capabilities, [key]: value } }
      })).toThrow("provider_execution_snapshot_invalid");
    }
  );

  it.each<ImageProviderProfile>(["openai", "gemini", "openrouter", "codex_lb", "openai_compatible"])(
    "retains the exact image adapter family in accepted and recovered snapshots (%s)", (profile) => {
      const providerFamily = profile === "codex_lb" ? "openai_compatible" : profile;
      const value = { ...snapshot("openai_responses_native"), providerFamily,
        model: imageModelConfiguration(profile === "gemini" ? "gemini-3.1-flash-image" : "gpt-image-2", { profile }) };
      expect(normalizeProviderExecutionSnapshot(value)).toMatchObject({ providerFamily, model: { image: { profile }, modelClass: "image" } });
      expect(() => normalizeProviderExecutionSnapshot({ ...value, providerFamily: "anthropic" })).toThrow("provider_execution_snapshot_invalid");
    }
  );

  it.each(runtimeAdapterKinds)("constructs %s only with an explicit safe fetch", (adapterKind) => {
    const fetchFn = vi.fn<typeof fetch>();
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "secret",
      snapshot: snapshot(adapterKind)
    });

    expect(runtime.adapter).toBeDefined();
    // A DeepSeek binding always carries the DeepSeek Search API.
    expect(Boolean(runtime.searchAdapter)).toBe(adapterKind === "openrouter_chat_completions" ||
      adapterKind === "deepseek_responses_native");
    expect(Boolean(runtime.structuredOutputAdapter)).toBe([
      "anthropic_messages",
      "deepseek_responses_native",
      "gemini_interactions_native",
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
            connection: { ...configured.connection, responseTimeoutMs: 3_600_000 }
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
          timeoutMs: 3_600_000
        });
        let completed = false;
        void timedOut.then(() => { completed = true; }, () => { completed = true; });
        await vi.advanceTimersByTimeAsync(900_001);
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(3_600_000 - 900_001);
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
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      const physicalRequests = records.filter((entry) => entry.event === "provider_request");
      expect(physicalRequests).toHaveLength(fetchFn.mock.calls.length);
      expect(physicalRequests.every((entry) => entry.timeout_ms === 5_000)).toBe(true);
      expect(records).toContainEqual(expect.objectContaining({
        event: "provider_operation", outcome: "failed", reason: "deadline", timeout_ms: 12_000
      }));
      expect(records).toContainEqual(expect.objectContaining({
        event: "provider_deadline", stage: "answer", provider_timeout_ms: 5_000, effective_timeout_ms: 5_000, poll_timeout_ms: 12_000
      }));
      expect(records).toContainEqual(expect.objectContaining({
        event: "nested_abort", operation: "answer", abort_source: "provider_deadline", deadline_kind: "polling", timeout_ms: 12_000,
        connectionId: "connection-1", providerModelId: "deployment-1"
      }));
    } finally {
      writer.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it.each([{ requested: 25, effective: 25 }, { requested: 7_000, effective: 5_000 }])(
    "reports requested and effective operation deadlines ($requested ms) from the actual runtime clamp",
    async ({ requested, effective }) => {
      const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.useFakeTimers();
      try {
        const configured = snapshot("deepseek_responses_native");
        const fetchFn = vi.fn<typeof fetch>((_request, init) => new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        }));
        const runtime = createProviderRuntimeBinding({
          options: { allowFake: false, fetchFn }, secret: "PRIVATE_KEY_CANARY",
          snapshot: { ...configured, connection: { ...configured.connection, responseTimeoutMs: 5_000 } }
        });
        const result = collect(runtime.adapter.stream(compatibleRequest(), { timeoutMs: requested })).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(effective);
        expect(await result).toMatchObject({ code: "provider_request_timed_out", timeoutMs: effective });
        const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
        expect(records).toContainEqual(expect.objectContaining({ event: "provider_deadline", stage: "answer", configured_timeout_ms: requested, provider_timeout_ms: 5_000, effective_timeout_ms: effective }));
        expect(records).toContainEqual(expect.objectContaining({ event: "nested_abort", deadline_kind: "operation", abort_source: "provider_deadline", timeout_ms: effective, connectionId: "connection-1", providerModelId: "deployment-1" }));
        expect(records).toContainEqual(expect.objectContaining({ event: "nested_abort", deadline_kind: "request", abort_source: "parent_signal", timeout_ms: effective }));
        expect(JSON.stringify(records)).not.toContain("PRIVATE_");
      } finally { writer.mockRestore(); vi.useRealTimers(); }
    }
  );

  it("bounded-retries a rate-limit refusal of the initial dispatch for stateless compatible Responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let attempts = 0;
      const fetchFn = vi.fn<typeof fetch>(async () =>
        ++attempts === 1
          ? new Response("rate limited", { status: 429 })
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

  it("admits the dropped-round retry only for an accepted codex-lb compatible Responses binding", () => {
    const fetchFn = vi.fn<typeof fetch>();
    const base = snapshot("openai_responses_compatible");
    const bind = (value: ProviderExecutionSnapshot, disableRequestRetries = false) => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn, ...(disableRequestRetries ? { disableRequestRetries } : {}) }, secret: "secret", snapshot: value
    }).adapter.droppedRoundRetry;
    const detected = { ...base, connection: { ...base.connection, responsesRequestIsolationDetected: true } };
    const legacyRoot = { ...base, connection: { ...base.connection, apiRoot: "https://lb.example.test/backend-api/codex" } };
    // Before any output: up to six requests within 90 s; after text, three.
    const window = { baseDelayMs: 2_000, maxAttempts: 6, maxBackoffMs: 30_000, windowMs: 90_000 };
    expect(bind(detected)).toMatchObject({ beforeOutput: window, maxAttempts: 3 });
    expect(bind(legacyRoot)).toMatchObject({ beforeOutput: window, maxAttempts: 3 });
    // The catalog evidence outranks the root; other bindings never get it.
    expect(bind({ ...legacyRoot, connection: { ...legacyRoot.connection, responsesRequestIsolationDetected: false } })).toBeUndefined();
    expect(bind(base)).toBeUndefined();
    expect(bind(detected, true)).toBeUndefined();
    // A caller that disables request retries but re-sends drops itself (Vision)
    // keeps the admission on Codex LB only.
    const resending = (value: ProviderExecutionSnapshot) => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn, disableRequestRetries: true, droppedRequestRetry: true }, secret: "secret", snapshot: value
    }).adapter.droppedRoundRetry;
    expect(resending(detected)).toMatchObject({ beforeOutput: window, maxAttempts: 3 });
    expect(resending(base)).toBeUndefined();
    for (const adapterKind of runtimeAdapterKinds.filter((kind) => kind !== "openai_responses_compatible")) {
      const other = snapshot(adapterKind);
      expect(bind({ ...other, connection: { ...other.connection, responsesRequestIsolationDetected: true } })).toBeUndefined();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("records each dropped-round decision content-free under the binding's identity", async () => {
    const observation = await captureRunObservation();
    const base = snapshot("openai_responses_compatible");
    const retry = createProviderRuntimeBinding({ options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() }, secret: "secret",
      snapshot: { ...base, connection: { ...base.connection, responsesRequestIsolationDetected: true } } }).adapter.droppedRoundRetry!;
    const drop = markProviderStreamDrop(new Error("PRIVATE_PROVIDER_MESSAGE_CANARY"), "reset");
    expect(retry.decision(drop)).toEqual({ retryAfterMs: null });
    retry.observe({ action: "retry", attempt: 1, delayMs: 125, error: drop });
    const records = observation.records();
    expect(records).toContainEqual(expect.objectContaining({ event: "provider_retry", level: "warn", action: "retry", attempt: 1, delay_ms: 125,
      stage: "answer", stream_drop: "reset", adapterKind: "openai_responses_compatible", connectionId: "connection-1",
      providerModelId: "deployment-1" }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it.each([
    ["an accepted-then-lost connection", () => Promise.reject(new TypeError("synthetic connection lost after dispatch")),
      { code: "provider_request_outcome_unknown" }],
    ["a gateway 504", async () => new Response("gateway timeout", { status: 504 }), { status: 504 }]
  ] as const)("never repeats a compatible answer dispatch after %s", async (_label, reply, failure) => {
    for (const secret of ["secret", null]) {
      const fetchFn = vi.fn<typeof fetch>(reply);
      const base = snapshot("openai_responses_compatible");
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret,
        snapshot: secret === null
          ? { ...base, connection: { ...base.connection, allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:11434/v1", authenticationMode: "none" } }
          : base
      });
      await expect(collect(runtime.adapter.stream(compatibleRequest()))).rejects.toMatchObject(failure);
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("never falls back to global fetch", () => {
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: "secret",
      snapshot: snapshot("openai_responses_compatible")
    })).toThrow("provider_safe_fetch_required");
  });

  // DeepSeek's hosted Search keeps this rule inside its binding's Search
  // adapter (deepSeekSearchApi.test.ts); the binding also carries the API.
  it.each([
    "anthropic_messages",
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
    const fetchFn = vi.fn<typeof fetch>(async () => geminiCompletedInteraction());
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: async () => "resolved-google-secret",
      snapshot: snapshot("gemini_interactions_native")
    });
    const stream = runtime.adapter.stream(geminiRequest());
    while (!(await stream.next()).done) {
      // Drain the normalized provider events.
    }

    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-goog-api-key")).toBe("resolved-google-secret");
    expect(headers.get("authorization")).toBeNull();
  });

  it("bounded-retries a Gemini rate-limit refusal of the initial dispatch unless the caller disables replay", async () => {
    const observation = await captureRunObservation();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      for (const disableRequestRetries of [false, true]) {
        const earlier = observation.records().length;
        let attempts = 0;
        const fetchFn = vi.fn<typeof fetch>(async () => ++attempts === 1
          ? Response.json({ error: { message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } }, { status: 429 })
          : geminiCompletedInteraction());
        const runtime = createProviderRuntimeBinding({
          options: { allowFake: false, disableRequestRetries, fetchFn },
          secret: "PRIVATE_KEY_CANARY",
          snapshot: snapshot("gemini_interactions_native")
        });
        const pending = collect(runtime.adapter.stream(geminiRequest())).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        const records = observation.records().slice(earlier);
        const retries = records.filter((entry) => entry.event === "provider_retry");
        if (disableRequestRetries) {
          expect(await pending).toMatchObject({ httpStatus: 429, message: "Gemini request failed with status 429" });
          expect(fetchFn).toHaveBeenCalledOnce();
          expect(retries).toMatchObject([{ attempt: 1, action: "stop", httpStatus: 429 }]);
        } else {
          expect(await pending).toMatchObject({ finalText: "ok" });
          expect(fetchFn).toHaveBeenCalledTimes(2);
          expect(retries).toMatchObject([{ attempt: 1, action: "retry", httpStatus: 429, adapterKind: "gemini_interactions_native" }]);
        }
        expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|hello/u);
      }
    } finally {
      observation.restore();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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
    expect(normalizeProviderExecutionSnapshot({ ...fake, model: { ...fake.model, capabilities: {
      ...fake.model.capabilities, structuredOutput: true, forcedToolCalling: true, validatedAutoToolCalling: true
    } } }).model.capabilities).toEqual(fake.model.capabilities);

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

  describe("a streamed answer's response timeout, idle timeout and ceiling (decision 2026-11-11)", () => {
    const streamedRequest = (): ProviderRunRequest => ({ ...compatibleRequest(), forceNonStreaming: false,
      modelCapabilities: { ...compatibleRequest().modelCapabilities, streaming: true }, params: { stream: true } });
    const compatible = (codexLb: boolean): ProviderExecutionSnapshot => {
      const base = snapshot("openai_responses_compatible");
      return { ...base, connection: { ...base.connection, responseTimeoutMs: 300_000, ...(codexLb ? { responsesRequestIsolationDetected: true } : {}) } };
    };
    const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n';
    const delta = (text: string) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", response_id: "r1", delta: text })}\n\n`;
    const completed = (text: string) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
      id: "r1", model: "upstream/model", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`;
    const encoder = new TextEncoder();
    // One response whose headers arrive after `headersAfterMs` and whose body the test writes.
    const upstream = (headersAfterMs = 0) => {
      const body: { controller?: ReadableStreamDefaultController<Uint8Array>; cancelled: number } = { cancelled: 0 };
      const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) { body.controller = controller; },
          cancel() { body.cancelled += 1; }
        }), { headers: { "content-type": "text/event-stream" } })), headersAfterMs);
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }));
      const send = (text: string) => {
        // A cancelled body takes nothing more.
        try { body.controller?.enqueue(encoder.encode(text)); } catch { /* closed */ }
      };
      return { body, fetchFn, send };
    };
    // Writes `text` every `everyMs` until `untilMs` of fake time passed.
    const every = async (everyMs: number, untilMs: number, write: () => void) => {
      for (let elapsed = 0; elapsed + everyMs <= untilMs; elapsed += everyMs) {
        await vi.advanceTimersByTimeAsync(everyMs);
        write();
      }
    };
    const run = (fetchFn: typeof fetch, codexLb = true) => {
      const runtime = createProviderRuntimeBinding({ options: { allowFake: false, fetchFn }, secret: "secret", snapshot: compatible(codexLb) });
      let outcome: unknown = "pending";
      const settled = collect(runtime.adapter.stream(streamedRequest(), { timeoutMs: 300_000 }))
        .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
      return { outcome: () => outcome, settled };
    };

    it("lets a live stream answer past the response timeout, and leaves no timer behind", async () => {
      const observation = await captureRunObservation();
      vi.useFakeTimers();
      try {
        const provider = upstream();
        const call = run(provider.fetchFn);
        await vi.advanceTimersByTimeAsync(0);
        provider.send(created);
        // Ten minutes of text, a delta every 30 s: twice the 300 s response timeout.
        await every(30_000, 600_000, () => provider.send(delta("x")));
        expect(call.outcome()).toBe("pending");
        provider.send(completed("x".repeat(20)));
        provider.body.controller?.close();
        await call.settled;
        expect(call.outcome()).toMatchObject({ finalText: "x".repeat(20) });
        expect(vi.getTimerCount()).toBe(0);
        expect(observation.records()).toContainEqual(expect.objectContaining({ event: "provider_deadline",
          stream_idle_timeout_ms: 60_000, stream_absolute_timeout_ms: 1_800_000 }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("ends a live stream at its 30-minute ceiling, which no attempt would pass, and releases it", async () => {
      vi.useFakeTimers();
      try {
        // The ceiling counts from the request, so it ends the stream before the parser's own, counted from the headers.
        const provider = upstream(1_000);
        const call = run(provider.fetchFn);
        await vi.advanceTimersByTimeAsync(1_000);
        provider.send(created);
        // A delta every 50 s up to 1751 s, then the ceiling 1800 s after the request started.
        await every(50_000, 1_750_000, () => provider.send(delta("x")));
        await vi.advanceTimersByTimeAsync(48_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await call.settled;
        expect(call.outcome()).toMatchObject({ code: "provider_request_timed_out", timeoutMs: 1_800_000 });
        expect(providerStreamProgress(call.outcome())).toMatchObject({ response_started: true });
        expect(provider.body.cancelled).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ends a Codex LB stream after a minute without a byte, keepalive included, as an idle timeout", async () => {
      vi.useFakeTimers();
      try {
        const provider = upstream();
        const call = run(provider.fetchFn);
        await vi.advanceTimersByTimeAsync(0);
        provider.send(created);
        await every(10_000, 120_000, () => provider.send(": keepalive\n\n"));
        await vi.advanceTimersByTimeAsync(59_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await call.settled;
        expect(call.outcome()).toBeInstanceOf(ProviderStreamIdleTimeoutError);
        expect(call.outcome()).toMatchObject({ code: "provider_stream_timeout", idleTimeoutMs: 60_000 });
        expect(provider.body.cancelled).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the response timeout as the silence another compatible endpoint may keep", async () => {
      vi.useFakeTimers();
      try {
        const provider = upstream();
        const call = run(provider.fetchFn, false);
        await vi.advanceTimersByTimeAsync(0);
        provider.send(created);
        await vi.advanceTimersByTimeAsync(299_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await call.settled;
        expect(call.outcome()).toMatchObject({ code: "provider_stream_timeout", idleTimeoutMs: 300_000 });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ["no headers", Number.POSITIVE_INFINITY, ": keepalive\n\n"],
      ["headers after 200 s, then only keepalive comments", 200_000, ": keepalive\n\n"],
      ["headers, then only a proxy's empty data frames", 0, "data: \n\n"]
    ] as const)("names a request whose response did not start within the response timeout: %s", async (_label, headersAfterMs, keepalive) => {
      vi.useFakeTimers();
      try {
        const provider = upstream(headersAfterMs === Number.POSITIVE_INFINITY ? 2_000_000_000 : headersAfterMs);
        const call = run(provider.fetchFn);
        // Keepalives every 10 s once the body is open; the response timeout counts from the request, not the headers.
        await every(10_000, 290_000, () => provider.send(keepalive));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await call.settled;
        expect(call.outcome()).toMatchObject({ code: "provider_request_timed_out", timeoutMs: 300_000 });
        expect(providerStreamProgress(call.outcome())).toMatchObject({ response_started: false });
        if (headersAfterMs !== Number.POSITIVE_INFINITY) expect(provider.body.cancelled).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
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

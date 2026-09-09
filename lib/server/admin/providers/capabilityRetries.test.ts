import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSafeFetchError } from "../../providers/providerSafeFetch";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";

function input(): AdminProviderDraftTesterInput {
  return {
    connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
    connectionDisplayName: "Synthetic", connectionId: "connection", credentialId: "credential", credentialVersionIdentity: "version",
    capabilityRole: "direct_pdf", mode: "tiny_generation", modelDisplayName: "Synthetic", providerFamily: "openai_compatible",
    providerModelId: "model", secret: "synthetic-secret",
    model: { adapterKind: "openai_responses_compatible", answerSelectable: true,
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      defaultParams: {}, modelClass: "answer", upstreamModelId: "synthetic-model" }
  };
}
function completed(text = "OK") {
  return Response.json({ id: "synthetic-response", status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text }] }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } });
}
function terminal(status: string, code = "server_error") {
  return Response.json({ id: "synthetic-response", status, output: [], error: { code, message: "PRIVATE_SYNTHETIC_DETAIL" },
    incomplete_details: { reason: "max_output_tokens" } });
}

afterEach(() => vi.useRealTimers());

describe("bounded capability retries", () => {
  it.each(["failed", "incomplete", "network", "project_rate_limit", 429, 500, 503] as const)(
    "retries only a failed PDF probe after exactly 2 and 3 seconds: %s", async (failure) => {
      vi.useFakeTimers();
      let attempts = 0;
      const bodies: string[] = [];
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(String(init?.body));
        attempts += 1;
        if (attempts === 1) return completed();
        if (attempts === 4) return completed("PEARS");
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "project_rate_limit") return Response.json({ error: { message: "Rate limit reached for this project." } }, { status: 429 });
        return typeof failure === "number" ? Response.json({}, { status: failure }) : terminal(failure);
      });
      const outcome = createAdminProviderDraftTester({ createFetch: () => fetchFn }).test(input());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ status: "available", evidence: { pdfInput: { verified: true } } });
      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(bodies.slice(1)).toEqual([bodies[1], bodies[1], bodies[1]]);
    }
  );

  it("fails after three terminal attempts without publishing negative evidence", async () => {
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => terminal("failed"));
    fetchFn.mockImplementationOnce(async () => completed());
    await expect(createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test(input()))
      .rejects.toThrow("compatible_response_failed");
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(retrySleep.mock.calls).toEqual([[2_000, undefined], [3_000, undefined]]);
  });

  it.each([400, 401, 403, 404, 405, 415, 422, "wrong_answer", "unsupported_parameter", "unsupported_image", "cancelled", "invalid_api_key"] as const)(
    "never retries an explicit rejection, authentication failure or cancellation: %s", async (failure) => {
      const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => typeof failure === "number"
        ? Response.json({}, { status: failure }) : failure === "wrong_answer" ? completed("WRONG")
          : terminal(failure === "cancelled" ? "cancelled" : "failed", failure));
      fetchFn.mockImplementationOnce(async () => completed());
      const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test(input());
      if (typeof failure === "number" || failure === "unsupported_parameter" || failure === "wrong_answer" || failure === "cancelled" || failure === "invalid_api_key") {
        await expect(outcome).rejects.toBeInstanceOf(Error);
      } else {
        await expect(outcome).resolves.toMatchObject({ status: "available", evidence: { compatibility: { directPdf: "not_supported" } } });
      }
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(retrySleep).not.toHaveBeenCalled();
    }
  );

  it.each(["provider_response_too_large", "provider_stream_deadline_exceeded", "vision_input_fixture_unavailable"])(
    "does not repeat local safety or fixture failure %s", async (code) => {
      const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
      const probe = vi.fn(async () => { throw new Error(code); });
      await expect(createAdminProviderDraftTester({ retrySleep, createFetch: () => async () => completed(), pdfInputProbe: { probe } })
        .test(input())).rejects.toThrow(code);
      expect(probe).toHaveBeenCalledOnce();
      expect(retrySleep).not.toHaveBeenCalled();
    }
  );

  it("cancels the retry timer immediately and never dispatches after Stop", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => terminal("incomplete"));
    fetchFn.mockImplementationOnce(async () => completed());
    const outcome = createAdminProviderDraftTester({ createFetch: () => fetchFn }).test({ ...input(), signal: controller.signal });
    const rejection = expect(outcome).rejects.toBe("operator_stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    controller.abort("operator_stop");
    await rejection;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(["unsupported_parameter", "invalid_api_key", "cancelled"])("retains safe nonretryable structured-output category %s", async (code) => {
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => terminal(code === "cancelled" ? "cancelled" : "failed", code));
    fetchFn.mockImplementationOnce(async () => completed());
    const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn })
      .test({ ...input(), capabilityRole: "memory" });
    if (code === "unsupported_parameter") await expect(outcome).resolves.toMatchObject({ evidence: { compatibility: { structuredOutput: "not_supported" } } });
    else await expect(outcome).rejects.toMatchObject({ code: code === "cancelled" ? "provider_response_cancelled" : "provider_response_not_retryable" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retrySleep).not.toHaveBeenCalled();
  });

  it.each(["network", 503, "unsafe"] as const)("bounds embedding query retries without repeating document proof or hedging: %s", async (failure) => {
    const base = input();
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    let queries = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(body.input).includes("query")) {
        queries += 1;
        if (failure === "unsafe") throw new ProviderSafeFetchError("provider_http_address_forbidden");
        if (queries < 3) {
          if (failure === "network") throw new TypeError("fetch failed");
          return Response.json({}, { status: failure });
        }
      }
      return Response.json({ model: "synthetic-embedding", data: [{ index: 0, embedding: [1, 2, 3] }] });
    });
    const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test({ ...base,
      capabilityRole: "embedding", providerFamily: "openrouter", model: { ...base.model, adapterKind: "openai_embeddings_compatible",
        answerSelectable: false, modelClass: "embedding", upstreamModelId: "synthetic-embedding",
        openRouterRouting: { mode: "only_selected", providers: ["Together", "DeepInfra"] },
        embedding: { nativeDimension: 3, targetDimension: 3, providerFamily: "openrouter", queryInstructionTemplate: null, supportsMrl: false } } });
    if (failure === "unsafe") {
      await expect(outcome).rejects.toThrow("embedding_provider_request_failed");
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(retrySleep).not.toHaveBeenCalled();
    } else {
      await expect(outcome).resolves.toMatchObject({ status: "available" });
      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(queries).toBe(3);
      expect(retrySleep.mock.calls.map(([delay]) => delay)).toEqual([2_000, 3_000]);
    }
  });

  it.each(["network", 503, "unsafe"] as const)("bounds rerank retries without multiplying transport attempts: %s", async (failure) => {
    const base = input();
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    let attempts = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      if (failure === "unsafe") throw new ProviderSafeFetchError("provider_http_address_forbidden");
      if (attempts < 3) {
        if (failure === "network") throw new TypeError("fetch failed");
        return Response.json({}, { status: failure });
      }
      return Response.json({ model: "qwen/qwen3-reranker-8b", provider: "Together",
        results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] });
    });
    const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test({ ...base,
      capabilityRole: "reranker", providerFamily: "openrouter", model: { ...base.model, adapterKind: "openrouter_rerank",
        answerSelectable: false, modelClass: "reranker", upstreamModelId: "qwen/qwen3-reranker-8b",
        openRouterRouting: { mode: "only_selected", providers: ["Together"] } } });
    if (failure === "unsafe") {
      await expect(outcome).rejects.toThrow("rerank_provider_request_failed");
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(retrySleep).not.toHaveBeenCalled();
    } else {
      await expect(outcome).resolves.toMatchObject({ status: "available" });
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(retrySleep.mock.calls.map(([delay]) => delay)).toEqual([2_000, 3_000]);
    }
  });

  it.each([[500, "unsupported_parameter"], [429, "insufficient_quota"], [401, "unsupported_parameter"]] as const)(
    "honors bounded HTTP error category %s/%s without leaking upstream details", async (status, code) => {
      const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
        error: { code, message: "PRIVATE_SYNTHETIC_DETAIL" }
      }, { status }));
      fetchFn.mockImplementationOnce(async () => completed());
      const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test(input());
      const error = await outcome.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("PRIVATE_SYNTHETIC_DETAIL");
      expect(JSON.stringify(error)).not.toContain("PRIVATE_SYNTHETIC_DETAIL");
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(retrySleep).not.toHaveBeenCalled();
    }
  );

  it.each([
    [400, "unsupported_file_type", "PRIVATE_SYNTHETIC_DETAIL", true],
    [400, "invalid_request", "This model does not support PDF input.", true],
    [400, "unsupported_parameter", "Reasoning is not supported.", false],
    [400, "unsupported_parameter", "The input parameter 'reasoning' is not supported with this model.", false],
    [500, "unsupported_file_type", "PRIVATE_SYNTHETIC_DETAIL", false],
    [400, "invalid_request", "File processing failed.", false]
  ] as const)("requires explicit input incompatibility for PDF HTTP %s/%s", async (status, code, message, unsupported) => {
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code, message } }, { status }));
    fetchFn.mockImplementationOnce(async () => completed());
    const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test(input());
    if (unsupported) await expect(outcome).resolves.toMatchObject({ evidence: { compatibility: { directPdf: "not_supported" } } });
    else await expect(outcome).rejects.toBeInstanceOf(Error);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retrySleep).not.toHaveBeenCalled();
  });

  it.each([
    ["This model does not support PDF input.", true],
    ["Structured output is not supported by this model.", true],
    ["Unsupported feature: JSON schema", true],
    ["This model does not support this request.", true],
    ["Not supported", false],
    ["This API key does not support PDF input.", false],
    ["Quota exhausted; PDFs are not supported at this billing limit.", false],
    ["Unsupported model: nonexistent", false],
    ["This model is not supported.", false],
    ["Content policy does not support this PDF.", false]
  ] as const)("does not retry a clear unsupported message and preserves authority for access/policy failures: %s", async (message, unsupported) => {
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      id: "synthetic-response", status: "failed", output: [], error: { message }
    }));
    fetchFn.mockImplementationOnce(async () => completed());
    const outcome = createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn })
      .test({ ...input(), capabilityRole: "memory" });
    if (unsupported) await expect(outcome).resolves.toMatchObject({ evidence: { compatibility: { structuredOutput: "not_supported" } } });
    else {
      const error = await outcome.catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "provider_response_not_retryable" });
      expect(String(error)).not.toContain(message);
      expect(JSON.stringify(error)).not.toContain(message);
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retrySleep).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "not_supported"])("does not retry an explicit unsupported code without a message: %s", async (code) => {
    const retrySleep = vi.fn(async (_delay: number, _signal?: AbortSignal) => {});
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      status: "failed", output: [], error: { code }
    }));
    fetchFn.mockImplementationOnce(async () => completed());
    await expect(createAdminProviderDraftTester({ retrySleep, createFetch: () => fetchFn }).test(input()))
      .rejects.toMatchObject({ code: "provider_response_not_retryable" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retrySleep).not.toHaveBeenCalled();
  });
});

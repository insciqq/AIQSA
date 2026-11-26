import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSearchDraft } from "../../../contracts/adminSearch";
import { loadTechnicalProviderRole } from "../../providerRuntime/admission";
import { createProviderRuntimeBinding } from "../../providers/runtimeFactory";
import { ProviderSearchExecutionError, type ProviderModelCapabilities, type ProviderSearchAdapter } from "../../providers/types";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import type { ModelCheckUsageWriter } from "../providers/modelCheckUsage";
import { adminSearchProviderPolicy, createAdminSearchTester } from "./tester";

vi.mock("../../providerRuntime/admission", () => ({ loadTechnicalProviderRole: vi.fn() }));
vi.mock("../../providers/runtimeFactory", () => ({ createProviderRuntimeBinding: vi.fn() }));
vi.mock("../../providers/providerSafeFetch", () => ({ createProviderSafeFetch: vi.fn(() => vi.fn()) }));

const capabilities: ProviderModelCapabilities = {
  nativePdfInput: false,
  nativeSearch: true,
  pdf: false,
  reasoning: true,
  reasoningEfforts: ["low", "medium", "high"],
  streaming: true,
  toolCalling: true,
  vision: false
};

function draft(protocol: AdminSearchDraft["protocol"]): AdminSearchDraft {
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxOutputTokens: 4_096,
    protocol,
    providerModelId: "technical-model",
    queryMaxCharacters: 500,
    reasoningPolicy: "lowest_supported",
    timeoutMs: 300_000
  };
}

describe("admin Search diagnostic policies", () => {
  it("builds the exact Anthropic policy and rejects another provider before dispatch", () => {
    const input = { capabilities, defaultParams: {}, draft: draft("anthropic_web_search"),
      modelId: "selected-anthropic-model", provider: "anthropic" };
    expect(adminSearchProviderPolicy(input)).toEqual({ maxOutputTokens: 4_096,
      modelCapabilities: capabilities, modelId: input.modelId, provider: "anthropic",
      reasoningPolicy: "lowest_supported", strategyId: "anthropic-web-search" });
    expect(() => adminSearchProviderPolicy({ ...input, provider: "openai" })).toThrow("search_protocol_not_supported");
  });
  it("builds the query-only Gemini policy from the exact draft and model", () => {
    expect(adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("gemini_google_search"),
      modelId: "gemini-3.6-flash",
      provider: "gemini"
    })).toEqual({
      maxOutputTokens: 4_096,
      modelCapabilities: capabilities,
      modelId: "gemini-3.6-flash",
      provider: "gemini",
      reasoningPolicy: "lowest_supported",
      strategyId: "gemini-google-search"
    });
  });

  it("keeps OpenAI diagnostics on their typed client policy and refuses Perplexity Sonar", () => {
    expect(adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("openai_responses_web_search"),
      modelId: "gpt-5.6-terra",
      provider: "openai"
    })).toMatchObject({
      modelId: "gpt-5.6-terra",
      provider: "openai",
      strategyId: "openai-responses-web-search"
    });
    // Perplexity Sonar (retired 2026-11-26) has no policy any more.
    expect(() => adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("openrouter_perplexity_chat" as AdminSearchDraft["protocol"]),
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter"
    })).toThrow("search_protocol_not_supported");
  });

  it("runs OpenRouter's web search with the draft's engine on the technical model and its routing", () => {
    const input = { capabilities, defaultParams: { provider: { dataCollection: "deny" } },
      draft: { ...draft("openrouter_web_search"), openRouterWebSearch: { engine: "exa" as const, mode: "auto" } },
      modelId: "deepseek/deepseek-v4.1-flash", provider: "openrouter" };
    expect(adminSearchProviderPolicy(input)).toEqual({
      defaultParams: { provider: { dataCollection: "deny" } }, engine: "exa", mode: "auto", modelCapabilities: capabilities,
      modelId: "deepseek/deepseek-v4.1-flash", provider: "openrouter", strategyId: "openrouter-web-search"
    });
    expect(() => adminSearchProviderPolicy({ ...input, provider: "openai" })).toThrow("search_protocol_not_supported");
  });

  it("rejects a protocol on the wrong provider family", () => {
    expect(() => adminSearchProviderPolicy({
      capabilities,
      defaultParams: {},
      draft: draft("gemini_google_search"),
      modelId: "not-gemini",
      provider: "openai"
    })).toThrow("search_protocol_not_supported");
  });

  it("checks the DeepSeek Search API with one raw results request, never the carrier model", () => {
    const input = { capabilities, defaultParams: {}, draft: { ...draft("deepseek_search_api"), queryMaxCharacters: 128 },
      modelId: "deepseek-flash", provider: "deepseek" };
    expect(adminSearchProviderPolicy(input)).toEqual({
      modelId: "deepseek-search-api", provider: "deepseek", strategyId: "deepseek-search-api"
    });
    expect(() => adminSearchProviderPolicy({ ...input, provider: "openrouter" })).toThrow("search_protocol_not_supported");
  });
});

describe("admin Search diagnostic execution", () => {
  const search = vi.fn<ProviderSearchAdapter["search"]>();
  const probeBinding = {
    connectionId: "connection",
    connectionVersion: 1,
    credentialId: "no-auth",
    credentialVersionId: "no-auth",
    modelVersion: 1,
    providerModelId: "technical-model"
  };
  const sourceResult = () => ({
    artifacts: [],
    finalProviderResponsePreview: {},
    findings: "Official website.",
    requestPreview: {},
    sources: [{ rank: 1, title: "Official website", url: "https://example.test" }],
    usage: { inputTokens: 5, outputTokens: 3 }
  });
  const tester = () => createAdminSearchTester({} as PrismaClient);
  function runtime(responseTimeoutMs: number) {
    vi.mocked(createProviderRuntimeBinding).mockReturnValue({
      adapter: {
        buildRequestPreview: () => ({}),
        async *stream() { throw new Error("unexpected_answer_dispatch"); }
      },
      responseTimeoutMs,
      searchAdapter: { buildRequestPreview: () => ({}), search }
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    search.mockReset().mockResolvedValue(sourceResult());
    vi.mocked(loadTechnicalProviderRole).mockResolvedValue({
      authority: probeBinding,
      credentialSource: "default",
      modelConfiguration: { adapterKind: "openai_responses_compatible", capabilities, defaultParams: {} },
      snapshot: {
        connection: {
          allowPrivateNetwork: false,
          apiRoot: "https://example.test/v1",
          authenticationMode: "none",
          responseTimeoutMs: 120_000
        },
        connectionDisplayName: "Connection",
        connectionId: "connection",
        credentialId: null,
        credentialVersionId: null,
        model: {
          adapterKind: "openai_responses_compatible",
          answerSelectable: true,
          capabilities,
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: "upstream-model"
        },
        modelDisplayName: "Model",
        providerFamily: "openai_compatible",
        providerModelId: "technical-model",
        version: 1
      }
    });
    runtime(120_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every returned source without a configured result count", async () => {
    search.mockResolvedValueOnce({ ...sourceResult(), sources: Array.from({ length: 50 }, (_, index) => ({
      rank: index + 1, title: `Source ${index}`, url: `https://example.test/source/${index}`
    })) });
    await expect(tester().test({ draft: draft("openai_responses_web_search"), userId: "admin" }))
      .resolves.toMatchObject({ normalizedSourceCount: 50, status: "available" });
  });

  it("checks the smallest admitted query limit and clears the settled deadline", async () => {
    vi.useFakeTimers();
    const selectedDraft = { ...draft("openai_responses_web_search"), queryMaxCharacters: 32 };

    await expect(tester().test({ draft: selectedDraft, userId: "admin" })).resolves.toMatchObject({
      normalizedSourceCount: 1,
      probeBinding,
      status: "available"
    });
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]![0].query.length).toBeLessThanOrEqual(32);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { draftTimeout: 120_000, providerTimeout: 5_000 },
    { draftTimeout: 5_000, providerTimeout: 120_000 }
  ])("uses the earlier Search or provider deadline ($draftTimeout / $providerTimeout)", async ({
    draftTimeout, providerTimeout
  }) => {
    vi.useFakeTimers();
    runtime(providerTimeout);
    search.mockImplementation((_request, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const execution = tester().test({
      draft: { ...draft("openai_responses_web_search"), timeoutMs: draftTimeout },
      userId: "admin"
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    const effectiveTimeout = Math.min(draftTimeout, providerTimeout);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]![1]?.timeoutMs).toBe(effectiveTimeout);
    const signal = search.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(effectiveTimeout - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(await execution).toMatchObject({ code: "provider_request_timed_out", timeoutMs: effectiveTimeout });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch an already cancelled check", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("check_cancelled");
    controller.abort(reason);

    await expect(tester().test({
      draft: draft("openai_responses_web_search"), signal: controller.signal, userId: "admin"
    })).rejects.toBe(reason);
    expect(search).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects success delivered after cancellation and clears the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("check_cancelled");
    search.mockImplementation(async () => {
      controller.abort(reason);
      return sourceResult();
    });

    await expect(tester().test({
      draft: draft("openai_responses_web_search"), signal: controller.signal, userId: "admin"
    })).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects success delivered after the deadline and clears its timer", async () => {
    vi.useFakeTimers();
    runtime(5_000);
    search.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_001));
      return sourceResult();
    });
    const execution = tester().test({
      draft: draft("openai_responses_web_search"), userId: "admin"
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(await execution).toMatchObject({ code: "provider_request_timed_out", timeoutMs: 5_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("OpenRouter web search probe", () => {
    const webSearchDraft = { ...draft("openrouter_web_search"), openRouterWebSearch: { engine: "perplexity" as const, mode: null } };
    beforeEach(async () => {
      const base = await loadTechnicalProviderRole({} as never, {} as never);
      vi.mocked(loadTechnicalProviderRole).mockResolvedValue({ ...base,
        snapshot: { ...base.snapshot, providerFamily: "openrouter",
          model: { ...base.snapshot.model, upstreamModelId: "deepseek/deepseek-v4.1-flash" } } } as Awaited<ReturnType<typeof loadTechnicalProviderRole>>);
    });

    it("accepts a model that searched once with the verbatim query and found a result", async () => {
      search.mockResolvedValueOnce({ ...sourceResult(), searchQueries: ["OpenAI  official website"] });
      await expect(tester().test({ draft: webSearchDraft, userId: "admin" }))
        .resolves.toMatchObject({ normalizedSourceCount: 1, protocol: "openrouter_web_search", status: "available" });
      expect(search.mock.calls[0]![0].searchPolicy).toMatchObject({ engine: "perplexity", strategyId: "openrouter-web-search" });
    });

    it.each([
      { case: "an empty query", searchQueries: [""] },
      { case: "a rewritten query", searchQueries: ["OpenAI homepage URL"] },
      { case: "a rewritten query, then the verbatim one on the repeat", searchQueries: ["OpenAI homepage URL", "OpenAI official website"] },
      { case: "two searches", searchQueries: ["OpenAI official website", "OpenAI official website"] },
      { case: "no search", searchQueries: [] }
    ])("refuses a model that searched with $case, results or not", async ({ searchQueries }) => {
      search.mockResolvedValueOnce({ ...sourceResult(), searchQueries });
      await expect(tester().test({ draft: webSearchDraft, userId: "admin" })).resolves.toMatchObject({ status: "unavailable" });
    });
  });

  it("charges the acting administrator for each request the exact checked deployment answered", async () => {
    const recordUsage = vi.fn<ModelCheckUsageWriter>(async () => undefined);
    const accounted = () => createAdminSearchTester({} as PrismaClient, { recordUsage });
    const answered = (usage: ModelRunUsage, cost?: number) => ({ body: {}, ...(cost === undefined ? {} : { cost: () => cost }),
      execute: async () => ({ usage }), usage: (value: { usage: ModelRunUsage }) => value.usage });
    // Two answered requests (a paused turn and its continuation), then success.
    search.mockImplementationOnce(async (_request, options) => {
      await options!.dispatch!(answered({ inputTokens: 5, outputTokens: 3 }, 0.004));
      await options!.dispatch!(answered({ inputTokens: 2, outputTokens: 1 }));
      return sourceResult();
    });
    await accounted().test({ draft: draft("openai_responses_web_search"), userId: "admin-1" });
    expect(recordUsage.mock.calls.map(([record]) => record)).toEqual([
      { modelClass: "answer", modelId: "upstream-model", provider: "openai_compatible", providerModelId: "technical-model",
        reportedCostUsd: 0.004, usage: { inputTokens: 5, outputTokens: 3 }, userId: "admin-1" },
      expect.objectContaining({ reportedCostUsd: null, usage: { inputTokens: 2, outputTokens: 1 }, userId: "admin-1" })
    ]);

    // A refused answer was still billed; a transport failure answered nothing.
    recordUsage.mockClear();
    search.mockImplementationOnce(async (_request, options) => {
      await options!.dispatch!(answered({ inputTokens: 4, outputTokens: 1 }));
      throw new ProviderSearchExecutionError({ artifacts: [], code: "openai_search_sources_invalid",
        usage: { inputTokens: 4, outputTokens: 1 } });
    });
    await expect(accounted().test({ draft: draft("openai_responses_web_search"), userId: "admin-1" }))
      .rejects.toMatchObject({ code: "openai_search_sources_invalid" });
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: { inputTokens: 4, outputTokens: 1 } }));
    recordUsage.mockClear();
    search.mockImplementationOnce(async (_request, options) => options!.dispatch!({ body: {},
      execute: async () => { throw Object.assign(new Error("provider_http_error"), { httpStatus: 503 }); },
      usage: () => ({ inputTokens: 1 }) }));
    await expect(accounted().test({ draft: draft("openai_responses_web_search"), userId: "admin-1" })).rejects.toThrow();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

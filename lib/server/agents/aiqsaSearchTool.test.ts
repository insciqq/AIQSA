import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { NormalizedSearchPlan, NormalizedSearchPlanOption, ProviderSearchAdapter } from "../providers/types";
import { createAgentAiqsaSearch } from "./aiqsaSearchTool";

const usage = { inputTokens: 11, outputTokens: 3, totalTokens: 14 };
const option = (id: string): NormalizedSearchPlanOption => ({
  adapterKind: "provider_model_client", credentialMode: "provider_model", config: { maxSearchCallsPerAnswer: 2 },
  displayName: id, executionModes: ["all_selected", "model_choice"], modelId: "search-model", optionId: id,
  protocol: "openai_responses_web_search", provider: "openai", providerModelId: "search-model-row",
  revisionId: `revision-${id}`, searchStrategyRowId: `strategy-${id}`
});
function fixture(mode: NormalizedSearchPlan["mode"] = "all_selected") {
  const requests: unknown[] = [];
  const store = { assertActive: vi.fn(async () => {}), reserveProvider: vi.fn(async () => "00000000-0000-4000-8000-000000000001" as const),
    settleProvider: vi.fn(async () => {}), failure: vi.fn(async () => null) };
  const search: ProviderSearchAdapter["search"] = async (request, options) => {
    requests.push(request);
    await options!.dispatch!({ body: { query: request.query, model: "search-model" }, execute: async () => ({ usage }), usage: (value) => value.usage });
    return { findings: "Synthetic documentation result.", sources: [{ rank: 1, title: "Documentation", url: "https://example.com/docs" }], usage, artifacts: [], finalProviderResponsePreview: {}, requestPreview: {} };
  };
  const resolve = vi.fn(async () => ({ responseTimeoutMs: 300000,
    searchAdapter: { search, buildRequestPreview: () => ({}) } }) as unknown as ProviderRuntimeBinding);
  const assertAllowed = vi.fn(async (_option: NormalizedSearchPlanOption) => {});
  const onUsage = vi.fn(async () => {});
  const plan = { mode, options: [option("first"), option("second")] };
  return { requests, store, resolve, assertAllowed, onUsage, plan,
    tool: createAgentAiqsaSearch({ plan, store, resolve, assertAllowed, onUsage })! };
}
describe("built-in Agent AIQSA Search", () => {
  it("fans out a query-only request and binds every physical call to its own source", async () => {
    const f = fixture();
    const result = await f.tool.execute({ query: "official docs" }, "call", new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain("https://example.com/docs");
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(Object.keys(request as object).sort()).toEqual(["correlationId", "query", "searchPolicy", "strategyId"]);
    }
    for (const id of ["first", "second"]) expect(f.store.reserveProvider).toHaveBeenCalledWith(expect.any(Number), {
      kind: "aiqsa_search", optionId: id, invocationId: "call", maxCalls: 2
    });
    expect(f.store.settleProvider).toHaveBeenCalledTimes(2);
    expect(f.onUsage).toHaveBeenCalledTimes(2);
  });
  it("offers only admitted aliases and selects exactly one source in model choice", async () => {
    const f = fixture("model_choice");
    expect(f.tool.schema.properties.source?.enum).toEqual(["source_1", "source_2"]);
    await f.tool.execute({ query: "docs", source: "source_2" }, "call", new AbortController().signal);
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.resolve).toHaveBeenCalledWith(f.plan.options[1]);
    await expect(f.tool.execute({ query: "docs", source: "foreign" }, "call2", new AbortController().signal)).rejects.toThrow("search_tool_not_selected");
    expect(f.resolve).toHaveBeenCalledOnce();
  });
  it("keeps partial evidence when one source is revoked without dispatching it", async () => {
    const f = fixture();
    f.assertAllowed.mockImplementation(async (selected) => { if (selected.optionId === "first") throw new Error("revoked"); });
    const result = await f.tool.execute({ query: "docs" }, "call", new AbortController().signal);
    expect(JSON.stringify(result)).toContain("https://example.com/docs");
    expect(f.requests).toHaveLength(1);
  });
  it("exposes nothing when Search is off and stops dispatch after cancellation", async () => {
    const f = fixture();
    expect(createAgentAiqsaSearch({ ...f, plan: { mode: "all_selected", options: [] } })).toBeNull();
    const controller = new AbortController(); controller.abort();
    await expect(f.tool.execute({ query: "docs" }, "call", controller.signal)).rejects.toThrow("search_cancelled");
    expect(f.store.reserveProvider).not.toHaveBeenCalled();
  });
});

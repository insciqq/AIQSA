import { describe, expect, it } from "vitest";
import {
  automaticSearchOptionId,
  decodeSearchPlan,
  hostedSearchProtocolUsable,
  mergeSearchEvidence,
  resolveSearchEngine,
  searchEngineDefaultRank,
  searchPlanEnabled,
  searchSettingPlan,
  WEB_SEARCH_OPTION_ID
} from "./search";

describe("search plans", () => {
  it("rejects an omitted plan instead of inventing Off", () => {
    expect(decodeSearchPlan(undefined)).toEqual({
      code: "search_plan_invalid",
      ok: false
    });
  });

  it("keeps order while rejecting duplicate, malformed, and oversized plans", () => {
    expect(decodeSearchPlan({ mode: "model_choice", optionIds: ["b", "a"] })).toEqual({
      ok: true,
      plan: { mode: "model_choice", optionIds: ["b", "a"] }
    });
    expect(decodeSearchPlan({ mode: "all_selected", optionIds: ["a", "a"] })).toMatchObject({
      code: "search_plan_duplicate_option",
      ok: false
    });
    expect(decodeSearchPlan({ mode: "all_selected", optionIds: ["a", "b", "c", "d"] })).toMatchObject({
      code: "search_plan_too_many_options",
      ok: false
    });
    expect(decodeSearchPlan({ mode: "automatic", optionIds: [] })).toMatchObject({
      code: "search_plan_invalid",
      ok: false
    });
  });
});

describe("fan-out evidence", () => {
  it("keeps every source beyond the former merged-list ceiling", () => {
    const sources = Array.from({ length: 50 }, (_, index) => ({
      rank: index + 1, title: `Source ${index + 1}`, url: `https://example.test/source/${index + 1}`
    }));
    const merged = mergeSearchEvidence(["engine"], [{ invocationId: "call", optionId: "engine", sources }]);
    expect(merged).toHaveLength(50);
    expect(merged.at(-1)).toMatchObject({ title: "Source 50", url: sources[49]!.url });
  });

  it("uses plan/local order, drops unsafe URLs, and deduplicates with attribution", () => {
    expect(mergeSearchEvidence(["second", "first"], [
      {
        invocationId: "inv-1",
        optionId: "first",
        sources: [
          { rank: 1, title: "Shared later", url: "https://example.test/shared#fragment" },
          { rank: 2, title: "Unsafe", url: "data:text/html,bad" }
        ]
      },
      {
        invocationId: "inv-2",
        optionId: "second",
        sources: [
          { rank: 1, title: "Second-only", url: "https://example.test/two" },
          { rank: 2, title: "Shared first", url: "https://example.test/shared" }
        ]
      }
    ])).toEqual([
      {
        engines: [{ optionId: "second", rank: 1 }],
        title: "Second-only",
        url: "https://example.test/two"
      },
      {
        engines: [
          { optionId: "second", rank: 2 },
          { optionId: "first", rank: 1 }
        ],
        title: "Shared first",
        url: "https://example.test/shared"
      }
    ]);
  });
});

describe("automatic Search source", () => {
  it("follows the default engine order and never defaults to Parallel, Exa or Sonar", () => {
    const sources = [
      { protocols: ["anthropic_web_search"], strategyId: "anthropic" },
      { protocols: ["gemini_google_search"], strategyId: "gemini" },
      { protocols: ["openrouter_perplexity_chat"], strategyId: "sonar" },
      { protocols: ["deepseek_search_api"], strategyId: "deepseek-api" },
      { openRouterEngine: "parallel", protocols: ["openrouter_web_search"], strategyId: "parallel" }
    ];
    expect(automaticSearchOptionId(sources)).toBe("deepseek-api");
    expect(automaticSearchOptionId([...sources, { protocols: ["openrouter_web_search"], strategyId: "openrouter" }]))
      .toBe("openrouter");
    expect(automaticSearchOptionId([...sources, { protocols: ["openai_responses_web_search"], strategyId: "openai" }]))
      .toBe("openai");
    expect(automaticSearchOptionId(sources.slice(0, 3))).toBe("gemini");
    expect(automaticSearchOptionId(sources.slice(0, 1))).toBe("anthropic");
    expect(automaticSearchOptionId([sources[2]!, sources[4]!])).toBeNull();
    expect(automaticSearchOptionId([{ protocols: [], strategyId: "hosted-only" }])).toBeNull();
    expect(automaticSearchOptionId([])).toBeNull();
  });

  it("runs only OpenAI hosted Search inside a tool-calling answer", () => {
    expect(hostedSearchProtocolUsable("openai_responses_web_search")).toBe(true);
    for (const protocol of ["anthropic_web_search", "gemini_google_search"]) {
      expect(hostedSearchProtocolUsable(protocol)).toBe(false);
    }
  });
});

describe("the installation's Search engine", () => {
  const candidate = (optionId: string, protocol: string, input: Readonly<{ openRouterEngine?: string; ready?: boolean }> = {}) =>
    ({ openRouterEngine: input.openRouterEngine ?? null, optionId, protocol, ready: input.ready ?? true });
  const everyEngine = [
    candidate("anthropic", "anthropic_web_search"),
    candidate("gemini", "gemini_google_search"),
    candidate("deepseek", "deepseek_search_api"),
    candidate("parallel", "openrouter_web_search", { openRouterEngine: "parallel" }),
    candidate("perplexity", "openrouter_web_search", { openRouterEngine: "perplexity" }),
    candidate("openai", "openai_responses_web_search")
  ];

  it("picks the first ready engine in the default order when the administrator chose none", () => {
    const pick = (candidates: typeof everyEngine) =>
      resolveSearchEngine({ backupOptionId: null, candidates, engineOptionId: null }).engine?.optionId ?? null;
    expect(pick(everyEngine)).toBe("openai");
    expect(pick(everyEngine.filter((entry) => entry.optionId !== "openai"))).toBe("perplexity");
    expect(pick(everyEngine.slice(0, 4))).toBe("deepseek");
    expect(pick(everyEngine.slice(0, 2))).toBe("gemini");
    expect(pick(everyEngine.slice(0, 1))).toBe("anthropic");
    expect(pick([everyEngine[5]!, { ...everyEngine[5]!, optionId: "openai-later" }])).toBe("openai");
    expect(pick(everyEngine.map((entry) => entry.optionId === "openai" ? { ...entry, ready: false } : entry))).toBe("perplexity");
    expect(resolveSearchEngine({ backupOptionId: null, candidates: [everyEngine[3]!], engineOptionId: null }))
      .toEqual({ automatic: true, backup: null, engine: null, reason: "search_engine_not_configured" });
    expect(searchEngineDefaultRank({ openRouterEngine: "exa", protocol: "openrouter_web_search" })).toBeNull();
    expect(searchEngineDefaultRank({ protocol: "openrouter_perplexity_chat" })).toBeNull();
  });

  it("searches with the administrator's engine, Parallel included, and never replaces one that cannot search", () => {
    expect(resolveSearchEngine({ backupOptionId: null, candidates: everyEngine, engineOptionId: "parallel" }))
      .toMatchObject({ automatic: false, engine: { optionId: "parallel" }, reason: null });
    const broken = everyEngine.map((entry) => entry.optionId === "gemini" ? { ...entry, ready: false } : entry);
    expect(resolveSearchEngine({ backupOptionId: "deepseek", candidates: broken, engineOptionId: "gemini" }))
      .toEqual({ automatic: false, backup: null, engine: null, reason: "search_engine_unavailable" });
    expect(resolveSearchEngine({ backupOptionId: null, candidates: everyEngine, engineOptionId: "removed" }))
      .toMatchObject({ engine: null, reason: "search_engine_unavailable" });
  });

  it("keeps a ready backup beside the engine, never the engine itself or an unready one", () => {
    expect(resolveSearchEngine({ backupOptionId: "deepseek", candidates: everyEngine, engineOptionId: null }))
      .toMatchObject({ backup: { optionId: "deepseek" }, engine: { optionId: "openai" } });
    expect(resolveSearchEngine({ backupOptionId: "openai", candidates: everyEngine, engineOptionId: null }).backup).toBeNull();
    const unready = everyEngine.map((entry) => entry.optionId === "deepseek" ? { ...entry, ready: false } : entry);
    expect(resolveSearchEngine({ backupOptionId: "deepseek", candidates: unready, engineOptionId: "gemini" }).backup).toBeNull();
  });

  it("reads plans as on or off", () => {
    expect(searchPlanEnabled({ optionIds: ["any-source"] })).toBe(true);
    expect(searchPlanEnabled({ optionIds: [] })).toBe(false);
    expect(searchSettingPlan(true)).toEqual({ mode: "all_selected", optionIds: [WEB_SEARCH_OPTION_ID] });
    expect(searchSettingPlan(false)).toEqual({ mode: "all_selected", optionIds: [] });
  });
});

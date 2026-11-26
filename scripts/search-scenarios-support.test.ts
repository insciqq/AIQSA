import { describe, expect, it } from "vitest";
import {
  ENGINE_STEPS, OPENROUTER_ALLOWED_SEARCH_MODELS, codexLbApiRoot, decodeAdminSearch, decodeSearchEvidence, engineSourceFor, evidenceLine,
  expectedDefaultEngine, oracleClientEngine, oracleInAnswer, oracleResearch, oracleSubagent, selectedEngineSteps, selectedSearchScenarios,
  type SearchRunEvidence
} from "./search-scenarios-support";

const integration = (overrides: Record<string, unknown>) => ({
  archivedAt: null, enabled: true, executionModes: ["all_selected", "model_choice"], id: "row", kind: "web_search",
  sourceConnectionId: "connection", strategyId: "option", configuration: { adapterKind: "provider_model_client", protocol: "openai_responses_web_search",
    providerModelId: "model" }, ...overrides
});

const catalog = (integrations: unknown[], policy: Record<string, unknown> = {}) => ({ search: { integrations, policy: {
  backupOptionId: null, engineOptionId: null, inAnswerSearch: true, version: 4,
  resolved: { automatic: true, backupOptionId: null, engineOptionId: "openai", reason: null }, ...policy
} } });

const openai = integration({ id: "openai-row", strategyId: "openai" });
const perplexity = integration({ id: "or-row", strategyId: "perplexity", configuration: { adapterKind: "provider_model_client",
  openRouterWebSearch: { engine: "perplexity", mode: null }, protocol: "openrouter_web_search", providerModelId: "or-model" } });
const deepseek = integration({ id: "ds-row", kind: "deepseek_search_api", strategyId: "deepseek",
  configuration: { adapterKind: "provider_model_client", protocol: "deepseek_search_api", providerModelId: "ds-model" } });
const gemini = integration({ id: "gm-row", kind: "gemini_google_search", strategyId: "gemini", enabled: false, executionModes: [],
  configuration: { adapterKind: "provider_model_client", protocol: "gemini_google_search", providerModelId: "gm-model" } });

function evidence(overrides: Partial<SearchRunEvidence> = {}): SearchRunEvidence {
  return {
    answerLink: true, errorCode: null, executions: [], hostedSourceItems: 0, mainCalls: 0, options: [], planMode: "engine", planUnavailable: null,
    researchStarts: 0, runSeconds: 12.5, status: "complete", subagentCalls: 0, subagentThreads: 0, subagentTurns: 0, subagentTurnsOnModel: 0,
    ...overrides
  };
}

const hostedOption = { adapterKind: "answer_provider_hosted", openRouterEngine: null, optionId: "openai", protocol: "openai_responses_web_search", use: "in_answer" };
const engineOption = { adapterKind: "provider_model_client", openRouterEngine: null, optionId: "deepseek", protocol: "deepseek_search_api", use: "engine" };

describe("selection", () => {
  it("runs A to D by default, E only when named, always in catalog order", () => {
    expect(selectedSearchScenarios(undefined)).toEqual(["A", "B", "C", "D"]);
    expect(selectedSearchScenarios("E, B")).toEqual(["B", "E"]);
    expect(() => selectedSearchScenarios("F")).toThrow("search_select_invalid");
    expect(() => selectedSearchScenarios("A,A")).toThrow("search_select_invalid");
  });

  it("selects C's engine steps", () => {
    expect(selectedEngineSteps(undefined).map((step) => step.label)).toEqual(ENGINE_STEPS.map((step) => step.label));
    expect(selectedEngineSteps("gemini,automatic").map((step) => step.label)).toEqual(["automatic", "gemini"]);
    expect(() => selectedEngineSteps("exa")).toThrow("search_c_engines_invalid");
  });

  it("takes the codex-lb root without /v1 and serves the Responses root", () => {
    expect(codexLbApiRoot("https://lb.example.com/")).toBe("https://lb.example.com/v1");
    expect(() => codexLbApiRoot(undefined)).toThrow("codex_lb_root_required");
    expect(() => codexLbApiRoot("https://lb.example.com/v1")).toThrow("codex_lb_root_invalid");
    expect(() => codexLbApiRoot("http://lb.example.com")).toThrow("codex_lb_root_invalid");
  });

  it("lets OpenRouter search only with DeepSeek V4.1 Flash", () => {
    expect(OPENROUTER_ALLOWED_SEARCH_MODELS.length).toBeGreaterThan(0);
    expect(OPENROUTER_ALLOWED_SEARCH_MODELS.every((id) => id.startsWith("deepseek/deepseek-v4.1-flash"))).toBe(true);
  });
});

describe("Admin Search catalog", () => {
  it("decodes the policy, the resolution and each source's engine readiness", () => {
    const decoded = decodeAdminSearch(catalog([openai, perplexity, gemini]));
    expect(decoded?.policy).toEqual({ backupOptionId: null, engineOptionId: null, inAnswerSearch: true, version: 4,
      resolved: { automatic: true, backupOptionId: null, engineOptionId: "openai", reason: null } });
    expect(decoded?.integrations.map((entry) => [entry.optionId, entry.engineReady, entry.openRouterEngine]))
      .toEqual([["openai", true, null], ["perplexity", true, "perplexity"], ["gemini", false, null]]);
    expect(decodeAdminSearch({ search: { integrations: [], policy: { version: 1 } } })).toBeNull();
  });

  it("finds each step's source, or says why there is none", () => {
    const integrations = decodeAdminSearch(catalog([openai, perplexity, deepseek, gemini]))!.integrations;
    const step = (label: string) => ENGINE_STEPS.find((entry) => entry.label === label)!;
    expect(engineSourceFor(step("openrouter_perplexity"), integrations)).toMatchObject({ integration: { optionId: "perplexity" }, status: "ready" });
    expect(engineSourceFor(step("deepseek"), integrations)).toMatchObject({ integration: { optionId: "deepseek" }, status: "ready" });
    expect(engineSourceFor(step("gemini"), integrations)).toEqual({ reason: "source_disabled", status: "not_configured" });
    expect(engineSourceFor(step("openrouter_perplexity"), decodeAdminSearch(catalog([openai]))!.integrations))
      .toEqual({ reason: "source_missing", status: "not_configured" });
    const parallel = integration({ strategyId: "parallel", configuration: { adapterKind: "provider_model_client",
      openRouterWebSearch: { engine: "parallel", mode: "fast" }, protocol: "openrouter_web_search" } });
    expect(engineSourceFor(step("openrouter_perplexity"), decodeAdminSearch(catalog([parallel]))!.integrations).status).toBe("not_configured");
  });

  it("expects the default order's first ready engine", () => {
    expect(expectedDefaultEngine(decodeAdminSearch(catalog([deepseek, perplexity, openai]))!.integrations)).toBe("openai_client");
    expect(expectedDefaultEngine(decodeAdminSearch(catalog([deepseek, perplexity]))!.integrations)).toBe("openrouter_perplexity");
    expect(expectedDefaultEngine(decodeAdminSearch(catalog([gemini]))!.integrations)).toBeNull();
  });
});

describe("oracles", () => {
  it("A holds when the answer searched inside itself and called no web_search", () => {
    expect(oracleInAnswer(evidence({ hostedSourceItems: 1, options: [hostedOption, { ...engineOption, optionId: "openai", protocol: "openai_responses_web_search" }] })))
      .toEqual([]);
    expect(oracleInAnswer(evidence({ answerLink: false, mainCalls: 1, options: [] })))
      .toEqual(["in_answer_not_bound", "web_search_called", "hosted_sources_missing", "answer_link_missing"]);
  });

  it("B and C need a search through the resolved engine with a source", () => {
    const executions = [{ failureCode: null, optionId: "deepseek", sources: 10, status: "complete", subagent: false }];
    const found = evidence({ executions, mainCalls: 1, options: [engineOption] });
    expect(oracleClientEngine(found, { engineOptionId: "deepseek", label: "deepseek" })).toEqual([]);
    expect(oracleClientEngine(found, { engineOptionId: "gemini", label: "gemini" })).toEqual(["engine_not_as_resolved", "engine_kind_mismatch"]);
    const empty = evidence({ executions: [{ failureCode: "search_provider_rejected", optionId: "deepseek", sources: 0, status: "error", subagent: false }],
      mainCalls: 1, options: [engineOption] });
    expect(oracleClientEngine(empty, { engineOptionId: "deepseek", label: null })).toEqual(["engine_search_missing"]);
    expect(evidenceLine(empty)).toMatchObject({ engine: "deepseek", failureCode: "search_provider_rejected", mainEngineSearches: 0 });
    expect(oracleClientEngine(evidence({ planUnavailable: "search_not_granted", status: "error" }), { engineOptionId: null, label: null }))
      .toEqual(["run_error", "engine_missing_search_not_granted", "engine_search_missing"]);
  });

  it("D needs the sub-agent's own web_search while the parent searches inside its answer", () => {
    const executions = [{ failureCode: null, optionId: "deepseek", sources: 3, status: "complete", subagent: true }];
    const found = evidence({ executions, options: [hostedOption, engineOption], subagentCalls: 1, subagentThreads: 1, subagentTurns: 1, subagentTurnsOnModel: 1 });
    expect(oracleSubagent(found)).toEqual([]);
    expect(oracleSubagent({ ...found, mainCalls: 1, subagentTurnsOnModel: 0 })).toEqual(["parent_web_search_offered", "subagent_model_mismatch"]);
    expect(oracleSubagent(evidence({ options: [hostedOption, engineOption] }))).toEqual(["subagent_missing", "subagent_search_missing"]);
  });

  it("E needs a started research whose researchers searched through the engine", () => {
    const executions = [{ failureCode: null, optionId: "deepseek", sources: 5, status: "complete", subagent: true }];
    expect(oracleResearch(evidence({ executions, options: [engineOption], researchStarts: 1, subagentThreads: 3 }))).toEqual([]);
    expect(oracleResearch(evidence({ options: [engineOption] }))).toEqual(["research_not_started", "researchers_missing", "researcher_search_missing"]);
  });
});

describe("evidence rows", () => {
  it("decodes the query's row and refuses another shape", () => {
    const decoded = decodeSearchEvidence({ answerLink: true, errorCode: null, executions: [{ failureCode: null, optionId: "x", sources: 2, status: "complete", subagent: false }],
      hostedSourceItems: 0, mainCalls: 1, options: [{ adapterKind: "provider_model_client", openRouterEngine: null, optionId: "x", protocol: "deepseek_search_api", use: "engine" }],
      planMode: "engine", planUnavailable: null, researchStarts: 0, runSeconds: 3.2, status: "complete", subagentCalls: 0, subagentThreads: 0, subagentTurns: 0,
      subagentTurnsOnModel: 0 });
    expect(decoded?.executions[0]?.sources).toBe(2);
    expect(decoded?.options[0]?.use).toBe("engine");
    expect(decodeSearchEvidence({ status: "complete" })).toBeNull();
  });
});

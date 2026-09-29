import { describe, expect, it } from "vitest";
import { projectSearchEngineActivity } from "./activityProjection";
import { unknownSearchEngineCalls } from "../../contracts/searchActivity";

const plan = {
  mode: "all_selected",
  options: [
    { adapterKind: "provider_model_client", displayName: "Perplexity", optionId: "perplexity" },
    { adapterKind: "provider_model_client", displayName: "OpenAI (CodexLB)", optionId: "openai" }
  ]
};

describe("projectSearchEngineActivity", () => {
  it("counts each engine in one all-selected call, then independent repeated outcomes", () => {
    const activity = projectSearchEngineActivity({ normalizedRequest: { searchPlan: plan },
      toolCalls: [
        { state: "complete", toolName: "search_selected_engines" },
        { state: "complete", toolName: "search_selected_engines" }
      ],
      searchRuns: [
        { invocationId: "call-1:perplexity", status: "complete", strategyId: "perplexity" },
        { invocationId: "call-1:openai", status: "complete", strategyId: "openai" },
        { invocationId: "call-2:perplexity", status: "complete", strategyId: "perplexity" },
        { invocationId: "call-2:openai", status: "error", strategyId: "openai" }
      ] });
    expect(activity).toEqual([
      { engine: 1, name: "Perplexity", requested: 2, settled: 2, complete: 2, error: 0, skipped: 0 },
      { engine: 2, name: "OpenAI (CodexLB)", requested: 2, settled: 2, complete: 1, error: 1, skipped: 0 }
    ]);
  });

  it("keeps settled calls without an accounting row uncertain until evidence arrives", () => {
    const input = { normalizedRequest: { searchPlan: plan },
      toolCalls: [{ state: "complete", toolName: "search_selected_engines" }],
      searchRuns: [] as { invocationId: string; strategyId: string; status: string }[] };
    const awaiting = projectSearchEngineActivity(input);
    expect(awaiting.map(unknownSearchEngineCalls)).toEqual([1, 1]);
    expect(awaiting.every(row => row.skipped === 0 && row.complete === 0)).toBe(true);
    const settled = projectSearchEngineActivity({ ...input, searchRuns: [
      { invocationId: "call:perplexity", strategyId: "perplexity", status: "complete" },
      { invocationId: "call:perplexity", strategyId: "perplexity", status: "complete" },
      { invocationId: "call:openai", strategyId: "openai", status: "error" }
    ] });
    expect(settled.map(row => [row.complete, row.error, unknownSearchEngineCalls(row)])).toEqual([[1, 0, 0], [0, 1, 0]]);
  });

  it("reuses a proven skip snapshot after reload without inventing legacy skips", () => {
    const activity = projectSearchEngineActivity({ normalizedRequest: { searchPlan: plan },
      toolCalls: [{ state: "error", toolName: "search_selected_engines" }], searchRuns: [],
      snapshots: [{ engine: 1, name: "Perplexity", requested: 1, settled: 1, complete: 0, error: 0, skipped: 1 },
        { engine: 2, name: "OpenAI (CodexLB)", requested: 1, settled: 1, complete: 0, error: 0, skipped: 1 }] });
    expect(activity.every(row => row.skipped === 1 && unknownSearchEngineCalls(row) === 0)).toBe(true);
  });

  it("does not leave a terminal pending call labelled as running", () => {
    const activity = projectSearchEngineActivity({ normalizedRequest: { searchPlan: plan },
      runStatus: "cancelled", toolCalls: [{ state: "pending", toolName: "search_selected_engines" }],
      searchRuns: [] });
    expect(activity.map(unknownSearchEngineCalls)).toEqual([1, 1]);
    expect(activity.every(row => row.settled === row.requested && row.complete === 0)).toBe(true);
  });

  it("keeps pending, unsuccessful and rejected work separate from successful counts", () => {
    const activity = projectSearchEngineActivity({ normalizedRequest: { searchPlan: plan },
      toolCalls: [
        { state: "complete", toolName: "search_selected_engines" },
        { state: "error", toolName: "search_selected_engines" },
        { state: "running", toolName: "search_selected_engines" }
      ],
      searchRuns: [
        { invocationId: "call-1:perplexity", status: "complete", strategyId: "perplexity" },
        { invocationId: "call-1:openai", status: "error", strategyId: "openai" }
      ] });
    expect(activity).toEqual([
      { engine: 1, name: "Perplexity", requested: 3, settled: 2, complete: 1, error: 0, skipped: 0 },
      { engine: 2, name: "OpenAI (CodexLB)", requested: 3, settled: 2, complete: 0, error: 1, skipped: 0 }
    ]);
  });

  it("uses accepted option order and ignores hosted or unsupported historical rows", () => {
    const activity = projectSearchEngineActivity({ normalizedRequest: { searchPlan: {
      mode: "model_choice", options: [
        { adapterKind: "answer_provider_hosted", displayName: "Hosted", optionId: "hosted" },
        ...plan.options
      ]
    } }, toolCalls: [{ state: "complete", toolName: "search_engine_2" }], searchRuns: [
      { invocationId: "call-2:openai", status: "complete", strategyId: "openai" },
      { invocationId: null, status: "complete", strategyId: "perplexity" },
      { invocationId: "hosted", status: "complete", strategyId: "hosted" }
    ] });
    expect(activity).toEqual([
      { engine: 2, name: "OpenAI (CodexLB)", requested: 1, settled: 1, complete: 1, error: 0, skipped: 0 }
    ]);
  });
});

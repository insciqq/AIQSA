import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import { resolveAcceptedRunReasoningEffort } from "../../../domain/runParams";
import { parameterControlsForModel } from "../../../domain/catalog";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderRunRequest } from "../../providers/types";
import { modelEffortOptions, paramsWithReasoningEffort, parentSubagentRoute } from "./modelRoutes";

const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), stream: vi.fn() as never };
const snapshot = { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1",
  model: { adapterKind: "openai_responses_compatible", capabilities: {}, defaultParams: {}, upstreamModelId: "gpt-6-sol" },
  providerFamily: "openai", providerModelId: "pm-sol" } as unknown as ProviderExecutionSnapshot;
const request = { modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
  reasoningEfforts: ["low", "medium", "high"], toolCalling: true }, modelId: "gpt-6-sol", params: { reasoning: { effort: "high" } },
  provider: "openai", reasoningEffort: "high" } as unknown as ProviderRunRequest;
const modelConfiguration = { adapterKind: "openai_responses_compatible" as const, capabilities: request.modelCapabilities,
  defaultParams: {} };

describe("sub-agent model routes", () => {
  it("writes an effort in each dialect the accepted-effort reader reads back", () => {
    for (const [dialect, adapterKind] of [["openai", "openai_responses_compatible"], ["anthropic", "anthropic_messages"],
      ["openrouter", "openrouter_chat_completions"]] as const) {
      const controls = parameterControlsForModel({ adapterKind, modelCapabilities: { reasoning: true, reasoningEfforts: ["low", "high"] },
        modelId: "m", provider: dialect });
      const params = paramsWithReasoningEffort(dialect, { reasoning: { effort: "high" } }, "low");
      expect(resolveAcceptedRunReasoningEffort({ controls, params, provider: dialect })).toEqual({ ok: true, reasoningEffort: "low" });
    }
  });

  it("reads a model's effort options from its parameter controls, as its route checks them", () => {
    expect(modelEffortOptions({ adapterKind: "openai_responses_compatible", capabilities: request.modelCapabilities, defaultParams: {},
      providerFamily: "openai", upstreamModelId: "gpt-6-sol" })).toEqual(expect.arrayContaining(["low", "medium", "high"]));
  });

  it("runs the parent's own route with the parent's params, or with an effort its model offers", () => {
    const same = parentSubagentRoute({ adapter, effort: "high", modelConfiguration, request, snapshot, timeoutMs: 1_000 });
    expect(same).toMatchObject({ ok: true, route: { adapter, request: { modelId: "gpt-6-sol", params: { reasoning: { effort: "high" } },
      reasoningEffort: "high" }, snapshot } });
    const lower = parentSubagentRoute({ adapter, effort: "low", modelConfiguration, request, snapshot, timeoutMs: 1_000 });
    expect(lower).toMatchObject({ ok: true, route: { request: { params: { reasoning: { effort: "low" } }, reasoningEffort: "low" } } });
    expect(parentSubagentRoute({ adapter, effort: "max", modelConfiguration, request, snapshot, timeoutMs: 1_000 }))
      .toEqual({ code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false });
  });
});

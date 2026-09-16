import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { describe, expect, it, vi } from "vitest";
import { agentLimits } from "./config";
import { admittedAgentSearchRequest, createAgentSearchGateway } from "./searchGateway";
import type { AgentResponsesTransport } from "../providers/agentResponses";

const body = { id: "00000000-0000-4000-8000-000000000001", model: "fixture-model", input: [],
  commands: { search_query: [{ q: "official documentation" }], response_length: "short" },
  settings: { allowed_callers: ["direct"], external_web_access: true }, max_output_tokens: 10000 };
const result = { encrypted_output: "opaque-continuation", output: "Source [1]", results: [{ url: "https://example.com/", ref_id: "s1" }] };
function fixture(response = Response.json(result), admitted = true) {
  const store = { assertActive: vi.fn(async () => {}), reserveProvider: vi.fn(async () => "00000000-0000-4000-8000-000000000002" as const), settleProvider: vi.fn(async () => {}) };
  const transport = { snapshot: { connection: { responseTimeoutMs: 300000 }, model: { upstreamModelId: "fixture-model", adapterKind: "openai_responses_compatible",
    capabilities: { codexStandaloneWebSearch: admitted } } }, search: vi.fn(async () => response) } as unknown as AgentResponsesTransport;
  const onFailure = vi.fn(async () => {}), onUsage = vi.fn(async () => {});
  const handle = createAgentSearchGateway({ store, transport, onFailure, onUsage, signal: new AbortController().signal,
    configuration: { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true, maxOutputTokens: 2048 }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }), compatibilityHash: "a".repeat(64), mcpMode: "off" } });
  return { store, transport, onFailure, onUsage, handle: (value = body) => handle(new Request("http://agent.invalid/v1/alpha/search", { method: "POST", body: JSON.stringify(value) })) };
}

describe("native Codex standalone search", () => {
  it("preserves native continuation, bounds output and records missing accounting as unknown", async () => {
    const f = fixture();
    expect(await (await f.handle()).json()).toEqual(result);
    expect(f.transport.search).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: 2048, model: "fixture-model" }), expect.any(AbortSignal));
    expect(f.store.reserveProvider).toHaveBeenCalledWith(expect.any(Number), { kind: "native_search" });
    expect(f.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "COMPLETE", expect.objectContaining({ completeness: "unavailable", totalTokens: null }));
    expect(f.onUsage).toHaveBeenCalledOnce();
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("uses only trusted provider usage when present", async () => {
    const f = fixture(Response.json({ ...result, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }));
    expect((await f.handle()).status).toBe(200);
    expect(f.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "COMPLETE", expect.objectContaining({ totalTokens: 7 }));
  });
  it("does not dispatch without the exact capability, live grant or remaining budget", async () => {
    for (const condition of ["unverified", "revoked", "budget"] as const) {
      const f = fixture(Response.json(result), condition !== "unverified");
      if (condition === "revoked") f.store.assertActive.mockRejectedValue(new Error("revoked"));
      if (condition === "budget") f.store.reserveProvider.mockRejectedValue(new Error("budget"));
      expect((await f.handle()).status).toBe(502);
      expect(f.transport.search).not.toHaveBeenCalled();
      expect(f.store.settleProvider).not.toHaveBeenCalled();
    }
  });
  it("cannot select a model, new destination, unrelated command or unbounded batch", () => {
    for (const patch of [{ model: "foreign" }, { endpoint: "https://foreign.invalid" }, { max_output_tokens: -1 },
      { commands: { exec: [{ command: "id" }] } }, { commands: { search_query: Array.from({ length: 33 }, () => ({ q: "q" })) } }]) {
      expect(() => admittedAgentSearchRequest({ ...body, ...patch }, "fixture-model", 2048)).toThrow("agent_search_request_invalid");
    }
  });
  it("settles an ambiguous failed operation without leaking upstream error bodies", async () => {
    const f = fixture(Response.json({ private: "upstream private diagnostic" }, { status: 503 }));
    expect(JSON.stringify(await (await f.handle()).json())).not.toContain("upstream private");
    expect(f.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "UNKNOWN", null);
    expect(f.onFailure).toHaveBeenCalledOnce();
  });
});

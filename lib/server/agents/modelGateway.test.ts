import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { describe, expect, it, vi } from "vitest";
import type { AgentResponsesTransport } from "../providers/agentResponses";
import { agentLimits } from "./config";
import { admittedAgentRequest, createAgentModelGateway } from "./modelGateway";
import { ProviderSafeFetchError } from "../providers/providerSafeFetch";
import { AgentExecutionError } from "./failures";
import { observedFailure } from "../providers/providerObservability";

const configuration = { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
  compatibilityHash: "a".repeat(64), mcpMode: "auto" as const };
const body = { model: "fixture-model", stream: true, input: [{ role: "user", content: "Synthetic task" }],
  tools: [{ type: "function", name: "shell", parameters: { type: "object" } }] };
const request = () => new Request("http://agent.invalid/v1/responses", { method: "POST", body: JSON.stringify(body) });
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });

function fixture(response: Response, nativeSearch = false) {
  const store = { assertActive: vi.fn(async () => {}), reserveProvider: vi.fn(async () => "00000000-0000-4000-8000-000000000001" as const),
    settleProvider: vi.fn(async () => {}) };
  const transport = { snapshot: { connection: { responseTimeoutMs: 300000 }, model: { upstreamModelId: "fixture-model", adapterKind: "openai_responses_compatible", capabilities: { nativeSearch } } },
    request: vi.fn(async () => response) } as unknown as AgentResponsesTransport;
  const onFailure = vi.fn(async () => {});
  return { store, transport, onFailure, handle: createAgentModelGateway({ configuration, store, transport,
    signal: new AbortController().signal, onFailure, onUsage: async () => {} }) };
}

describe("Agent model gateway", () => {
  it.each([
    new ProviderSafeFetchError("provider_http_dns_failed"),
    new TypeError("PRIVATE_ENDPOINT", { cause: Object.assign(new Error("PRIVATE_DNS_ERROR"), { code: "ENOTFOUND" }) })
  ])("exposes a safe DNS cause without replaying the provider call", async (error) => {
    const f = fixture(sse());
    vi.mocked(f.transport.request).mockRejectedValue(error);
    const response = await f.handle(request());
    const payload = await response.json();
    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("agent_provider_dns_failed");
    expect(payload.error.message).toContain("DNS");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
    expect(f.transport.request).toHaveBeenCalledOnce();
    expect(f.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "UNKNOWN", null);
    expect(f.onFailure).toHaveBeenCalledWith("agent_provider_dns_failed");
    expect(observedFailure(new AgentExecutionError(payload.error.code))).toEqual({
      code: "agent_provider_dns_failed", reason: "network"
    });
  });

  it("does not classify an arbitrary provider error message as DNS", async () => {
    const f = fixture(sse());
    vi.mocked(f.transport.request).mockRejectedValue(new Error("ENOTFOUND PRIVATE_ENDPOINT"));
    const payload = await (await f.handle(request())).json();
    expect(payload.error.code).toBe("agent_provider_failed");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
  });
  it.each(["agent_model_call_limit", "agent_token_limit", "agent_time_limit"])("preserves %s without dispatching or replacing it with a provider error", async (code) => {
    const f = fixture(sse());
    f.store.reserveProvider.mockRejectedValue(new Error(code));
    expect(await (await f.handle(request())).json()).toMatchObject({ error: { code } });
    expect(f.onFailure).toHaveBeenCalledWith(code);
    expect(f.transport.request).not.toHaveBeenCalled();
  });
  it.each(["max_output_tokens", "content_filter"])("classifies provider incomplete reason %s and retains reported usage", async (reason) => {
    const f = fixture(sse({ type: "response.incomplete", response: {
      incomplete_details: { reason }, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    } }));
    const response = await f.handle(request());
    await expect(response.text()).rejects.toThrow();
    expect(f.onFailure).toHaveBeenCalledWith(reason === "max_output_tokens" ? "agent_generation_output_limit" : "agent_provider_failed");
    expect(f.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "ERROR", expect.objectContaining({ totalTokens: 12 }));
  });
  it("leaves native call limits unset in Off while still reserving and accounting generation", async () => {
    const f = fixture(sse({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), true);
    const transport = { ...f.transport, snapshot: { ...f.transport.snapshot, model: { ...f.transport.snapshot.model, adapterKind: "openai_responses_native" as const } } } as AgentResponsesTransport;
    const handle = createAgentModelGateway({ configuration: { ...configuration, limitsEnabled: false, timeoutSeconds: null, maxOutputTokens: 24000 },
      store: f.store, transport, onFailure: f.onFailure, onUsage: async () => {}, signal: new AbortController().signal });
    await (await handle(request())).text();
    const sent = vi.mocked(f.transport.request).mock.calls[0]![0];
    expect(sent).not.toHaveProperty("max_tool_calls");
    expect(sent.max_output_tokens).toBe(24000);
    expect(f.store.reserveProvider).toHaveBeenCalledOnce();
    expect(f.store.settleProvider).toHaveBeenCalledOnce();
  });
  it("admits the frozen model and local tools, and owns storage and output limits", () => {
    expect(admittedAgentRequest({ ...body, store: true, max_output_tokens: 1000000 }, "fixture-model", 2048))
      .toMatchObject({ model: "fixture-model", store: false, max_output_tokens: 2048 });
    for (const patch of [
      { model: "another-model" }, { previous_response_id: "foreign" }, { background: true },
      { tools: [{ type: "web_search" }] }, { tools: [{ type: "mcp", server_url: "http://private.invalid" }] },
      { input: [{ role: "user", content: [{ type: "input_image", image_url: "http://private.invalid/image" }] }] },
      { input: [{ type: "function_call_output", call_id: "call", output: [{ type: "input_file", file_id: "foreign" }] }] }
    ]) expect(() => admittedAgentRequest({ ...body, ...patch }, "fixture-model", 2048)).toThrow();
  });

  it("persists trusted terminal usage before exposing the completion", async () => {
    const f = fixture(sse({ type: "response.output_text.delta", delta: "done" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }));
    const response = await f.handle(request());
    expect(await response.text()).toContain("response.completed");
    expect(f.store.reserveProvider).toHaveBeenCalledOnce();
    expect(f.store.settleProvider).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", "COMPLETE", expect.objectContaining({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }));
    expect(f.onFailure).not.toHaveBeenCalled();
  });

  it("admits native search and its continuation without accepting unrelated hosted tools", () => {
    const search = { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] };
    const history = { type: "web_search_call", id: "ws_fixture", status: "completed",
      action: { type: "search", queries: ["synthetic query"], sources: [{ type: "url", url: "https://example.com/" }] } };
    const value = { ...body, tools: [...body.tools, search], input: [...body.input, history], max_tool_calls: 1000000 };
    expect(admittedAgentRequest(value, "fixture-model", 2048, true)).toMatchObject({
      tools: value.tools, input: value.input
    });
    for (const action of ["open_page", "find_in_page"]) {
      const input = [{ ...history, action: { type: action, url: "https://example.com/" } }];
      expect(admittedAgentRequest({ ...value, input }, "fixture-model", 2048, true).input).toEqual(input);
    }
    expect(admittedAgentRequest(value, "fixture-model", 2048, true)).not.toHaveProperty("max_tool_calls");
    expect(() => admittedAgentRequest(value, "fixture-model", 2048)).toThrow();
    for (const tool of [
      { type: "mcp", server_url: "http://private.invalid" }, { type: "file_search", vector_store_ids: ["foreign"] },
      { type: "web_search", server_url: "http://private.invalid" },
      { type: "web_search", search_content_types: ["file"] },
      { type: "namespace", name: "hosted", tools: [search] }
    ]) expect(() => admittedAgentRequest({ ...value, tools: [tool] }, "fixture-model", 2048, true)).toThrow();
    expect(() => admittedAgentRequest({ ...value, input: [{ ...history, action: { type: "mcp" } }] }, "fixture-model", 2048, true)).toThrow();
  });

  it("takes native search authority from the frozen provider and preserves its stream and token receipt", async () => {
    const event = { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_fixture",
      status: "completed", action: { type: "search", query: "synthetic query" } } };
    const terminal = { type: "response.completed", response: { output: [event.item],
      usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } };
    const value = { ...body, nativeWebSearch: true, tools: [{ type: "web_search" }] };
    const searchRequest = () => new Request("http://agent.invalid/v1/responses", { method: "POST", body: JSON.stringify(value) });
    const denied = fixture(sse(terminal));
    expect((await denied.handle(searchRequest())).status).toBe(502);
    expect(denied.transport.request).not.toHaveBeenCalled();
    const enabled = fixture(sse(event, terminal), true);
    const response = await enabled.handle(searchRequest());
    const text = await response.text();
    expect(text).toContain('"type":"web_search_call"');
    expect(text).toContain("response.completed");
    expect(enabled.transport.request).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ type: "web_search" }] }), expect.any(AbortSignal));
    expect(enabled.store.settleProvider).toHaveBeenCalledWith(expect.any(String), "COMPLETE", expect.objectContaining({ totalTokens: 23 }));
  });

  it("accepts Codex additional local tools without admitting hosted tools inside namespaces", () => {
    const namespace = { type: "namespace", name: "functions", tools: [
      { type: "custom", name: "exec", format: { type: "text" } },
      { type: "function", name: "wait", parameters: { type: "object" } }
    ] };
    const input = [{ type: "additional_tools", role: "developer", tools: [namespace] }, ...body.input];
    expect(admittedAgentRequest({ ...body, input }, "fixture-model", 2048)).toMatchObject({ input });
    for (const type of ["web_search", "mcp", "computer", "file_search"]) {
      const tools = [{ ...namespace, tools: [{ type, name: "hosted" }] }];
      expect(() => admittedAgentRequest({ ...body, tools }, "fixture-model", 2048)).toThrow("agent_model_tools_invalid");
      expect(() => admittedAgentRequest({ ...body, input: [{ type: "additional_tools", tools }] }, "fixture-model", 2048))
        .toThrow("agent_model_tools_invalid");
    }
    expect(() => admittedAgentRequest({ ...body, input: [{ type: "additional_tools", tools: Array(256).fill(namespace) }] }, "fixture-model", 2048))
      .toThrow("agent_model_tools_invalid");
  });

  it("records an unknown physical outcome when the provider stream has no terminal", async () => {
    const f = fixture(sse({ type: "response.output_text.delta", delta: "partial" }));
    const response = await f.handle(request());
    await expect(response.text()).rejects.toThrow("agent_provider_failed");
    expect(f.store.settleProvider).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", "UNKNOWN", null);
    expect(f.onFailure).toHaveBeenCalledOnce();
  });

  it("does not revoke the turn when Codex closes a response after its terminal receipt", async () => {
    const f = fixture(sse({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }));
    const response = await f.handle(request());
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed");
    await reader.cancel();
    expect(f.store.settleProvider).toHaveBeenCalledOnce();
    expect(f.onFailure).not.toHaveBeenCalled();
  });

  it("preserves reasoning-model continuation across a native tool step", () => {
    const input = [...body.input,
      { type: "reasoning", id: "rs_fixture", content: [{ type: "reasoning_text", text: "Synthetic provider reasoning" }], summary: [] },
      { type: "function_call", call_id: "call_fixture", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fixture", output: "Synthetic result" }
    ];
    expect(admittedAgentRequest({ ...body, input }, "fixture-model", 2048)).toMatchObject({ input });
    for (const content of [
      [{ type: "input_file", file_id: "foreign" }],
      [{ type: "input_image", image_url: "https://private.invalid/image" }],
      [{ type: "reasoning_text", text: "Synthetic", file_id: "foreign" }]
    ]) expect(() => admittedAgentRequest({ ...body, input: [{ type: "reasoning", content }] }, "fixture-model", 2048)).toThrow();
  });

  it("cannot dispatch after authority is revoked, and does not leak upstream errors", async () => {
    const f = fixture(new Response("synthetic-private-diagnostic", { status: 403 }));
    const response = await f.handle(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic-private-diagnostic");
    f.store.assertActive.mockRejectedValue(new Error("expired"));
    await f.handle(request());
    expect(f.transport.request).toHaveBeenCalledOnce();
  });
});

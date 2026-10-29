import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigurationError } from "../../lib/server/providers/providerConfiguration";
import { createProviderRuntimeBinding, normalizeProviderExecutionSnapshot } from "../../lib/server/providers/runtimeFactory";
import { decodeMcpGuardVerdict, mcpGuardRequest } from "../../lib/server/mcp/guardPrompt";
import { createMcpGuardEvalSnapshot, mcpGuardEvalFailure } from "./mcp-write-guard";
import { MCP_GUARD_EVAL_CASES } from "./mcp-write-guard-cases";

const environment = {
  MCP_GUARD_EVAL_PAID: "1",
  MCP_GUARD_EVAL_ENDPOINT: "https://provider.example.test/v1",
  MCP_GUARD_EVAL_API_KEY: "synthetic-key",
  MCP_GUARD_EVAL_MODEL: "gpt-6-luna",
  MCP_GUARD_EVAL_EFFORT: "low"
};

afterEach(() => vi.unstubAllGlobals());

describe("MCP guard eval runtime", () => {
  it.each(["openai_responses_compatible", "openrouter_chat_completions"] as const)(
    "normalizes the documented reasoning configuration and executes the real guard schema with a fake fetch (%s)", async adapter => {
      const network = vi.fn(() => { throw new Error("test_network_forbidden"); });
      vi.stubGlobal("fetch", network);
      const snapshot = createMcpGuardEvalSnapshot({ ...environment, MCP_GUARD_EVAL_ADAPTER: adapter });
      expect(normalizeProviderExecutionSnapshot(snapshot)).toEqual(snapshot);
      expect(snapshot.model.capabilities).toMatchObject({ structuredOutput: true, reasoning: true,
        defaultReasoningEffort: "low", reasoningEfforts: ["low"] });
      const verdict = { decision: "allow", reason: "The user requested this change." };
      const fetchFn = vi.fn<typeof fetch>(async () => Response.json(adapter === "openai_responses_compatible"
        ? { id: "synthetic-response", status: "completed", output: [{ type: "message", role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }
        : { id: "synthetic-response", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(verdict) } }] }));
      const runtime = createProviderRuntimeBinding({ snapshot, secret: async () => environment.MCP_GUARD_EVAL_API_KEY,
        options: { allowFake: false, disableRequestRetries: true, fetchFn } });
      expect(runtime.structuredOutputAdapter).toBeDefined();
      expect(fetchFn).not.toHaveBeenCalled();
      const test = MCP_GUARD_EVAL_CASES[0]!;
      const request = mcpGuardRequest(test.messages, test.tool, snapshot.model.capabilities.defaultReasoningEffort ?? null);
      expect(request).not.toBeNull();
      const result = await runtime.structuredOutputAdapter!.execute(request!);
      expect(decodeMcpGuardVerdict(result)).toEqual(verdict);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchFn.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model: environment.MCP_GUARD_EVAL_MODEL, reasoning: { effort: "low" } });
      expect(adapter === "openai_responses_compatible" ? body.text.format : body.response_format.json_schema)
        .toMatchObject({ name: request!.name, strict: true, schema: request!.schema });
      expect(network).not.toHaveBeenCalled();
    });

  it.each(["openai_responses_compatible", "openrouter_chat_completions"] as const)(
    "also accepts an omitted effort without declaring reasoning controls (%s)", adapter => {
      const snapshot = createMcpGuardEvalSnapshot({ ...environment, MCP_GUARD_EVAL_ADAPTER: adapter, MCP_GUARD_EVAL_EFFORT: undefined });
      expect(snapshot.model.capabilities).toMatchObject({ structuredOutput: true, reasoning: false });
      expect(snapshot.model.capabilities.defaultReasoningEffort).toBeUndefined();
      expect(snapshot.model.capabilities.reasoningEfforts).toBeUndefined();
    });

  it("retains the paid opt-in and rejects invalid capability configuration before dispatch", () => {
    expect(() => createMcpGuardEvalSnapshot({ ...environment, MCP_GUARD_EVAL_ADAPTER: "openai_responses_compatible",
      MCP_GUARD_EVAL_PAID: undefined })).toThrow("eval_configuration_required");
    expect(() => createMcpGuardEvalSnapshot({ ...environment, MCP_GUARD_EVAL_ADAPTER: "openai_responses_compatible",
      MCP_GUARD_EVAL_EFFORT: "" })).toThrow("provider_model_capabilities_invalid");
  });
});

describe("MCP guard eval content-free failures", () => {
  it("reports known configuration codes from code or the exact stable message", () => {
    const configuration = new ProviderConfigurationError("provider_model_capabilities_invalid");
    configuration.message = "PRIVATE_PAYLOAD https://private.example.test/v1 PRIVATE_KEY";
    expect(mcpGuardEvalFailure(configuration)).toEqual({ name: "ProviderConfigurationError", code: "provider_model_capabilities_invalid" });
    expect(mcpGuardEvalFailure(new Error("provider_execution_snapshot_invalid")))
      .toEqual({ name: "Error", code: "provider_execution_snapshot_invalid" });
    expect(mcpGuardEvalFailure(new Error("eval_configuration_required")))
      .toEqual({ name: "Error", code: "eval_configuration_required" });
  });

  it("never reports arbitrary names, codes, messages, payloads, endpoints, credentials or stacks", () => {
    const privateValue = "PRIVATE_PAYLOAD https://private.example.test/v1 PRIVATE_KEY";
    for (const error of [
      Object.assign(new Error(privateValue), { code: privateValue, name: privateValue, payload: privateValue }),
      new Error(`provider_model_capabilities_invalid ${privateValue}`),
      new Error(privateValue, { cause: new ProviderConfigurationError("provider_api_root_invalid") })
    ]) expect(mcpGuardEvalFailure(error)).toEqual({ name: "Error", code: "eval_failed" });
    expect(mcpGuardEvalFailure(new TypeError(privateValue))).toEqual({ name: "TypeError", code: "eval_failed" });
    expect(mcpGuardEvalFailure(privateValue)).toEqual({ name: "UnknownError", code: "eval_failed" });
    expect(mcpGuardEvalFailure({ name: privateValue, message: privateValue, code: privateValue }))
      .toEqual({ name: "UnknownError", code: "eval_failed" });
  });
});

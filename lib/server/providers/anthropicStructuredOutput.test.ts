import { describe, expect, it, vi } from "vitest";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import { createFetchAnthropicMessagesClient } from "./anthropicMessages";
import {
  buildAnthropicMessagesStructuredOutputRequest,
  createAnthropicMessagesStructuredOutputAdapter,
  STRUCTURED_OUTPUT_LIMITS
} from "./structuredOutput";
import { hasVerifiedStructuredOutput, structuredOutputVerificationEvidence } from "./structuredOutputEvidence";

const model: ProviderModelConfiguration = {
  adapterKind: "anthropic_messages", answerSelectable: true, modelClass: "answer", upstreamModelId: "claude-test",
  capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, vision: false,
    reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
  defaultParams: { thinking: { type: "adaptive", enabled: true }, temperature: 0.4 }
};
const schema = {
  type: "object", additionalProperties: false, required: ["count", "label", "ids"], properties: {
    count: { type: "integer", minimum: 2, maximum: 3 },
    label: { type: "string", minLength: 1, maxLength: 8, pattern: "^ok" },
    ids: { type: "array", items: { type: "string", enum: ["alpha", "beta"] }, minItems: 2, maxItems: 2, uniqueItems: true }
  }
};
const value = { count: 2, label: "ok", ids: ["alpha", "beta"] };
const request = { name: "strict_result", schema, maxOutputTokens: 128,
  systemPrompt: "Return the requested JSON object.", userPrompt: "Set count=2, label=ok, ids=[alpha,beta]." };
const completed = (text = JSON.stringify(value)) => ({
  type: "message", role: "assistant", id: "msg-test-1", stop_reason: "end_turn",
  content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 6,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens_details: { thinking_tokens: 4 } }
});
function adapterFor(response: Record<string, unknown>) {
  const client = { createMessage: vi.fn(async () => response) };
  return { client, adapter: createAnthropicMessagesStructuredOutputAdapter({ client, model }) };
}

describe("native Anthropic structured output", () => {
  it("sends native JSON Schema with admitted effort, tokens and existing thinking controls", () => {
    const body = buildAnthropicMessagesStructuredOutputRequest(model, { ...request, reasoningEffort: "low" });
    expect(body).toMatchObject({ max_tokens: 128, model: "claude-test", stream: false,
      system: request.systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: request.userPrompt }] }],
      thinking: { type: "adaptive" }, output_config: { effort: "low", format: { type: "json_schema",
        schema: { type: "object", additionalProperties: false, required: schema.required, properties: {
          count: { type: "integer" }, ids: { type: "array", items: schema.properties.ids.items }
        } } } }
    });
    const wire = (body.output_config as { format: { schema: typeof schema } }).format.schema;
    expect(wire.properties.count).not.toHaveProperty("minimum");
    expect(wire.properties.label).not.toHaveProperty("pattern");
    expect(wire.properties.ids).not.toHaveProperty("maxItems");
    expect(wire.properties.ids).not.toHaveProperty("minItems");
    expect(wire.properties.count).toHaveProperty("description", expect.stringContaining('"minimum":2'));
    expect(schema.properties.count.minimum).toBe(2);
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(buildAnthropicMessagesStructuredOutputRequest(model, { ...request, reasoningEffort: "none" }))
      .toMatchObject({ temperature: 0.4, output_config: { format: { type: "json_schema" } } });
    expect(buildAnthropicMessagesStructuredOutputRequest(model, { ...request, reasoningEffort: "none" }).thinking).toBeUndefined();
  });

  it("preserves enabled thinking budgets and rejects a budget that cannot fit", () => {
    const configured = { ...model, defaultParams: { thinking: { enabled: true, type: "enabled", budgetTokens: 1024 } } };
    expect(buildAnthropicMessagesStructuredOutputRequest(configured, { ...request, maxOutputTokens: 2048 }))
      .toMatchObject({ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(() => buildAnthropicMessagesStructuredOutputRequest(configured, request))
      .toThrow("anthropic_thinking_budget_must_be_less_than_max_tokens");
    expect(() => buildAnthropicMessagesStructuredOutputRequest(model, { ...request, reasoningEffort: "medium" }))
      .toThrow("structured_output_request_invalid");
  });

  it("uses the bounded authenticated Messages transport and reports actual accounting", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ...completed(), content: [
      { type: "thinking", thinking: "private thinking", signature: "private signature" }, ...completed().content
    ] }));
    const adapter = createAnthropicMessagesStructuredOutputAdapter({ model, client: createFetchAnthropicMessagesClient({
      apiKey: "synthetic-key", baseUrl: "https://anthropic.example.test/v1", fetchFn
    }) });
    const onUsage = vi.fn();
    const onProviderResponseId = vi.fn();
    await expect(adapter.execute(request, { onUsage, onProviderResponseId, signal: controller.signal, timeoutMs: 4000 }))
      .resolves.toEqual(value);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]).toEqual(["https://anthropic.example.test/v1/messages", expect.objectContaining({ method: "POST",
      headers: { "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": "synthetic-key" },
      signal: expect.any(AbortSignal)
    })]);
    expect(onProviderResponseId).toHaveBeenCalledWith("msg-test-1");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 15, outputTokens: 6,
      reasoningTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 2, totalTokens: 21 }));
  });

  it.each([
    { ...value, count: 1 }, { ...value, count: 4 }, { ...value, label: "wrong" }, { ...value, label: "ok-too-long" },
    { ...value, ids: ["alpha", "alpha"] }, { ...value, ids: ["alpha"] }, { ...value, privateField: "reject" },
    { ...value, count: "2" }, { count: 2 }
  ])("enforces the unmodified schema after projection (%#)", async (invalid) => {
    const { adapter } = adapterFor(completed(JSON.stringify(invalid)));
    await expect(adapter.execute(request)).rejects.toThrow("structured_output_invalid");
  });

  it.each([
    { ...completed(), stop_reason: "max_tokens" }, { ...completed(), stop_reason: "refusal" },
    { ...completed(), stop_reason: "pause_turn" }, { ...completed(), stop_reason: null },
    { ...completed(), stop_reason: "tool_use" }, { ...completed(), role: "user" },
    completed("[]"), completed('{"count":'), completed("x".repeat(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters + 1)),
    { ...completed(), content: [...completed().content, ...completed().content] },
    { ...completed(), content: [{ type: "tool_use", input: value }] },
    { ...completed(), content: [{ type: "thinking", thinking: JSON.stringify(value) }] },
    { ...completed(), content: [{ type: "text", text: JSON.stringify(value), citations: [{}] }] }
  ])("rejects incomplete, refused, ambiguous or malformed output while retaining usage (%#)", async (response) => {
    const { adapter } = adapterFor(response);
    const onUsage = vi.fn();
    await expect(adapter.execute(request, { onUsage })).rejects.toThrow();
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("classifies refusals and output exhaustion as inconclusive capability checks", async () => {
    await expect(adapterFor({ ...completed(), stop_reason: "refusal" }).adapter.execute(request))
      .rejects.toMatchObject({ capabilityFailureReason: "refusal" });
    await expect(adapterFor({ ...completed(), stop_reason: "max_tokens" }).adapter.execute(request))
      .rejects.toMatchObject({ capabilityFailureReason: "budget_exhausted" });
  });

  it("unwraps exclusive union contracts and retains discriminator validation", async () => {
    const union = { oneOf: ["ok", "missing"].map((kind) => ({ type: "object", additionalProperties: false,
      properties: { kind: { type: "string", const: kind } }, required: ["kind"] })) };
    await expect(adapterFor(completed('{"__aiqsa_payload":{"kind":"ok"}}')).adapter.execute({ ...request, schema: union }))
      .resolves.toEqual({ kind: "ok" });
    await expect(adapterFor(completed('{"__aiqsa_payload":{"kind":"unknown"}}')).adapter.execute({ ...request, schema: union }))
      .rejects.toThrow("structured_output_invalid");
  });

  it.each([
    { type: "object", additionalProperties: true }, { $ref: "https://private.example.test/schema" },
    { oneOf: [{ type: "string" }, { type: "string" }] }
  ])("rejects unsupported schemas before external I/O (%#)", async (invalidSchema) => {
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute({ ...request, schema: invalidSchema })).rejects.toThrow("structured_output_schema_unsupported");
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it("fences cancellation both before dispatch and before publishing a delayed response", async () => {
    const controller = new AbortController();
    const client = { createMessage: vi.fn(async () => { controller.abort(); return completed(); }) };
    const adapter = createAnthropicMessagesStructuredOutputAdapter({ client, model });
    await expect(adapter.execute(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.execute(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.createMessage).toHaveBeenCalledOnce();
  });

  it("binds successful proof to the exact adapter, model and probe version", () => {
    const evidence = { structuredOutput: structuredOutputVerificationEvidence(model.adapterKind, model.upstreamModelId) };
    expect(hasVerifiedStructuredOutput(evidence, model)).toBe(true);
    expect(hasVerifiedStructuredOutput(evidence, { ...model, upstreamModelId: "different" })).toBe(false);
    expect(hasVerifiedStructuredOutput({ structuredOutput: { ...evidence.structuredOutput, probeVersion: 1 } }, model)).toBe(false);
  });
});

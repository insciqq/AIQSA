import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3 } from "../knowledge/answerGroundingV5";
import { KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2 } from "../knowledge/evidenceAnswerReviewV2";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import type { GeminiInteractionsClient } from "./geminiInteractionsTransport";
import {
  buildGeminiInteractionsStructuredOutputRequest,
  createGeminiInteractionsStructuredOutputAdapter,
  STRUCTURED_OUTPUT_LIMITS
} from "./structuredOutput";
import { hasVerifiedStructuredOutput, structuredOutputVerificationEvidence } from "./structuredOutputEvidence";

const model: ProviderModelConfiguration = {
  adapterKind: "gemini_interactions_native",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
    defaultReasoningEffort: "low", reasoningEfforts: ["low", "high"], vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "gemini-structured-test"
};
const schema = {
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"], type: "object"
};
const request = {
  maxOutputTokens: 64, name: "bounded_result", schema,
  systemPrompt: "Return the requested JSON object.", userPrompt: "Set ok to true."
};
const usage = {
  total_cached_tokens: 3, total_input_tokens: 10,
  total_output_tokens: 5, total_thought_tokens: 7, total_tokens: 22
};
const textStep = (text: string) => ({ content: [{ text, type: "text" }], type: "model_output" });
const completed = (text = '{"ok":true}') => ({
  id: "interaction-test-1", status: "completed", steps: [textStep(text)], usage
});
function adapterFor(response: Record<string, unknown>) {
  const client: GeminiInteractionsClient = {
    createInteraction: vi.fn(async () => response), streamInteraction: vi.fn()
  };
  return { client, adapter: createGeminiInteractionsStructuredOutputAdapter({ client, model }) };
}

describe("native Gemini structured output", () => {
  it.each([8_192, 32_768, 65_536])("sends the explicit %s token allowance without widening the JSON size limit", async (maxOutputTokens) => {
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute({ ...request, maxOutputTokens })).resolves.toEqual({ ok: true });
    expect(client.createInteraction).toHaveBeenCalledWith(expect.objectContaining({
      generation_config: expect.objectContaining({ max_output_tokens: maxOutputTokens })
    }), undefined);
    expect(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters).toBe(65_536);
  });

  it("sends the exact admitted token cap and native stateless JSON request", () => {
    expect(buildGeminiInteractionsStructuredOutputRequest(model, request)).toEqual({
      generation_config: { max_output_tokens: 64, thinking_level: "low", thinking_summaries: "none" },
      input: [{ content: [{ text: request.userPrompt, type: "text" }], type: "user_input" }],
      model: model.upstreamModelId,
      response_format: { mime_type: "application/json", schema, type: "text" },
      store: false, stream: false, system_instruction: request.systemPrompt
    });
    const configured = { ...model, defaultParams: { maxOutputTokens: 8_192, reasoning: { effort: "high" }, tools: [{}] } };
    expect(buildGeminiInteractionsStructuredOutputRequest(configured, { ...request, reasoningEffort: "low" }))
      .toMatchObject({ generation_config: { max_output_tokens: 64, thinking_level: "low" } });
    expect(buildGeminiInteractionsStructuredOutputRequest(configured, request))
      .toMatchObject({ generation_config: { max_output_tokens: 64, thinking_level: "high" } });
  });

  it.each(["minimal", "low", "medium", "high"])("uses the supported %s thinking level", (effort) => {
    expect(buildGeminiInteractionsStructuredOutputRequest({
      ...model, capabilities: { ...model.capabilities, defaultReasoningEffort: effort, reasoningEfforts: [effort] }
    }, { ...request, reasoningEffort: effort })).toMatchObject({
      generation_config: { max_output_tokens: 64, thinking_level: effort }
    });
  });

  it.each(["none", "minimal", "medium", "unknown"])("rejects unadmitted reasoning effort %s without a substitution", (effort) => {
    expect(() => buildGeminiInteractionsStructuredOutputRequest(model, { ...request, reasoningEffort: effort }))
      .toThrow("structured_output_request_invalid");
  });

  it("omits a disabled reasoning control for a nonreasoning model", () => {
    const nonreasoning = { ...model, capabilities: {
      ...model.capabilities, reasoning: false, defaultReasoningEffort: undefined, reasoningEfforts: undefined
    } };
    expect(buildGeminiInteractionsStructuredOutputRequest(nonreasoning, { ...request, reasoningEffort: "none" }))
      .toMatchObject({ generation_config: { max_output_tokens: 64, thinking_summaries: "none" } });
    expect(buildGeminiInteractionsStructuredOutputRequest(nonreasoning, request).generation_config)
      .not.toHaveProperty("thinking_level");
    expect(() => buildGeminiInteractionsStructuredOutputRequest(nonreasoning, { ...request, reasoningEffort: "low" }))
      .toThrow("structured_output_request_invalid");
  });

  it.each([0, 15, STRUCTURED_OUTPUT_LIMITS.maxOutputTokens + 1, 1.5, NaN])("rejects invalid output cap %s before dispatch", async (maxOutputTokens) => {
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute({ ...request, maxOutputTokens })).rejects.toThrow("structured_output_request_invalid");
    expect(client.createInteraction).not.toHaveBeenCalled();
  });

  it("bounds prompts and schemas before dispatch", async () => {
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute({ ...request, userPrompt: "x".repeat(STRUCTURED_OUTPUT_LIMITS.maxPromptCharacters + 1) }))
      .rejects.toThrow("structured_output_request_invalid");
    await expect(adapter.execute({ ...request, schema: { description: "x".repeat(STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes) } }))
      .rejects.toThrow("structured_output_request_invalid");
    expect(client.createInteraction).not.toHaveBeenCalled();
  });

  it("preserves nested required properties, nullability, enums, numeric and array constraints", () => {
    const nested = {
      additionalProperties: { type: "string" },
      properties: {
        note: { type: ["string", "null"], minLength: 1, maxLength: 50, pattern: "^[a-z]+$" },
        state: { const: "ready", enum: ["ready", "other"], type: "string" },
        count: { maximum: 10, minimum: 1, type: "integer" },
        rows: {
          items: {
            additionalProperties: false,
            properties: { version: { const: 2, type: "integer" }, names: { items: { enum: ["a", "b"], type: "string" }, type: "array", uniqueItems: true } },
            required: ["version", "names"], type: "object"
          }, minItems: 1, maxItems: 3, type: "array"
        }
      }, required: ["note", "state", "count", "rows"], type: "object"
    };
    const original = JSON.stringify(nested);
    const wire = buildGeminiInteractionsStructuredOutputRequest(model, { ...request, schema: nested });
    expect(wire.response_format).toMatchObject({ schema: {
      additionalProperties: { type: "string" }, required: ["note", "state", "count", "rows"],
      properties: {
        note: { type: ["string", "null"] }, state: { type: "string", enum: ["ready"] },
        count: { maximum: 10, minimum: 1, type: "integer" },
        rows: { minItems: 1, maxItems: 3, items: { additionalProperties: false, required: ["version", "names"],
          properties: { version: { type: "integer", enum: [2] }, names: { items: { enum: ["a", "b"], type: "string" }, type: "array" } } }
        }
      }
    } });
    expect(JSON.stringify(nested)).toBe(original);
    for (const keyword of ["const", "minLength", "maxLength", "pattern", "uniqueItems"]) {
      expect(JSON.stringify(wire.response_format)).not.toContain(`"${keyword}"`);
    }
  });

  it("projects the existing Knowledge union and review schemas with canonical rules intact", () => {
    const union = buildGeminiInteractionsStructuredOutputRequest(model, { ...request, schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3 });
    const projected = union.response_format as { schema: { properties: { __aiqsa_payload: { anyOf: unknown[] } } } };
    expect(projected.schema.properties.__aiqsa_payload.anyOf).toHaveLength(KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V3.oneOf.length);
    expect(JSON.stringify(projected)).not.toContain('"oneOf"');
    expect(JSON.stringify(projected)).not.toContain('"const"');
    const review = buildGeminiInteractionsStructuredOutputRequest(model, { ...request, schema: KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2 });
    expect(review.response_format).toMatchObject({ schema: {
      required: ["version", "blocks", "requirements", "analysisComplete", "followUps"],
      properties: { version: { type: "integer", enum: [2] }, requirements: { items: {
        required: ["requirement", "status", "blockIds", "correctionEvidenceHandles", "gap"]
      } } }
    } });
    expect(KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2.properties.version.const).toBe(2);
    expect(KNOWLEDGE_EVIDENCE_ANSWER_REVIEW_SCHEMA_V2.properties.requirements.items.properties.requirement.minLength).toBe(1);
  });

  it("unwraps only the exact bounded object root of a discriminated union", async () => {
    const union = { oneOf: ["yes", "no"].map((kind) => ({
      additionalProperties: false, properties: { kind: { const: kind, type: "string" } }, required: ["kind"], type: "object"
    })) };
    const value = { kind: "yes" };
    const { adapter } = adapterFor(completed(JSON.stringify({ __aiqsa_payload: value })));
    await expect(adapter.execute({ ...request, schema: union })).resolves.toEqual(value);
    for (const malformed of [{ ...value }, { __aiqsa_payload: [] }, { __aiqsa_payload: value, extra: true }]) {
      await expect(adapterFor(completed(JSON.stringify(malformed))).adapter.execute({ ...request, schema: union }))
        .rejects.toThrow("structured_output_invalid");
    }
  });

  it.each([
    { oneOf: [{ type: "object" }, { type: "object" }] },
    { allOf: [{ type: "object" }] },
    { $ref: "#" },
    { properties: { nested: { not: { type: "string" } } } },
    { properties: { tag: { const: "a", enum: ["b"] } } },
    { properties: { value: { const: {} } } },
    { properties: { value: false } },
    { items: false }, { additionalProperties: 5 }, { anyOf: [] }
  ])("rejects unsupported or ambiguous schemas before network work (%#)", async (invalidSchema) => {
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute({ ...request, schema: invalidSchema })).rejects.toThrow("structured_output_schema_unsupported");
    expect(client.createInteraction).not.toHaveBeenCalled();
  });

  it("uses only the final model output and reports provider accounting exactly once", async () => {
    const response = { ...completed(), steps: [
      { signature: "PRIVATE_THOUGHT_SIGNATURE", summary: [{ text: '{"ok":false}', type: "text" }], type: "thought" },
      textStep("Earlier non-final text"),
      { type: "model_output", content: [{ text: '{"ok":', type: "text" }, { text: "true}", type: "text" }] }
    ] };
    const { adapter, client } = adapterFor(response);
    const onUsage = vi.fn();
    const onProviderResponseId = vi.fn();
    const options = { onUsage, onProviderResponseId, signal: new AbortController().signal, timeoutMs: 4_321 };
    await expect(adapter.execute(request, options)).resolves.toEqual({ ok: true });
    expect(client.createInteraction).toHaveBeenCalledExactlyOnceWith(buildGeminiInteractionsStructuredOutputRequest(model, request), options);
    expect(client.streamInteraction).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ cacheWriteInputTokens: 0, cachedInputTokens: 3, inputTokens: 10, outputTokens: 12, reasoningTokens: 7, totalTokens: 22 });
    expect(onProviderResponseId).toHaveBeenCalledExactlyOnceWith("interaction-test-1");
    expect(JSON.stringify([onUsage.mock.calls, onProviderResponseId.mock.calls])).not.toContain("PRIVATE_THOUGHT_SIGNATURE");
  });

  it.each(["", " ", "not json", "```json\n{}\n```", "null", "[]", "true", "1", '"text"', '{"ok":'])
    ("rejects invalid or non-object JSON (%#)", async (text) => {
      await expect(adapterFor(completed(text)).adapter.execute(request)).rejects.toThrow("structured_output_invalid");
    });

  it.each([undefined, "in_progress", "requires_action", "failed", "cancelled", "incomplete", "unknown"])
    ("requires completed native terminal proof (%s)", async (status) => {
      const onUsage = vi.fn();
      const onProviderResponseId = vi.fn();
      await expect(adapterFor({ ...completed(), status }).adapter.execute(request, { onUsage, onProviderResponseId }))
        .rejects.toThrow("structured_output_provider_incomplete");
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onProviderResponseId).toHaveBeenCalledOnce();
    });

  it("does not infer a Gemini token-limit reason from usage or another protocol's fields", async () => {
    await expect(adapterFor({ ...completed(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      usage: { ...usage, total_output_tokens: request.maxOutputTokens } }).adapter.execute(request))
      .rejects.toThrow("structured_output_provider_incomplete");
  });

  it.each([
    { steps: undefined, output_text: '{"ok":true}' },
    { steps: [] },
    { steps: [{ type: "thought", summary: [{ type: "text", text: '{"ok":true}' }] }] },
    { steps: [textStep('{"ok":true}'), { type: "thought" }] },
    { steps: [textStep('{"ok":true}'), { type: "function_call", arguments: { private: "TOOL_CANARY" } }] },
    { steps: [{ type: "function_result", result: '{"ok":true}' }, textStep('{"ok":true}')] },
    { steps: [{ type: "google_search_call" }, textStep('{"ok":true}')] },
    { steps: [{ type: "model_output", content: [{ type: "text", thought: true, text: '{"ok":true}' }] }] },
    { steps: [{ type: "model_output", content: [{ type: "function_call" }] }] },
    { steps: [{ type: "model_output", content: [{ type: "text", text: 5 }] }] }
  ])("rejects absent output, private thought and unexpected tool content (%#)", async (partial) => {
    await expect(adapterFor({ ...completed(), ...partial }).adapter.execute(request)).rejects.toThrow("structured_output_invalid");
  });

  it.each([
    { refusal: "REFUSAL_CANARY" }, { error: { message: "ERROR_CANARY" } }, { errors: [{ message: "ERROR_CANARY" }] },
    { steps: [{ type: "refusal", text: "REFUSAL_CANARY" }] },
    { steps: [{ type: "model_output", content: [{ type: "refusal", text: "REFUSAL_CANARY" }] }] }
  ])("preserves a safe failed check for refusal or upstream error (%#)", async (partial) => {
    await expect(adapterFor({ ...completed(), ...partial }).adapter.execute(request)).rejects.toMatchObject({
      code: "provider_response_not_retryable", message: "structured_output_provider_incomplete"
    });
  });

  it("rejects excessive combined output before JSON parsing while retaining usage", async () => {
    const onUsage = vi.fn();
    const response = { ...completed(), steps: [{ type: "model_output", content: [
      { type: "text", text: " ".repeat(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters) },
      { type: "text", text: '{"ok":true}' }
    ] }] };
    await expect(adapterFor(response).adapter.execute(request, { onUsage })).rejects.toMatchObject({ code: "provider_output_too_large" });
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, { total_input_tokens: "10" }, { total_output_tokens: -1 }])("does not manufacture usage or preserve an unbounded response id (%#)", async (missingUsage) => {
    const onUsage = vi.fn();
    const onProviderResponseId = vi.fn();
    await expect(adapterFor({ ...completed(), id: "x".repeat(257), usage: missingUsage }).adapter.execute(request, { onUsage, onProviderResponseId }))
      .resolves.toEqual({ ok: true });
    expect(onUsage).not.toHaveBeenCalled();
    expect(onProviderResponseId).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("honors cancellation before dispatch and after receiving a response", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, client } = adapterFor(completed());
    await expect(adapter.execute(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.createInteraction).not.toHaveBeenCalled();
    const late = new AbortController();
    const onUsage = vi.fn();
    const lateAdapter = createGeminiInteractionsStructuredOutputAdapter({ model, client: {
      async createInteraction() { late.abort(); return completed(); }, streamInteraction: vi.fn()
    } });
    await expect(lateAdapter.execute(request, { signal: late.signal, onUsage })).rejects.toMatchObject({ name: "AbortError" });
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("requires exact positive JSON evidence independently from ordinary tools or catalog flags", () => {
    expect(hasVerifiedStructuredOutput({ compatibility: { structuredOutput: "not_supported" } }, model)).toBe(false);
    expect(hasVerifiedStructuredOutput({ structuredOutput: true }, model)).toBe(false);
    const proof = structuredOutputVerificationEvidence(model.adapterKind, model.upstreamModelId);
    expect(hasVerifiedStructuredOutput({ structuredOutput: proof }, model)).toBe(true);
    expect(hasVerifiedStructuredOutput({ structuredOutput: proof }, { ...model, upstreamModelId: "other-model" })).toBe(false);
    expect(hasVerifiedStructuredOutput({ structuredOutput: { ...proof, probeVersion: 1 } }, model)).toBe(false);
  });
});

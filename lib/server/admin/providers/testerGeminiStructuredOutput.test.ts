import { describe, expect, it, vi } from "vitest";
import { modelChipsFromEvidence } from "../../../../components/admin/providers/models/modelChips";
import { fixtureCheck } from "../../../../components/admin/providers/providerFixtures";
import { hasVerifiedStructuredOutput } from "../../providers/structuredOutputEvidence";
import { STRUCTURED_OUTPUT_LIMITS } from "../../providers/structuredOutputLimits";
import { systemModelRoleEligible } from "../../providerRuntime/systemModelCapabilities";
import type { ProviderAdmissionRole } from "../../providerRuntime/admission";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";

const input: AdminProviderDraftTesterInput = {
  connection: { allowPrivateNetwork: false, apiRoot: "https://gemini.example.test/v1beta", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
  connectionDisplayName: "Gemini", connectionId: "connection-1", credentialId: "credential-1", credentialVersionIdentity: "version-1",
  mode: "tiny_generation", model: {
    adapterKind: "gemini_interactions_native", answerSelectable: true, modelClass: "answer", upstreamModelId: "gemini-json-test",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false },
    defaultParams: {}
  },
  modelDisplayName: "Gemini JSON", providerFamily: "gemini", providerModelId: "model-1", secret: "SYNTHETIC_KEY"
};
const probeValue = { ready: true, count: 2, label: "Ready", tool_ids: ["alpha", "beta"] };
function response(value: unknown = probeValue) {
  return { id: "synthetic-interaction", status: "completed", model: input.model.upstreamModelId,
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3, total_cached_tokens: 2, total_tokens: 18 } };
}
function fixture(structured: () => Response | Promise<Response> = () => Response.json(response())) {
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://gemini.example.test/v1beta/interactions");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("SYNTHETIC_KEY");
    const body = JSON.parse(String(init?.body));
    if (body.response_format) return structured();
    if (body.stream) {
      const events = [
        ["interaction.created", { interaction: { id: "synthetic-interaction", status: "in_progress" } }],
        ["step.start", { index: 0, step: { type: "model_output", content: [] } }],
        ["step.delta", { index: 0, delta: { type: "text", text: "OK" } }],
        ["step.stop", { index: 0 }],
        ["interaction.completed", { interaction: { id: "synthetic-interaction", status: "completed", usage: response().usage } }]
      ];
      return new Response(events.map(([type, value]) => `event: ${type}\ndata: ${JSON.stringify({ ...(value as object), event_type: type })}\n\n`)
        .join("") + "event: done\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ ...response(), steps: [{ type: "model_output", content: [{ type: "text", text: "OK" }] }] });
  });
  const tester = createAdminProviderDraftTester({ createFetch: () => fetchFn, retrySleep: async () => {},
    pdfInputProbe: { async probe() { throw new Error("pdf_input_adapter_unsupported"); } } });
  return { fetchFn, tester };
}

describe("Gemini administrator JSON capability probe", () => {
  it("checks native JSON, produces matching evidence and lights only independently verified chips", async () => {
    const { fetchFn, tester } = fixture();
    const result = await tester.test(input);
    expect(result).toMatchObject({ status: "available", evidence: {
      structuredOutput: { adapterKind: "gemini_interactions_native", upstreamModelId: "gemini-json-test", probeVersion: 2, verified: true },
      compatibility: { structuredOutput: "verified", modelAccess: "verified", streaming: "verified", directPdf: "not_supported" }
    } });
    expect(hasVerifiedStructuredOutput(result.evidence, input.model)).toBe(true);
    const bodies = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const schemaBodies = bodies.filter((body) => body.response_format);
    expect(schemaBodies).toHaveLength(1);
    expect(schemaBodies[0]).toMatchObject({ store: false, stream: false, model: "gemini-json-test",
      generation_config: { max_output_tokens: 128 },
      response_format: { mime_type: "application/json", type: "text", schema: {
        required: ["ready", "count", "label", "tool_ids"], additionalProperties: false
      } } });
    expect(schemaBodies[0].tools).toBeUndefined();
    expect(schemaBodies[0].generation_config.thinking_level).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.evidence.forcedToolCall).toBeUndefined();
    const check = fixtureCheck({ credentialId: "credential-1", providerModelId: "model-1", evidence: result.evidence });
    expect(modelChipsFromEvidence(input.model, check)).toContainEqual({ key: "json", label: "JSON", tone: "ok" });
    expect(modelChipsFromEvidence(input.model, null)).toEqual([]);
    expect(modelChipsFromEvidence({ ...input.model, upstreamModelId: "other-model" }, check)).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_KEY|synthetic-interaction|system_instruction|tool_ids/);
    const jsonOnlyRole: ProviderAdmissionRole = {
      verifiedStructuredOutput: true,
      credentialSource: "default",
      modelConfiguration: { ...input.model, adapterKind: "gemini_interactions_native" },
      snapshot: {
        connection: input.connection,
        connectionDisplayName: input.connectionDisplayName,
        connectionId: input.connectionId,
        credentialId: input.credentialId,
        credentialVersionId: input.credentialVersionIdentity,
        model: input.model,
        modelDisplayName: input.modelDisplayName,
        providerFamily: input.providerFamily,
        providerModelId: input.providerModelId,
        version: 1
      }
    };
    expect(systemModelRoleEligible(jsonOnlyRole, "memory")).toBe(false);
  });

  it.each(["minimal", "low"])("admits an explicit reasoning-aware probe budget using %s", async (effort) => {
    const { fetchFn, tester } = fixture();
    const result = await tester.test({ ...input, model: {
      ...input.model,
      capabilities: { ...input.model.capabilities, defaultReasoningEffort: "high", reasoning: true,
        reasoningEfforts: ["high", effort] },
      defaultParams: { reasoning: { effort: "high" } }
    } });
    expect(result.evidence.structuredOutput?.verified).toBe(true);
    const schemaBodies = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter((body) => body.response_format);
    expect(schemaBodies).toHaveLength(1);
    expect(schemaBodies[0].generation_config).toEqual({
      max_output_tokens: 1_024, thinking_level: effort, thinking_summaries: "none"
    });
  });

  it.each([400, 404, 415, 422])("records a deterministic native schema rejection (%s) independently of access", async (status) => {
    const { tester } = fixture(() => new Response("PRIVATE_UPSTREAM_ERROR", { status }));
    const result = await tester.test(input);
    expect(result).toMatchObject({ status: "available", evidence: { compatibility: {
      structuredOutput: "not_supported", modelAccess: "verified", streaming: "verified"
    } } });
    expect(result.evidence.structuredOutput).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UPSTREAM_ERROR");
  });

  it.each([401, 403, 429, 500])("does not publish incompatibility for an authentication or transient failure (%s)", async (status) => {
    const { tester } = fixture(() => new Response("PRIVATE_UPSTREAM_ERROR", { status }));
    await expect(tester.test(input)).rejects.toThrow(`Gemini request failed with status ${status}`);
  });

  it.each(["incomplete", "failed", "in_progress", "cancelled"])("does not verify a %s response containing valid JSON", async (status) => {
    const { tester } = fixture(() => Response.json({ ...response(), status }));
    await expect(tester.test(input)).rejects.toThrow("structured_output_provider_incomplete");
  });

  it("keeps malformed schema values from publishing positive evidence", async () => {
    const { tester } = fixture(() => Response.json(response({ ...probeValue, tool_ids: ["alpha", "alpha"] })));
    const result = await tester.test(input);
    expect(result.evidence.compatibility?.structuredOutput).toBe("not_supported");
    expect(result.evidence.structuredOutput).toBeUndefined();
  });

  it("fails the whole check without retrying when native JSON exceeds its bounded output", async () => {
    const { fetchFn, tester } = fixture(() => Response.json(response({
      ...probeValue, label: "x".repeat(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters)
    })));
    await expect(tester.test(input)).rejects.toThrow("provider_output_too_large");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("preserves a provider execution output-limit error without retrying or publishing incompatibility", async () => {
    const error = Object.assign(new Error("structured_output_output_limit_exceeded"), {
      code: "structured_output_output_limit_exceeded"
    });
    const { fetchFn, tester } = fixture(() => { throw error; });
    await expect(tester.test(input)).rejects.toBe(error);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("cancels the whole check without promoting the returned JSON", async () => {
    const controller = new AbortController();
    const { tester, fetchFn } = fixture(() => { controller.abort(); return Response.json(response()); });
    await expect(tester.test({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

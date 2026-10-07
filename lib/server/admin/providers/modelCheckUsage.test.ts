// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import { imageModelConfiguration } from "../../../domain/imageModels";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";
import { createModelCheckUsageRecorder, type ModelCheckUsageRecord } from "./modelCheckUsage";

const ADMIN = "admin-1";

function answerInput(overrides: Partial<AdminProviderDraftTesterInput> = {}): AdminProviderDraftTesterInput {
  return {
    connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1", authenticationMode: "bearer",
      responseTimeoutMs: 300_000 },
    connectionDisplayName: "OpenRouter", connectionId: "connection-1", credentialId: "credential-1",
    credentialVersionIdentity: "draft:1", mode: "tiny_generation",
    model: { adapterKind: "openrouter_chat_completions", answerSelectable: true,
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      defaultParams: {}, modelClass: "answer", openRouterRouting: { mode: "automatic", providers: [] },
      upstreamModelId: "vendor/model" },
    modelDisplayName: "Vendor Model", providerFamily: "openrouter", providerModelId: "model-1", secret: "secret",
    actorUserId: ADMIN,
    ...overrides
  };
}

function writer() {
  const rows: ModelCheckUsageRecord[] = [];
  const recordUsage = vi.fn(async (row: ModelCheckUsageRecord) => { rows.push(row); });
  return { recordUsage, rows };
}

const chatUsage = { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 };

function answerFetch() {
  return vi.fn<typeof fetch>(async (_url, request) => {
    const body = JSON.parse(String(request?.body));
    // The vision answer reports no usage: the call is still recorded, with unknown usage.
    if (JSON.stringify(body.messages).includes("image_url")) return Response.json({
      choices: [{ finish_reason: "stop", message: { content: "PEARS", role: "assistant" } }]
    });
    const name = body.tools?.[0]?.function?.name;
    if (name === "aiqsa_parallel_probe") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: ["Oslo", "Rome"].map((city, index) => ({
        id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify({ city }) }
      }))
    } }], usage: chatUsage });
    if (name) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, role: "assistant",
      tool_calls: [{ function: { arguments: JSON.stringify({ city: "Oslo" }), name }, id: "call-1", type: "function" }] } }],
    usage: chatUsage });
    if (body.stream === true) return new Response([
      'data: {"id":"chat-1","model":"vendor/model","choices":[{"delta":{"content":"OK"},"finish_reason":null}]}', "",
      `data: {"id":"chat-1","model":"vendor/model","choices":[],"usage":${JSON.stringify(chatUsage)}}`, "",
      "data: [DONE]", ""
    ].join("\n"), { headers: { "content-type": "text/event-stream" }, status: 200 });
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }), role: "assistant" } }],
    usage: chatUsage });
  });
}

const pdfProbe = {
  async probe(value: { onUsage?(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void }) {
    value.onUsage?.({ inputTokens: 40, outputTokens: 2, totalTokens: 42 });
    return { adapterKind: "openrouter_chat_completions" as const, probeVersion: 1 as const,
      upstreamModelId: "vendor/model", verified: true as const };
  }
};

describe("administrator model-check usage", () => {
  it("charges every answered call of a full answer-model check once to the acting administrator", async () => {
    const fetchFn = answerFetch();
    const { recordUsage, rows } = writer();
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn,
      pdfInputProbe: pdfProbe, recordUsage }).test(answerInput());
    expect(outcome.status).toBe("available");
    expect(outcome.evidence.capabilitySetup?.checks).toMatchObject({ modelAccess: "verified", structuredOutput: "verified",
      toolCalling: "verified", forcedToolCall: "verified", parallelToolCalls: "verified", vision: "verified",
      directPdf: "verified", streaming: "verified" });
    // Seven HTTP requests plus the Direct PDF request: one row each, all written before the check returned.
    expect(fetchFn).toHaveBeenCalledTimes(7);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row).toMatchObject({ userId: ADMIN, provider: "openrouter", modelId: "vendor/model",
        providerModelId: "model-1", modelClass: "answer", reportedCostUsd: null });
    }
    expect(rows.filter((row) => row.usage.inputTokens === 2 && row.usage.outputTokens === 1)).toHaveLength(6);
    expect(rows.filter((row) => row.usage.inputTokens === 40)).toHaveLength(1);
  });

  it("leaves an unattributed check, such as a startup adoption probe, unaccounted", async () => {
    const { recordUsage } = writer();
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => answerFetch(),
      pdfInputProbe: pdfProbe, recordUsage }).test(answerInput({ actorUserId: undefined }));
    expect(outcome.status).toBe("available");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("never fails a probe because its usage row could not be written", async () => {
    const recordUsage = vi.fn(async () => { throw Object.assign(new Error("database unavailable"), { code: "P1001" }); });
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => answerFetch(),
      pdfInputProbe: pdfProbe, recordUsage }).test(answerInput());
    expect(outcome.status).toBe("available");
    expect(recordUsage).toHaveBeenCalledTimes(8);
  });

  it("records a structured-output response that reported no usage as an answered call with unknown usage", async () => {
    const { recordUsage, rows } = writer();
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, recordUsage,
      createFetch: () => async () => Response.json({ id: "chat-1", choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }), role: "assistant" } }] })
    }).test(answerInput({ capabilityRole: "chat_titles" }));
    expect(outcome.evidence.compatibility?.structuredOutput).toBe("verified");
    // The access probe and the structured-output probe.
    expect(rows).toHaveLength(2);
    expect(rows[1]!.usage).toEqual({});
  });

  it("charges each embedding request with its reported cost and never a failed attempt", async () => {
    const { recordUsage, rows } = writer();
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { message: "busy" } }, { status: 503 });
      return Response.json({ data: [{ embedding: Array.from({ length: 4_096 }, (_, index) => index === 0 ? 1 : 0), index: 0 }],
        model: "qwen/qwen3-embedding-8b",
        usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.0000004 } });
    });
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn, recordUsage })
      .test(answerInput({ model: { adapterKind: "openai_embeddings_compatible", answerSelectable: false,
        capabilities: { contextWindow: 32_768, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
        defaultParams: {}, embedding: { nativeDimension: 4_096, providerFamily: "openrouter",
          queryInstructionTemplate: "Query: {text}", supportsMrl: true, targetDimension: 1_536 },
        modelClass: "embedding", upstreamModelId: "qwen/qwen3-embedding-8b" } }));
    expect(outcome.status).toBe("available");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(rows).toEqual([0, 1].map(() => expect.objectContaining({ modelClass: "embedding", modelId: "qwen/qwen3-embedding-8b",
      reportedCostUsd: 0.0000004, usage: { inputTokens: 4, totalTokens: 4 }, userId: ADMIN })));
  });

  it("charges a reranker probe with its reported cost", async () => {
    const { recordUsage, rows } = writer();
    await createAdminProviderDraftTester({ retrySleep: async () => {}, recordUsage, createFetch: () => async () => Response.json({
      id: "rerank-1", model: "qwen/qwen3-reranker-8b", provider: "Together",
      results: [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.1 }],
      usage: { prompt_tokens: 9, total_tokens: 9, cost: 0.000002 }
    }) }).test(answerInput({ model: { adapterKind: "openrouter_rerank", answerSelectable: false,
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: false,
        toolCalling: false, vision: false }, defaultParams: {}, modelClass: "reranker",
      openRouterRouting: { mode: "automatic", providers: [] }, upstreamModelId: "qwen/qwen3-reranker-8b" } }));
    expect(rows).toEqual([expect.objectContaining({ modelClass: "reranker", reportedCostUsd: 0.000002,
      usage: { inputTokens: 9, totalTokens: 9 } })]);
  });

  it.each([
    { scenario: "valid", rows: 1 }, { scenario: "wrong choice", rows: 1 }, { scenario: "missing answer", rows: 1 },
    { scenario: "outage", rows: 0 }
  ])("charges a Decisions probe from its receipt ($scenario)", async ({ scenario, rows: expected }) => {
    const { recordUsage, rows } = writer();
    const pending = createAdminProviderDraftTester({ recordUsage, createFetch: () => async () => scenario === "outage"
      ? Response.json({}, { status: 503 })
      : Response.json({ model: JEV_SERVED_MODEL_ID, provider: "TypeSafe", answers: { useful: { type: "noul", noul: 0.95 },
        ...(scenario === "missing answer" ? {} : { relation: { type: "choice", choice: scenario === "wrong choice" ? "unrelated" : "useful" } }) },
      usage: { input_tokens: 18, output_tokens: 28, cost: 0.00003 } }) }).test(answerInput({ model: jevModelConfiguration() }));
    if (scenario === "valid") await expect(pending).resolves.toMatchObject({ status: "available" });
    else await expect(pending).rejects.toThrow(/^decision_/);
    expect(rows).toHaveLength(expected);
    if (expected) expect(rows[0]).toMatchObject({ modelClass: "decision", reportedCostUsd: 0.00003,
      usage: { inputTokens: 18, outputTokens: 28 } });
  });

  it("charges both image probes, including an edit judged inconclusive", async () => {
    const reference = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ee2828" } }).png().toBuffer();
    const { recordUsage, rows } = writer();
    let call = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      call += 1;
      const png = call === 1 ? await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer() : reference;
      return Response.json({ data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
    });
    const outcome = await createAdminProviderDraftTester({ createFetch: () => fetchFn, recordUsage }).test(answerInput({
      initialSetup: true, model: imageModelConfiguration("gpt-image-2", { profile: "openai" }), providerFamily: "openai",
      providerModelId: "image-1"
    }));
    expect(outcome.evidence.capabilitySetup?.checks).toMatchObject({ imageGeneration: "verified", imageEditing: "incomplete" });
    expect(rows).toEqual([1, 2].map(() => expect.objectContaining({ modelClass: "image", provider: "openai",
      providerModelId: "image-1", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } })));
  });

  it("charges hosted and Codex search probes, and a failed search that reported usage", async () => {
    const reuse: AdminProviderTestEvidence = {
      detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "synthetic-model",
      capabilitySetup: { activation: "initial", policyVersion: 2, checks: {
        modelAccess: "verified", structuredOutput: "unsupported", toolCalling: "unsupported", forcedToolCall: "unsupported",
        parallelToolCalls: "unsupported", vision: "unsupported", directPdf: "unsupported", streaming: "verified"
      } },
      compatibility: { probeVersion: 2, modelAccess: "verified", structuredOutput: "not_supported",
        directPdf: "not_supported", streaming: "verified", usage: "verified" }
    };
    const search = answerInput({ connectionDisplayName: "Synthetic gateway", providerFamily: "openai_compatible",
      providerModelId: "model", initialSetup: true, reuseSetupEvidence: reuse,
      model: { adapterKind: "openai_responses_compatible", modelClass: "answer", answerSelectable: true,
        capabilities: { nativeSearch: false, nativePdfInput: false, pdf: false, reasoning: false, vision: false },
        upstreamModelId: "synthetic-model", defaultParams: {} } });
    const hosted = { ...search, connection: { apiRoot: "https://gateway.example.test/compatible", allowPrivateNetwork: false,
      authenticationMode: "bearer" as const, responseTimeoutMs: 300_000, responsesRequestIsolation: "auto" as const,
      responsesRequestIsolationDetected: true } };
    for (const status of ["completed", "incomplete"]) {
      const { recordUsage, rows } = writer();
      const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ id: "synthetic-response", status, output: [
        { type: "web_search_call", id: "search", status: "completed", action: { type: "search",
          sources: [{ url: "https://openai.com", title: "OpenAI" }] } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The official OpenAI home page." }] }
      ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
      const outcome = await createAdminProviderDraftTester({ createFetch: () => fetchFn, retrySleep: async () => {}, recordUsage })
        .test(hosted);
      expect(outcome.evidence.capabilitySetup?.checks.hostedSearch).toBe(status === "completed" ? "verified" : "incomplete");
      expect(rows).toHaveLength(fetchFn.mock.calls.length);
      for (const row of rows) expect(row.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    }
    const { recordUsage, rows } = writer();
    await createAdminProviderDraftTester({ recordUsage, createFetch: () => async () => Response.json({ encrypted_output: "opaque",
      output: "OpenAI home page", results: [{ url: "https://openai.com/", ref_id: "source1" }] }) }).test({ ...search,
      connection: { apiRoot: "https://gateway.example.test/backend-api/codex", allowPrivateNetwork: false,
        authenticationMode: "bearer", responseTimeoutMs: 300_000 } });
    // Codex search reports no usage: the call stays recorded with unknown usage.
    expect(rows).toEqual([expect.objectContaining({ userId: ADMIN, providerModelId: "model" })]);
  });
});

describe("model-check usage recorder", () => {
  const identity = { provider: "openrouter", modelId: "vendor/model", providerModelId: "model-1", modelClass: "answer" as const };

  it("is absent without a writer or an acting administrator", () => {
    expect(createModelCheckUsageRecorder(undefined, { ...identity, userId: ADMIN })).toBeNull();
    expect(createModelCheckUsageRecorder(vi.fn(), identity)).toBeNull();
  });

  it("writes each call once and settles after a failed write without throwing", async () => {
    const write = vi.fn<(row: ModelCheckUsageRecord) => Promise<void>>()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(undefined);
    const recorder = createModelCheckUsageRecorder(write, { ...identity, userId: ADMIN })!;
    expect(() => recorder.record({ usage: { inputTokens: 1, outputTokens: 1 }, reportedCostUsd: null })).not.toThrow();
    recorder.record({ usage: { inputTokens: 2, outputTokens: 1 }, reportedCostUsd: 0.5 });
    await recorder.settled();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toEqual({ ...identity, userId: ADMIN, usage: { inputTokens: 2, outputTokens: 1 },
      reportedCostUsd: 0.5 });
  });
});

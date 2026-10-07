import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import type { PrismaClient } from "@prisma/client";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import { KNOWLEDGE_IMAGE_OBSERVATION_LIMITS, KNOWLEDGE_IMAGE_OBSERVATION_SYSTEM_PROMPT, knowledgeImageObservationAnswerOutputTokens, knowledgeImageObservationRequestHash,
  type KnowledgeImageObservationPlan } from "../knowledge/imageObservation";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import type { ConversationImageSource, ConversationVisionImage } from "./conversationImages";
import { createKnowledgeImageObservation, type KnowledgeImageObservationOutcome, type KnowledgeImageObservationStore } from "./knowledgeObservation";
import { boundedVisionRequest, visionProviderRequest } from "./service";

const vision: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 3, reasoningEffort: null, verifiedVisionInput: true,
  authority: { connectionId: "connection", connectionVersion: 2, providerModelId: "vision", modelVersion: 1, credentialId: "key", credentialVersionId: "key-v1" },
  snapshot: { version: 1, connectionId: "connection", connectionDisplayName: "Vision connection", providerModelId: "vision", modelDisplayName: "Vision",
    credentialId: "key", credentialVersionId: "key-v1", providerFamily: "openai_compatible",
    connection: { apiRoot: "https://vision.example.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 60000 },
    model: { adapterKind: "openai_responses_compatible", modelClass: "answer", upstreamModelId: "visual-model", answerSelectable: true, defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: true } } } };
const plan: KnowledgeImageObservationPlan = { version: 1, route: "system_vision", imageIds: ["image-b", "image-a"], vision };
const question = "Does the headline in my poster follow the style guide?";

function image(index: number): ConversationVisionImage {
  return { dispose: vi.fn(), open: vi.fn(async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([index, 2, 3])); c.close(); } })),
    descriptor: { version: 1, id: `descriptor-${index}`, byteSize: 3, checksum: "a".repeat(64), mimeType: "image/png", width: 4, height: 4, frames: 1,
      source: { attachmentId: plan.imageIds[index]!, mimeType: "image/png", byteSize: 3, checksum: "b".repeat(64), width: 4, height: 4 }, transform: null } };
}

function fixture(existing: KnowledgeImageObservationOutcome | null = null) {
  let row: KnowledgeImageObservationOutcome | "dispatched" | null = existing;
  const store = {
    load: vi.fn(async () => row === "dispatched" ? { kind: "unknown" as const } : row),
    destination: vi.fn(async () => ({ bindingKey: "vision_analysis" as const, authority: vision.authority, snapshot: vision.snapshot,
      snapshotHash: "c".repeat(64), reasoningEffort: null })),
    dispatch: vi.fn(async (_c: unknown, _destination: unknown, _images: unknown): Promise<KnowledgeImageObservationOutcome | null> => {
      row = "dispatched";
      return null;
    }),
    settle: vi.fn(async (_c: unknown, result: KnowledgeImageObservationOutcome, _usage: unknown, unknown: boolean, _signal: AbortSignal) => {
      row = unknown ? { kind: "unknown" } : result;
      return row;
    })
  };
  const images = [image(0), image(1)];
  const conversationImages = { prepare: vi.fn(async () => ({ images, assertAccess: vi.fn(async () => undefined) })) };
  const execute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockResolvedValue({
    finalText: "  A poster whose headline is set in a script typeface.  ", finalProviderResponsePreview: {}, usage: { inputTokens: 9, outputTokens: 4 } });
  const observe = createKnowledgeImageObservation({} as PrismaClient, { store: store as unknown as KnowledgeImageObservationStore, execute,
    conversationImages: conversationImages as unknown as ConversationImageSource, boundedRequest: boundedVisionRequest, providerRequest: visionProviderRequest });
  const input = { plan, question, runId: "run", userId: "user", chatId: "chat", authorize: vi.fn(async () => true), signal: new AbortController().signal };
  return { store, images, conversationImages, execute, observe, input };
}

describe("Knowledge image observation", () => {
  it("describes only the admitted images, in order, focused on the question, then settles usage once", async () => {
    const f = fixture();
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "observed",
      observation: { text: "A poster whose headline is set in a script typeface.", truncated: false } });
    expect(f.conversationImages.prepare).toHaveBeenCalledWith(expect.objectContaining({ admittedImageIds: plan.imageIds,
      images: [{ imageId: "image-b" }, { imageId: "image-a" }] }), expect.any(AbortSignal));
    const [snapshot, request] = f.execute.mock.calls[0]!;
    expect(snapshot).toEqual(vision.snapshot);
    expect(request).toMatchObject({ modelId: "visual-model", tools: [], toolMode: "none", forceNonStreaming: true,
      prompt: { system: KNOWLEDGE_IMAGE_OBSERVATION_SYSTEM_PROMPT }, content: { blocks: [{ type: "text", text: `Question: ${question}` }] },
      params: { maxOutputTokens: KNOWLEDGE_IMAGE_OBSERVATION_LIMITS.maxOutputTokens } });
    expect(request.attachments.map(attachment => attachment.dataUrl)).toEqual(["data:image/png;base64,AAID", "data:image/png;base64,AQID"]);
    expect(JSON.stringify(buildOpenAIResponsesRequest(request))).toContain("data:image/png;base64,AAID");
    // The claim precedes the provider request and never stores pixels.
    expect(f.store.dispatch.mock.invocationCallOrder[0]!).toBeLessThan(f.execute.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(f.store.dispatch.mock.calls)).not.toContain("AAID");
    expect(f.store.dispatch.mock.calls[0]![0]).toMatchObject({ requestHash: knowledgeImageObservationRequestHash(plan, question) });
    expect(f.store.settle).toHaveBeenCalledOnce();
    expect(f.store.settle.mock.calls[0]![2]).toMatchObject({ inputTokens: 9, outputTokens: 4 });
    for (const entry of f.images) expect(entry.dispose).toHaveBeenCalledOnce();
    // A settled description is reused: no images are read and nothing is sent again.
    await expect(f.observe(f.input)).resolves.toMatchObject({ kind: "observed" });
    expect(f.conversationImages.prepare).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("never repeats a dispatched or ambiguous description", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { code: "provider_http_request_failed" }));
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "unknown" });
    expect(f.store.settle.mock.calls[0]![3]).toBe(true);
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "unknown" });
    // A crash after the claim leaves only the dispatch fence.
    const crashed = fixture();
    crashed.store.load.mockResolvedValueOnce({ kind: "unknown" });
    await expect(crashed.observe(crashed.input)).resolves.toEqual({ kind: "unknown" });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(crashed.execute).not.toHaveBeenCalled();
    expect(crashed.conversationImages.prepare).not.toHaveBeenCalled();
  });

  it("refuses before reading images when the run lost its authority, and settles nothing", async () => {
    const f = fixture();
    f.input.authorize.mockResolvedValue(false);
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "failed", code: "vision_model_unavailable" });
    expect(f.conversationImages.prepare).not.toHaveBeenCalled();
    expect(f.store.dispatch).not.toHaveBeenCalled();
    expect(f.store.settle).not.toHaveBeenCalled();
    f.store.destination.mockResolvedValueOnce(null as never);
    f.input.authorize.mockResolvedValue(true);
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "failed", code: "vision_model_unavailable" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("returns a concurrent claim's outcome without another provider request", async () => {
    const f = fixture();
    f.store.dispatch.mockResolvedValueOnce({ kind: "unknown" });
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "unknown" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.settle).not.toHaveBeenCalled();
  });

  it("bounds a long description and journals the one dispatch", async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({ finalText: "é".repeat(KNOWLEDGE_IMAGE_OBSERVATION_LIMITS.textBytes), finalProviderResponsePreview: {}, usage: {} });
    const finish = vi.fn(async () => undefined);
    const onDispatch = vi.fn(async (_request: unknown, _destination: unknown) => finish);
    const outcome = await f.observe({ ...f.input, onDispatch });
    if (outcome.kind !== "observed") throw Error("expected an observation");
    expect(outcome.observation.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.observation.text, "utf8")).toBeLessThanOrEqual(KNOWLEDGE_IMAGE_OBSERVATION_LIMITS.textBytes);
    expect(outcome.observation.text).not.toContain("�");
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onDispatch.mock.calls[0]![1]).toEqual({ provider: "openai_compatible", modelId: "visual-model" });
    expect(finish).toHaveBeenCalledWith(true, null);
  });

  it("gives an answer model its own bounded allowance and lets only Stop withhold a completed description", async () => {
    expect(knowledgeImageObservationAnswerOutputTokens({ contextWindow: 32_000, maxOutputTokens: 128_000 })).toBe(16_000);
    expect(knowledgeImageObservationAnswerOutputTokens({ contextWindow: null, maxOutputTokens: 8_000 })).toBe(8_000);
    expect(knowledgeImageObservationAnswerOutputTokens({ contextWindow: 1_000_000, maxOutputTokens: 65_536 }))
      .toBe(KNOWLEDGE_IMAGE_OBSERVATION_LIMITS.answerModelMaxOutputTokens);
    const f = fixture();
    await f.observe({ ...f.input, maxOutputTokens: 12_000 });
    expect(f.execute.mock.calls[0]![1].params).toMatchObject({ maxOutputTokens: 12_000, max_output_tokens: 12_000 });
    // Settlement sees the run's Stop signal, not the description's own deadline.
    expect(f.store.settle.mock.calls[0]![4]).toBe(f.input.signal);
    const capped = fixture();
    await capped.observe({ ...capped.input, maxOutputTokens: 1_000_000 });
    expect(capped.execute.mock.calls[0]![1].params).toMatchObject({ maxOutputTokens: KNOWLEDGE_IMAGE_OBSERVATION_LIMITS.answerModelMaxOutputTokens });
  });

  it("waits for System Vision by its frozen reasoning effort unless the caller admitted its own budget", async () => {
    const base = fixture();
    await base.observe(base.input);
    expect(base.execute.mock.calls[0]![2]).toMatchObject({ timeoutMs: 60_000 });
    const high = fixture();
    await high.observe({ ...high.input, plan: { ...plan, vision: { ...vision, reasoningEffort: "high" } } });
    expect(high.execute.mock.calls[0]![2]).toMatchObject({ timeoutMs: 180_000 });
    const answer = fixture();
    await answer.observe({ ...answer.input, plan: { ...plan, vision: { ...vision, reasoningEffort: "high" } }, timeoutMs: 90_000 });
    expect(answer.execute.mock.calls[0]![2]).toMatchObject({ timeoutMs: 90_000 });
  });

  it("settles a claim that never reached the provider as a definite failure", async () => {
    const f = fixture();
    const onDispatch = vi.fn(async () => { throw new Error("journal_unavailable"); });
    await expect(f.observe({ ...f.input, onDispatch })).resolves.toEqual({ kind: "failed", code: "vision_analysis_internal_failed" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.settle).toHaveBeenCalledOnce();
    // Not ambiguous: nothing was sent, so the failure is final rather than an unknown outcome.
    expect(f.store.settle.mock.calls[0]![3]).toBe(false);
  });

  it("reports each description attempt once with its stable code, never a settled reuse", async () => {
    const observation = await captureRunObservation();
    const f = fixture();
    await f.observe(f.input);
    await f.observe(f.input);
    const failed = fixture();
    failed.execute.mockRejectedValueOnce(new Error("PRIVATE provider body"));
    await failed.observe(failed.input);
    const outcomes = observation.records().filter((record) => record.event === "tool_execution" && record.tool_kind === "vision");
    const identity = { adapterKind: "openai_responses_compatible", connectionId: "connection", providerFamily: "openai_compatible", providerModelId: "vision" };
    expect(outcomes).toEqual([
      expect.objectContaining({ ...identity, stage: "grounding", outcome: "completed", duration_ms: expect.any(Number) }),
      expect.objectContaining({ ...identity, stage: "grounding", outcome: "failed", code: "vision_analysis_provider_failed" })
    ]);
    expect(JSON.stringify(observation.records())).not.toMatch(/PRIVATE|headline|poster/);
  });

  it("settles an empty or tool-calling response as a visible failure with its usage", async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({ finalText: " ", finalProviderResponsePreview: {}, usage: { inputTokens: 3, outputTokens: 0 } });
    await expect(f.observe(f.input)).resolves.toEqual({ kind: "failed", code: "vision_analysis_response_invalid" });
    expect(f.store.settle.mock.calls[0]![3]).toBe(false);
    expect(f.store.settle.mock.calls[0]![2]).toMatchObject({ inputTokens: 3 });
  });
});

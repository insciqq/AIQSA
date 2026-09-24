import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import type { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import type { WorkspaceCapturedImage } from "../workspace/imageCapture";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { createVisionAnalysisService, parseVisionAnalysisInput } from "./service";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { createVisionAnalysisStore } from "./store";

const plan: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 3, reasoningEffort: null, verifiedVisionInput: true,
  authority: { connectionId: "connection", connectionVersion: 2, providerModelId: "vision", modelVersion: 1, credentialId: "key", credentialVersionId: "key-v1" },
  snapshot: { version: 1, connectionId: "connection", connectionDisplayName: "Vision connection", providerModelId: "vision", modelDisplayName: "Vision",
    credentialId: "key", credentialVersionId: "key-v1", providerFamily: "openai_compatible",
    connection: { apiRoot: "https://vision.example.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 60000 },
    model: { adapterKind: "openai_responses_compatible", modelClass: "answer", upstreamModelId: "visual-model", answerSelectable: true, defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: true } } } };
function fixture() {
  const call = { id: "provider-call", name: "analyze_image", arguments: { images: [{ path: "/workspace/project/z/same.png" }, { path: "/workspace/project/a/same.png" }], question: "Compare colors." } };
  const context = { runId: "run", userId: "user", persistedToolCallId: "tool", request: { visionAnalysis: plan,
    workspace: { outputDirectory: "/workspace/output/run" }, chatId: "chat", modelId: "text-model", modelCapabilities: { vision: false }, context: { messages: [{ secret: "private-history" }] } } } as unknown as ToolExecutionContext;
  const captures = { create: vi.fn(async () => ({ id: "capture" })), imageSource: vi.fn(async (ref: { relativePath: string }) => ({ ...ref, assertAccess: vi.fn(async () => {}) })), release: vi.fn(async () => {}) };
  const prepareImages = vi.fn(async (sources: Array<{ source: { relativePath: string } }>): Promise<WorkspaceCapturedImage[]> => sources.map(({ source }, index) => ({
    descriptor: { version: 1, id: `image-${index}`, byteSize: 3, checksum: "a".repeat(64), mimeType: "image/png", width: 4, height: 4, frames: 1,
      source: { captureId: "capture", relativePath: source.relativePath, byteSize: 3, checksum: "b".repeat(64), width: 4, height: 4 }, transform: null },
    open: vi.fn(async () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([index, 2, 3])); c.close(); } })), dispose: vi.fn()
  })));
  type Store = ReturnType<typeof createVisionAnalysisStore>;
  const store = { restore: vi.fn<Store["restore"]>().mockResolvedValue(null), dispatch: vi.fn<Store["dispatch"]>().mockResolvedValue({ result: null }),
    settle: vi.fn<Store["settle"]>().mockImplementation(async (_c, result) => result) };
  const execute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockResolvedValue({ finalText: "First is red; second is blue.", finalProviderResponsePreview: {}, usage: { inputTokens: 9, outputTokens: 4 } });
  const authorize = vi.fn(async () => true);
  const service = createVisionAnalysisService({} as PrismaClient, captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, {
    store: store as unknown as ReturnType<typeof createVisionAnalysisStore>, execute, authorize,
    prepareImages: prepareImages as never, resolve: async () => plan
  });
  return { call, context, captures, prepareImages, store, execute, authorize, service };
}

describe("shared System Vision boundary", () => {
  it("delivers real validated PNG pixels through the existing provider wire adapter", async () => {
    const f = fixture();
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const captures = { ...f.captures, imageSource: vi.fn(async (ref: { relativePath: string }) => ({ ...ref,
      captureId: "c".repeat(32), byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"),
      assertAccess: async () => {}, open: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) })) };
    const service = createVisionAnalysisService({} as PrismaClient, captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, {
      store: f.store, execute: f.execute, authorize: f.authorize, resolve: async () => plan
    });
    expect((await service.execute(f.call, f.context)).status).toBe("complete");
    const request = f.execute.mock.calls[0]![1];
    const image = request.attachments[0]!;
    const decoded = await sharp(Buffer.from(image.dataUrl!.split(",")[1]!, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 3, height: 2, channels: 3 });
    expect([...decoded.data]).toEqual(Array(6).fill([255, 0, 0]).flat());
    expect(JSON.stringify(buildOpenAIResponsesRequest(request))).toContain(image.dataUrl);
    expect(JSON.stringify(f.store.dispatch.mock.calls)).not.toContain("base64");
  });
  it("sends only selected ordered pixels and question to frozen auxiliary deployment for a text-only main model", async () => {
    const f = fixture(); const result = await f.service.execute(f.call, f.context);
    expect(result.status).toBe("complete"); expect(result.usage).toBeUndefined();
    const [snapshot, request] = f.execute.mock.calls[0]!;
    expect(snapshot).toEqual(plan.snapshot);
    expect(request).toMatchObject({ modelId: "visual-model", tools: [], toolMode: "none", forceNonStreaming: true,
      content: { blocks: [{ type: "text", text: "Compare colors." }] } });
    const attachments = request.attachments;
    expect(attachments.map(a => a.dataUrl)).toEqual(["data:image/png;base64,AAID", "data:image/png;base64,AQID"]);
    expect(JSON.stringify(buildOpenAIResponsesRequest(request))).toContain("data:image/png;base64,AAID");
    expect(attachments.map(a => a.fileName)).toEqual(["image-1.png", "image-2.png"]);
    expect(JSON.stringify(request)).not.toContain("private-history");
    expect(JSON.stringify(request)).not.toContain("/workspace/");
    expect(f.captures.imageSource.mock.calls.map(([ref]) => ref.relativePath)).toEqual(["project/z/same.png", "project/a/same.png"]);
    expect(f.store.dispatch.mock.calls[0]?.[2]).toBeDefined();
    expect(JSON.stringify(f.store.dispatch.mock.calls)).not.toContain("AAID");
    expect(f.captures.release).toHaveBeenCalledOnce();
  });
  it.each(["vision_model_absent", "vision_model_unavailable"] as const)("returns %s without any file or provider I/O", async code => {
    const f = fixture(); f.context.request.visionAnalysis = { version: 1, available: false, code };
    expect(JSON.stringify(await f.service.execute(f.call, f.context))).toContain(code);
    expect(f.captures.create).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.store.restore).not.toHaveBeenCalled();
  });
  it("restores the durable result without recapturing or paying, including unknown dispatch outcome", async () => {
    const f = fixture(); const prior: ToolExecutionResult = { callId: f.call.id, name: f.call.name, status: "error", content: [{ type: "json", value: { error: "vision_analysis_outcome_unknown" } }] };
    f.store.restore.mockResolvedValue(prior);
    expect(await f.service.execute(f.call, f.context)).toBe(prior);
    expect(f.captures.create).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("fails a revoked deployment before capture and never substitutes the main model", async () => {
    const f = fixture(); f.authorize.mockResolvedValue(false);
    expect(JSON.stringify(await f.service.execute(f.call, f.context))).toContain("vision_model_unavailable");
    expect(f.captures.create).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("records ambiguous provider failure without leaking response text and never returns answer usage", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("secret provider body"));
    const result = await f.service.execute(f.call, f.context);
    expect(JSON.stringify(result)).toContain("vision_analysis_provider_failed"); expect(JSON.stringify(result)).not.toContain("secret");
    expect(f.store.settle.mock.calls[0]?.[3]).toBe(true); expect(result.usage).toBeUndefined();
  });
  it("retries only identical local settlement after receiving a successful paid analysis", async () => {
    const f = fixture();
    f.store.settle.mockRejectedValueOnce(new Error("PRIVATE_DB_FAILURE"));
    const result = await f.service.execute(f.call, f.context);
    expect(result.status).toBe("complete");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.store.settle).toHaveBeenCalledTimes(2);
    expect(f.store.settle.mock.calls[1]).toEqual(f.store.settle.mock.calls[0]);
    expect(f.store.settle.mock.calls[1]?.[2]).toMatchObject({ inputTokens: 9, outputTokens: 4 });
    expect(f.store.settle.mock.calls[1]?.[3]).toBe(false);
  });
  it("reports persistent local settlement failure without relabelling the provider or redispatching", async () => {
    const f = fixture();
    f.store.settle.mockRejectedValue(new Error("PRIVATE_DB_FAILURE"));
    await expect(f.service.execute(f.call, f.context)).rejects.toMatchObject({ code: "vision_analysis_settlement_failed" });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.store.settle).toHaveBeenCalledTimes(2);
    expect(f.store.settle.mock.calls.every(([, result, usage, unknown]) => result.status === "complete" && usage.inputTokens === 9 && !unknown)).toBe(true);
  });
  it("does not infer a capability or input failure from provider exception prose", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("vision_model_absent"));
    const result = await f.service.execute(f.call, f.context);
    expect(JSON.stringify(result)).toContain("vision_analysis_provider_failed");
    expect(JSON.stringify(result)).not.toContain("vision_model_absent");
  });
  it("checks cancellation after a late provider response and retains its usage", async () => {
    const f = fixture(); const abort = new AbortController();
    f.execute.mockImplementation(async () => { abort.abort(); return { finalText: "late", finalProviderResponsePreview: {}, usage: { inputTokens: 5, outputTokens: 2 } }; });
    const result = await f.service.execute(f.call, f.context, abort.signal);
    expect(result.status).toBe("error"); expect(JSON.stringify(result)).toContain("vision_analysis_cancelled");
    expect(f.store.settle.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
  it("bounds geometry/payload before paid dispatch", async () => {
    const f = fixture(); f.context.request.visionAnalysis = { ...plan, snapshot: { ...plan.snapshot, model: { ...plan.snapshot.model,
      capabilities: { ...plan.snapshot.model.capabilities, imageInputLimits: { imageCount: 1, imageBytes: 100, imagePixels: 100, payloadBytes: 10000 } } } } };
    expect(JSON.stringify(await f.service.execute(f.call, f.context))).toContain("vision_analysis_limit_exceeded");
    expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("normalizes the current physical output directory and rejects another run", async () => {
    const f = fixture(); f.call.arguments.images = [{ path: "/workspace/output/run/result.png" }];
    expect((await f.service.execute(f.call, f.context)).status).toBe("complete");
    expect(f.captures.imageSource.mock.calls[0]?.[0].relativePath).toBe("output/result.png");
    expect(() => parseVisionAnalysisInput({ images: [{ path: "/workspace/output/other/result.png" }], question: "What?" }, "/workspace/output/run")).toThrow();
  });
  it("rejects unbounded or unauthorized path arguments", () => {
    for (const images of [[], Array(9).fill({ path: "project/a.png" }), [{ path: "/etc/passwd" }], [{ path: "project/../secret" }]])
      expect(() => parseVisionAnalysisInput({ images, question: "What?" })).toThrow();
    expect(() => parseVisionAnalysisInput({ images: [{ path: "project/a.png" }], question: "x".repeat(4001) })).toThrow();
  });
});

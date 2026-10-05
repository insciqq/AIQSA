import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import type { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import type { WorkspaceCapturedImage } from "../workspace/imageCapture";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { createVisionAnalysisService, parseConversationVisionInput, parseVisionAnalysisInput } from "./service";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { createVisionAnalysisStore } from "./store";
import { createConversationImageSource, type ConversationImageDescriptor } from "./conversationImages";
import { createMemoryStorageAdapter } from "@/tests/support/storage";

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
  it("waits by the plan's reasoning effort and settles its expiry as an ambiguous timeout", async () => {
    const f = fixture(); f.context.request.visionAnalysis = { ...plan, reasoningEffort: "high" };
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      f.execute.mockImplementation(async (_snapshot, _request, options) => {
        expect(options?.timeoutMs).toBe(180_000); expect(options?.signal?.aborted).toBe(false);
        deadline.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable");
      });
      const result = await f.service.execute(f.call, f.context, new AbortController().signal);
      expect(timeout).toHaveBeenCalledWith(180_000);
      expect(result.content[0]).toMatchObject({ value: { error: "vision_analysis_timeout", provider_outcome: "unknown" } });
      expect(f.store.settle.mock.calls[0]?.[3]).toBe(true);
    } finally { timeout.mockRestore(); }
  });
  it("keeps the base bound without an effort and lets an earlier run deadline end the call as cancelled", async () => {
    const f = fixture(); const run = new AbortController();
    f.execute.mockImplementation(async (_snapshot, _request, options) => {
      expect(options?.timeoutMs).toBe(60_000);
      run.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable");
    });
    const result = await f.service.execute(f.call, f.context, run.signal);
    expect(result.content[0]).toMatchObject({ value: { error: "vision_analysis_cancelled", provider_outcome: "unknown" } });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("bounds geometry/payload before paid dispatch", async () => {
    const f = fixture(); f.context.request.visionAnalysis = { ...plan, snapshot: { ...plan.snapshot, model: { ...plan.snapshot.model,
      capabilities: { ...plan.snapshot.model.capabilities, imageInputLimits: { imageCount: 1, imageBytes: 100, imagePixels: 100, payloadBytes: 10000 } } } } };
    expect(JSON.stringify(await f.service.execute(f.call, f.context))).toContain("vision_analysis_limit_exceeded");
    expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([["Cyrillic", "a" + "я".repeat(9000)], ["emoji", "ab" + "😀".repeat(5000)]])(
    "cuts a long %s analysis at a code point within the result bound and keeps the paid usage", async (_name, finalText) => {
      const f = fixture();
      f.execute.mockResolvedValue({ finalText, finalProviderResponsePreview: {}, usage: { inputTokens: 9, outputTokens: 4096 } });
      const result = await f.service.execute(f.call, f.context);
      const value = (result.content[0] as { value: { analysis: string; truncated: boolean; originalBytes: number } }).value;
      expect(result.status).toBe("complete");
      expect(value.analysis).not.toContain("\uFFFD");
      expect(finalText.startsWith(value.analysis)).toBe(true);
      expect(Buffer.byteLength(value.analysis)).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(value.analysis)).toBeGreaterThan(16 * 1024 - 4);
      expect(value).toMatchObject({ truncated: true, originalBytes: Buffer.byteLength(finalText) });
      expect(f.store.settle.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 9, outputTokens: 4096 });
    });
  it("keeps a short analysis whole and unmarked", async () => {
    const f = fixture();
    const value = (await f.service.execute(f.call, f.context)).content[0] as { value: Record<string, unknown> };
    expect(value.value).toMatchObject({ analysis: "First is red; second is blue.", truncated: false });
    expect(value.value).not.toHaveProperty("originalBytes");
  });
  function uhdImages(f: ReturnType<typeof fixture>, count: number, contextWindow: number | undefined, providerFamily = plan.snapshot.providerFamily) {
    f.call.arguments.images = Array.from({ length: count }, (_, index) => ({ path: `/workspace/project/${index}.png` }));
    f.prepareImages.mockImplementation(async sources => sources.map((_source, index) => ({
      descriptor: { version: 1, id: `image-${index}`, byteSize: 3, checksum: "a".repeat(64), mimeType: "image/png", width: 3840, height: 2160, frames: 1,
        source: { captureId: "capture", relativePath: `project/${index}.png`, byteSize: 3, checksum: "b".repeat(64), width: 3840, height: 2160 }, transform: null },
      open: vi.fn(async () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([index, 2, 3])); c.close(); } })), dispose: vi.fn()
    })));
    f.context.request.visionAnalysis = { ...plan, snapshot: { ...plan.snapshot, providerFamily, model: { ...plan.snapshot.model,
      capabilities: { ...plan.snapshot.model.capabilities, contextWindow } } } };
  }
  it("admits one 4K image in a known 128k window and refuses four before dispatch with the measured estimate", async () => {
    const one = fixture(); uhdImages(one, 1, 131_072);
    expect((await one.service.execute(one.call, one.context)).status).toBe("complete");
    expect(one.execute).toHaveBeenCalledOnce();
    const four = fixture(); uhdImages(four, 4, 131_072);
    const result = await four.service.execute(four.call, four.context);
    expect(result.content[0]).toMatchObject({ type: "json", value: { error: "vision_analysis_limit_exceeded", limit: "context_window",
      contextWindow: 131_072, maxOutputTokens: 4096 } });
    expect((result.content[0] as { value: { estimatedInputTokens: number } }).value.estimatedInputTokens).toBeGreaterThan(4 * 33_664);
    expect(four.store.dispatch).not.toHaveBeenCalled(); expect(four.execute).not.toHaveBeenCalled(); expect(four.store.settle).not.toHaveBeenCalled();
  });
  it("applies a declared family policy: four 4K images fit a 128k Anthropic window", async () => {
    const f = fixture(); uhdImages(f, 4, 131_072, "anthropic");
    expect((await f.service.execute(f.call, f.context)).status).toBe("complete");
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("does not invent a window for a model without a declared one", async () => {
    const f = fixture(); uhdImages(f, 1, undefined);
    expect((await f.service.execute(f.call, f.context)).status).toBe("complete");
    expect(f.execute).toHaveBeenCalledOnce();
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

type ChatImageRow = { id: string; mimeType: string; bytes: Buffer; userId?: string | null; projectId?: string | null;
  origin?: "USER_UPLOAD" | "IMAGE_OUTPUT"; producerModelRunId?: string | null; chatId?: string | null };
type AttachmentWhere = { id: { in: string[] }; kind: string; status: string; savedAt: null; userId?: string; projectId?: string;
  OR: Array<{ id: { in: string[] } } | { origin: string; producerModelRunId: string; chatId: string }> };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A chat whose attachment query honours the service's authority filter. */
async function chatFixture(rows: ChatImageRow[], options: { references?: string[]; project?: boolean } = {}) {
  const storage = createMemoryStorageAdapter();
  for (const row of rows) await storage.putObject({ storageKey: `private/${row.id}`, contentType: row.mimeType, body: row.bytes });
  const stored = rows.map((row) => ({ kind: "image", status: "ready", savedAt: null, userId: options.project ? null : "user",
    projectId: options.project ? "project" : null, origin: "USER_UPLOAD", producerModelRunId: null, chatId: "chat", ...row,
    storageKey: `private/${row.id}`, byteSize: row.bytes.byteLength, checksum: sha256(row.bytes) }));
  const findMany = vi.fn(async ({ where }: { where: AttachmentWhere }) => stored.filter((row) =>
    where.id.in.includes(row.id) && row.kind === where.kind && row.status === where.status && row.savedAt === null &&
    (where.userId === undefined || row.userId === where.userId) && (where.projectId === undefined || row.projectId === where.projectId) &&
    where.OR.some((match) => "id" in match ? match.id.in.includes(row.id)
      : row.origin === match.origin && row.producerModelRunId === match.producerModelRunId && row.chatId === match.chatId)
  ).map(({ id, storageKey, byteSize, checksum, mimeType }) => ({ id, storageKey, byteSize, checksum, mimeType })));
  const db = {
    chat: { findUnique: vi.fn(async () => ({ archived: false, permanentDeletionAt: null,
      projectId: options.project ? "project" : null, userId: options.project ? null : "user" })) },
    user: { findFirst: vi.fn(async () => ({ id: "user", groups: [] })) },
    project: { findUnique: vi.fn(async () => ({ accessRevision: 1, id: "project", instructionsRevision: 1, memoryRevision: 1,
      policyRevision: 1, status: "ACTIVE", grants: [{ userId: "user", role: "CONTRIBUTOR", groupId: null, group: null }] })) },
    attachment: { findMany }
  };
  type Store = ReturnType<typeof createVisionAnalysisStore>;
  const store = { restore: vi.fn<Store["restore"]>().mockResolvedValue(null), dispatch: vi.fn<Store["dispatch"]>().mockResolvedValue({ result: null }),
    settle: vi.fn<Store["settle"]>().mockImplementation(async (_c, result) => result) };
  const execute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockResolvedValue({ finalText: "A small synthetic image.", finalProviderResponsePreview: {}, usage: { inputTokens: 9, outputTokens: 4 } });
  const captures = { create: vi.fn(), imageSource: vi.fn(), release: vi.fn() };
  const service = createVisionAnalysisService({} as PrismaClient, captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, {
    store: store as unknown as Store, execute, authorize: async () => true, resolve: async () => plan,
    conversationImages: createConversationImageSource(db as unknown as PrismaClient, storage)
  });
  // No Workspace: the chat form addresses conversation images by image_id.
  const context = { runId: "run", userId: "user", persistedToolCallId: "tool", request: { visionAnalysis: plan, chatId: "chat",
    imageReferences: (options.references ?? rows.map((row) => row.id)).map((attachmentId) => ({ attachmentId, messageId: "message", fileName: `${attachmentId}.img`, origin: "upload" })),
    modelId: "text-model", modelCapabilities: { vision: false } } } as unknown as ToolExecutionContext;
  const call = (images: Array<string | Record<string, unknown>>) => ({ id: "provider-call", name: "analyze_image", arguments: {
    images: images.map((image) => typeof image === "string" ? { image_id: image } : image), question: "What is shown?" } });
  return { captures, call, context, db, execute, service, store };
}

/** Structurally valid two-frame GIF: refused before any decoding. */
function animatedGif(): Buffer {
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
  return Buffer.from([...Buffer.from("GIF89a", "ascii"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, ...frame, ...frame, 0x3b]);
}

function errorOf(result: ToolExecutionResult): { error?: string; hint?: string } {
  return (result.content[0] as { value: { error?: string; hint?: string } }).value;
}

describe("chat System Vision over conversation images", () => {
  it("sends PNG and JPEG as stored and WebP and static GIF as PNG, keeping each source identity", async () => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00ff00" } }).jpeg().toBuffer();
    const webp = await sharp({ create: { width: 5, height: 3, channels: 3, background: "#0000ff" } }).webp({ lossless: true }).toBuffer();
    const gif = await sharp({ create: { width: 2, height: 6, channels: 3, background: "#ffff00" } }).gif().toBuffer();
    const f = await chatFixture([{ id: "png", mimeType: "image/png", bytes: png }, { id: "jpeg", mimeType: "image/jpeg", bytes: jpeg },
      { id: "webp", mimeType: "image/webp", bytes: webp }, { id: "gif", mimeType: "image/gif", bytes: gif }]);
    const result = await f.service.execute(f.call(["png", "jpeg", "webp", "gif"]), f.context);
    expect(result.status).toBe("complete");
    expect(f.captures.create).not.toHaveBeenCalled();
    const request = f.execute.mock.calls[0]![1];
    expect(request).toMatchObject({ modelId: "visual-model", tools: [], toolMode: "none", content: { blocks: [{ type: "text", text: "What is shown?" }] } });
    expect(request.attachments.map((attachment) => attachment.mimeType)).toEqual(["image/png", "image/jpeg", "image/png", "image/png"]);
    expect(request.attachments[0]!.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(request.attachments[1]!.dataUrl).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    for (const [index, size] of [[2, { width: 5, height: 3 }], [3, { width: 2, height: 6 }]] as const) {
      const decoded = await sharp(Buffer.from(request.attachments[index]!.dataUrl!.split(",")[1]!, "base64")).metadata();
      expect(decoded).toMatchObject({ format: "png", ...size });
    }
    expect(JSON.stringify(buildOpenAIResponsesRequest(request))).toContain(request.attachments[2]!.dataUrl);
    const descriptors = f.store.dispatch.mock.calls[0]![2] as unknown as ConversationImageDescriptor[];
    expect(descriptors.map((descriptor) => descriptor.source)).toEqual([
      expect.objectContaining({ attachmentId: "png", mimeType: "image/png", checksum: sha256(png), width: 3, height: 2 }),
      expect.objectContaining({ attachmentId: "jpeg", mimeType: "image/jpeg", checksum: sha256(jpeg) }),
      expect.objectContaining({ attachmentId: "webp", mimeType: "image/webp", checksum: sha256(webp), width: 5, height: 3 }),
      expect.objectContaining({ attachmentId: "gif", mimeType: "image/gif", checksum: sha256(gif), width: 2, height: 6 })
    ]);
    expect(descriptors[0]).toMatchObject({ checksum: sha256(png), byteSize: png.byteLength, transform: null });
    expect(JSON.stringify(f.store.dispatch.mock.calls)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(request)).not.toContain("private/");
    expect(f.db.attachment.findMany.mock.calls[0]![0].where).toMatchObject({ userId: "user", kind: "image", status: "ready", savedAt: null });
    expect((result.content[0] as { value: { inputs: unknown[] } }).value.inputs).toEqual([
      expect.objectContaining({ ordinal: 1, source: expect.objectContaining({ attachmentId: "png" }) }),
      expect.objectContaining({ ordinal: 2 }), expect.objectContaining({ ordinal: 3 }), expect.objectContaining({ ordinal: 4 })
    ]);
  });

  it("refuses unsupported, animated and unadmitted images before dispatch with an actionable hint", async () => {
    const tiff = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#ffffff" } }).tiff().toBuffer();
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#000000" } }).png().toBuffer();
    const cases: Array<[ChatImageRow, string[] | undefined, string]> = [
      [{ id: "tiff", mimeType: "image/tiff", bytes: tiff }, undefined, "chat_image_unsupported"],
      [{ id: "animated", mimeType: "image/gif", bytes: animatedGif() }, undefined, "chat_image_unsupported"],
      [{ id: "elsewhere", mimeType: "image/png", bytes: png }, [], "chat_image_unavailable"],
      [{ id: "other-run", mimeType: "image/png", bytes: png, origin: "IMAGE_OUTPUT", producerModelRunId: "another-run" }, [], "chat_image_unavailable"]
    ];
    for (const [row, references, code] of cases) {
      const f = await chatFixture([row], references ? { references } : {});
      const result = await f.service.execute(f.call([row.id]), f.context);
      expect(result.status).toBe("error");
      expect(errorOf(result).error).toBe(code);
      expect(errorOf(result).hint).toMatch(code === "chat_image_unsupported" ? /PNG, JPEG, WebP and static GIF/ : /exact image_id/);
      expect(f.store.dispatch).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("admits an image this run generated without a conversation reference", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } }).png().toBuffer();
    const f = await chatFixture([{ id: "generated", mimeType: "image/png", bytes: png, origin: "IMAGE_OUTPUT", producerModelRunId: "run" }], { references: [] });
    expect((await f.service.execute(f.call(["generated"]), f.context)).status).toBe("complete");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("reads a Project chat's images only under the Project's attachment authority", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#654321" } }).png().toBuffer();
    const f = await chatFixture([{ id: "shared", mimeType: "image/png", bytes: png }], { project: true });
    expect((await f.service.execute(f.call(["shared"]), f.context)).status).toBe("complete");
    expect(f.db.attachment.findMany.mock.calls[0]![0].where).toMatchObject({ projectId: "project" });
    expect(f.db.attachment.findMany.mock.calls[0]![0].where).not.toHaveProperty("userId");
  });

  it("rechecks authority right before dispatch and never sends a removed image", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abcdef" } }).png().toBuffer();
    const f = await chatFixture([{ id: "removed", mimeType: "image/png", bytes: png }]);
    const original = f.db.attachment.findMany.getMockImplementation()!;
    f.db.attachment.findMany.mockImplementationOnce(original).mockImplementationOnce(async () => []);
    const result = await f.service.execute(f.call(["removed"]), f.context);
    expect(errorOf(result).error).toBe("chat_image_unavailable");
    expect(f.db.attachment.findMany).toHaveBeenCalledTimes(2);
    expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it("applies crop and resize like Workspace captures and refuses geometry outside the image", async () => {
    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#808080" } }).png().toBuffer();
    const f = await chatFixture([{ id: "wide", mimeType: "image/png", bytes: png }]);
    const crop = { left: 30, top: 0, width: 10, height: 20 };
    expect((await f.service.execute(f.call([{ image_id: "wide", crop, resize: { width: 5, height: 5 } }]), f.context)).status).toBe("complete");
    const descriptor = (f.store.dispatch.mock.calls[0]![2] as unknown as ConversationImageDescriptor[])[0]!;
    expect(descriptor).toMatchObject({ mimeType: "image/png", transform: { crop, resize: { width: 5, height: 5 } },
      source: { attachmentId: "wide", width: 40, height: 20 } });
    expect(descriptor.width).toBeLessThanOrEqual(5); expect(descriptor.height).toBeLessThanOrEqual(5);
    const outside = await chatFixture([{ id: "wide", mimeType: "image/png", bytes: png }]);
    const refused = await outside.service.execute(outside.call([{ image_id: "wide", crop: { ...crop, left: 35 } }]), outside.context);
    expect(errorOf(refused)).toMatchObject({ error: "chat_image_invalid", hint: expect.stringContaining("crop") });
    expect(outside.execute).not.toHaveBeenCalled();
  });

  it("restores a durable chat result without reading images or paying again", async () => {
    const f = await chatFixture([]);
    const prior: ToolExecutionResult = { callId: "provider-call", name: "analyze_image", status: "error",
      content: [{ type: "json", value: { error: "vision_analysis_outcome_unknown" } }] };
    f.store.restore.mockResolvedValue(prior);
    expect(await f.service.execute(f.call(["any"]), f.context)).toBe(prior);
    expect(await f.service.restore(f.call(["any"]), f.context)).toBe(prior);
    expect(f.db.attachment.findMany).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it("refuses chat analysis in a process without the conversation image source", async () => {
    const f = await chatFixture([]);
    const service = createVisionAnalysisService({} as PrismaClient, f.captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, {
      store: f.store as unknown as ReturnType<typeof createVisionAnalysisStore>, execute: f.execute, authorize: async () => true, resolve: async () => plan });
    expect(errorOf(await service.execute(f.call(["any"]), f.context)).error).toBe("vision_analysis_internal_failed");
    expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it("accepts only bounded image_id handles in the chat form", () => {
    expect(parseConversationVisionInput({ images: [{ image_id: "a", resize: { width: 4, height: 4 } }], question: " What? " }))
      .toEqual({ images: [{ imageId: "a", transform: { resize: { width: 4, height: 4 } } }], question: "What?" });
    for (const images of [[], Array(9).fill({ image_id: "a" }), [{ path: "/workspace/project/a.png" }], [{ image_id: "" }],
      [{ image_id: "x".repeat(129) }], [{ image_id: "a", url: "https://example.test/a.png" }]])
      expect(() => parseConversationVisionInput({ images, question: "What?" })).toThrow();
  });
});

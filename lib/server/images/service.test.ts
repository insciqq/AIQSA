import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { mixedToolsImagePlan } from "@/tests/support/openRouterTools";
import { captureRunObservation } from "@/tests/support/runObservation";
import { imageInputFailure, ImageInputError } from "./inputError";
import { imageDispatchMustStop } from "./errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAccess } from "../projects/access";
import type { ProviderAttachment, ProviderRunRequest } from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";

const access = vi.hoisted(() => ({ value: null as ChatAccess | null }));
vi.mock("../projects/access", () => ({ resolveChatAccess: vi.fn(async () => access.value) }));

const { createPrismaImageGenerationService } = await import("./service");

type Row = { id: string; byteSize: number; checksum: string | null; fileName: string; mimeType: string; storageKey: string;
  kind: string; status: string; savedAt: Date | null; userId: string | null; projectId: string | null };

const USER = "user-1";
const personal: ChatAccess = { kind: "personal", project: null, userId: USER };

function bytes(id: string, size = 16): Buffer {
  return Buffer.alloc(size, id);
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  const body = bytes(id, overrides.byteSize);
  return { id, byteSize: body.byteLength, checksum: createHash("sha256").update(body).digest("hex"), fileName: `${id}.png`,
    mimeType: "image/png", storageKey: `key-${id}`, kind: "image", status: "ready", savedAt: null, userId: USER, projectId: null, ...overrides };
}

function current(id: string, kind = "image"): ProviderAttachment {
  const body = bytes(id);
  return { id, kind, status: "ready", byteSize: body.byteLength, fileName: `${id}.bin`, mimeType: kind === "image" ? "image/png" : "application/pdf",
    metadata: {}, extractedText: null, base64Data: body.toString("base64"), dataUrl: `data:image/png;base64,${body.toString("base64")}` };
}

function harness(rows: Row[], bodies: Record<string, Buffer> = {}) {
  const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] }; kind: string; status: string; savedAt: null; userId?: string; projectId?: string } }) =>
    rows.filter((entry) => where.id.in.includes(entry.id) && entry.kind === where.kind && entry.status === where.status &&
      entry.savedAt === null && ("projectId" in where ? entry.projectId === where.projectId : entry.userId === where.userId)));
  const getObject = vi.fn(async (storageKey: string) => {
    const entry = rows.find((candidate) => candidate.storageKey === storageKey)!;
    return { body: bodies[entry.id] ?? bytes(entry.id, entry.byteSize), contentType: entry.mimeType };
  });
  const service = createPrismaImageGenerationService({ attachment: { findMany } } as unknown as PrismaClient,
    { getObject } as unknown as StorageAdapter);
  return { findMany, getObject, service };
}

function request(attachments: ProviderAttachment[], history: Array<{ id: string; messageId: string }>, overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: attachments.map((attachment) => attachment.id),
    attachments,
    chatId: "chat-1",
    content: { blocks: [{ type: "text", text: "What is on the latest screenshot?" }] },
    imageReferences: [
      ...history.map(({ id, messageId }) => ({ attachmentId: id, messageId, fileName: `${id}.png`, origin: "upload" as const })),
      ...attachments.filter((attachment) => attachment.kind === "image").map((attachment) => ({
        attachmentId: attachment.id, messageId: "current-user-message", fileName: attachment.fileName, origin: "upload" as const }))
    ],
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { vision: true, pdf: true, nativePdfInput: false, nativeSearch: false, reasoning: false },
    modelId: "vision-model",
    params: {},
    prompt: { developer: null, system: "Base system." },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto",
    ...overrides
  };
}

const history = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `h${index + 1}`, messageId: `m${index + 1}` }));
const ids = (result: ProviderRunRequest) => result.attachments.map((attachment) => attachment.id);
const system = (result: ProviderRunRequest) => result.prompt.system!.split("\n\n").at(-1)!;

describe("withConversationPixels", () => {
  beforeEach(() => { access.value = personal; });

  it("attaches only the newest earlier image before a fresh current image", async () => {
    const earlier = history(3);
    const { findMany, service } = harness(earlier.map(({ id }) => row(id)));
    const result = await service.withConversationPixels(request([current("c1")], earlier), USER);

    expect(findMany.mock.calls[0]![0].where.id.in).toEqual(["h3"]);
    expect(ids(result)).toEqual(["h3", "c1"]);
    expect(result.attachments.map((attachment) => attachment.imageProvenance)).toEqual([
      { role: "earlier_message", messageId: "m3" }, { role: "current_message" }
    ]);
  });

  it("keeps up to four earlier images, oldest first, when the current message has none", async () => {
    const earlier = history(6);
    const { findMany, service } = harness(earlier.map(({ id }) => row(id)));
    const result = await service.withConversationPixels(request([], earlier), USER);

    expect(findMany.mock.calls[0]![0].where.id.in).toEqual(["h3", "h4", "h5", "h6"]);
    expect(ids(result)).toEqual(["h3", "h4", "h5", "h6"]);
    expect(result.attachments.every((attachment) => attachment.imageProvenance?.role === "earlier_message")).toBe(true);
  });

  it("treats a PDF-only current message like a message without images", async () => {
    const earlier = history(6);
    const { service } = harness(earlier.map(({ id }) => row(id)));
    const result = await service.withConversationPixels(request([current("pdf-1", "pdf")], earlier), USER);

    expect(ids(result)).toEqual(["h3", "h4", "h5", "h6", "pdf-1"]);
    expect(result.attachments.at(-1)).not.toHaveProperty("imageProvenance");
  });

  it("loads only the admitted newest references out of eight", async () => {
    const earlier = history(8);
    const withImage = harness(earlier.map(({ id }) => row(id)));
    await withImage.service.withConversationPixels(request([current("c1")], earlier), USER);
    expect(withImage.getObject.mock.calls.map(([key]) => key)).toEqual(["key-h8"]);

    const withoutImage = harness(earlier.map(({ id }) => row(id)));
    await withoutImage.service.withConversationPixels(request([], earlier), USER);
    expect(withoutImage.getObject.mock.calls.map(([key]) => key)).toEqual(["key-h8", "key-h7", "key-h6", "key-h5"]);
  });

  it("separates current-message and earlier-message ids in the system line", async () => {
    const earlier = history(3);
    const { service } = harness(earlier.map(({ id }) => row(id)));
    const result = await service.withConversationPixels(request([current("c1"), current("c2")], earlier), USER);
    const line = system(result);

    expect(line).toBe("Image pixels in this request, in order. From earlier messages (references, not new uploads): [\"h3\"]. " +
      "Accompanying the latest user message: [\"c1\",\"c2\"]. A caption before each image names its image_id and source message. " +
      "Other image references have no visible pixels in this request.");
    expect(result.prompt.system!.startsWith("Base system.\n\n")).toBe(true);
    const [earlierGroup, currentGroup] = [...line.matchAll(/\[[^\]]*\]/g)].map(([match]) => JSON.parse(match) as string[]);
    expect(earlierGroup!.filter((id) => currentGroup!.includes(id))).toEqual([]);
  });

  it("keeps a request without added earlier images byte-identical to the previous output", async () => {
    const attachment = current("c1");
    const input = request([attachment], [], { modelCapabilities: { vision: true, pdf: true, nativePdfInput: false, nativeSearch: false, reasoning: false,
      imageInputLimits: { imageBytes: 1_000_000, imageCount: 1, imagePixels: 1_000_000, payloadBytes: 1_000_000 } } });
    input.imageReferences!.unshift({ attachmentId: "h1", messageId: "m1", fileName: "h1.png", origin: "upload" });
    const { findMany, service } = harness([row("h1")]);
    const result = await service.withConversationPixels(input, USER);

    expect(findMany.mock.calls[0]![0].where.id.in).toEqual([]);
    expect(JSON.stringify(result)).toBe(JSON.stringify({ ...input, attachments: [attachment], prompt: { ...input.prompt,
      system: "Base system.\n\nImage pixels accompanying the latest user message, in order: [\"c1\"]. Additional images are references from earlier messages, not new uploads. Other image references have no visible pixels in this request." } }));
  });

  it("keeps the per-request image count and byte budgets", async () => {
    const earlier = history(4);
    const limits = (payloadBytes: number, imageBytes = 1_000) => ({ vision: true, pdf: true, nativePdfInput: false, nativeSearch: false, reasoning: false,
      imageInputLimits: { imageBytes, imageCount: 20, imagePixels: 1_000_000, payloadBytes } });
    const rows = [row("h1", { byteSize: 8 }), row("h2", { byteSize: 8 }), row("h3", { byteSize: 8 }), row("h4", { byteSize: 64 })];

    // Newest first: h4 exceeds the payload budget, then h3 and h2 fit and h1 no longer does.
    const payload = await harness(rows).service.withConversationPixels(request([], earlier, { modelCapabilities: limits(20) }), USER);
    expect(ids(payload)).toEqual(["h2", "h3"]);

    const perImage = await harness(rows).service.withConversationPixels(request([], earlier, { modelCapabilities: limits(1_000, 32) }), USER);
    expect(ids(perImage)).toEqual(["h1", "h2", "h3"]);

    const countLimited = await harness(rows).service.withConversationPixels(request([current("c1")], earlier, { modelCapabilities: {
      ...limits(1_000), imageInputLimits: { imageBytes: 1_000, imageCount: 1, imagePixels: 1_000_000, payloadBytes: 1_000 } } }), USER);
    expect(ids(countLimited)).toEqual(["c1"]);
  });

  it("keeps the access and checksum fences", async () => {
    const earlier = history(2);
    const foreign = harness([row("h1"), row("h2", { userId: "other-user" })]);
    expect(ids(await foreign.service.withConversationPixels(request([], earlier), USER))).toEqual(["h1"]);

    const project = harness([row("h1", { userId: null, projectId: "p1" }), row("h2", { userId: USER, projectId: null })]);
    access.value = { kind: "project", project: { projectId: "p1" } as never, userId: null };
    expect(ids(await project.service.withConversationPixels(request([], earlier), USER))).toEqual(["h1"]);

    access.value = null;
    await expect(harness([row("h1")]).service.withConversationPixels(request([], earlier), USER)).rejects.toThrow("image_access_revoked");

    access.value = personal;
    const tampered = harness([row("h1"), row("h2")], { h2: bytes("x") });
    await expect(tampered.service.withConversationPixels(request([], earlier), USER)).rejects.toThrow("image_reference_invalid");
  });
});

describe("image edit preflight", () => {
  beforeEach(() => { access.value = personal; });

  async function editHarness() {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const reference = row("private-reference", { byteSize: png.length, checksum: null });
    const findMany = vi.fn(async () => [reference]);
    const binding = vi.fn(async () => ({ executionSnapshot: mixedToolsImagePlan.snapshot }));
    const usage = vi.fn();
    const prisma = { providerRunBinding: { findFirst: binding }, attachment: { findFirst: vi.fn(async () => null), findMany },
      modelRun: { findFirst: vi.fn(async () => ({ assistantMessageId: "assistant", status: "streaming" })) },
      modelRunToolCall: { findFirst: vi.fn(async () => ({ id: "tool" })), count: vi.fn(async () => 0) },
      providerModel: { findFirst: vi.fn(async () => ({ id: "model" })) },
      providerCredentialVersion: { findFirst: vi.fn(async () => ({ id: "key" })) }, usageEvent: { create: usage } };
    const getObject = vi.fn(async () => ({ body: png, contentType: "image/png" }));
    const fetchFn = vi.fn<typeof fetch>();
    const beforeDispatch = vi.fn(async () => { throw new Error("fixture_dispatch_boundary"); });
    const service = createPrismaImageGenerationService(prisma as unknown as PrismaClient, { getObject } as unknown as StorageAdapter, { fetchFn });
    const call = { id: "call", name: "generate_image", arguments: { prompt: "PRIVATE prompt", image_ids: [reference.id] } };
    const context = { runId: "run", userId: USER, persistedToolCallId: "tool", request: {
      chatId: "chat", imagePlan: mixedToolsImagePlan,
      imageReferences: [{ attachmentId: reference.id, messageId: "message", fileName: "PRIVATE.png", origin: "upload" as const }] } };
    return { reference, findMany, binding, usage, getObject, fetchFn, beforeDispatch, service, call, context };
  }

  it.each(["gif", "mime", "bytes", "kind", "checksum"])("refuses %s before the dispatch claim and usage", async (fault) => {
    const h = await editHarness();
    if (fault === "gif") h.reference.mimeType = "image/gif";
    if (fault === "mime") h.reference.mimeType = "image/jpeg";
    if (fault === "bytes") h.getObject.mockResolvedValue({ body: Buffer.alloc(h.reference.byteSize), contentType: "image/png" });
    if (fault === "kind") h.reference.kind = "file";
    if (fault === "checksum") h.reference.checksum = "bad-checksum";
    const error = await h.service.execute(h.call, h.context, undefined, { beforeDispatch: h.beforeDispatch }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImageInputError);
    expect(imageInputFailure(error)).toMatchObject({ code: fault === "checksum" ? "image_reference_invalid" : "image_reference_unsupported",
      message: expect.stringContaining(h.reference.id) });
    expect(imageDispatchMustStop(error)).toBe(false);
    expect(h.beforeDispatch).not.toHaveBeenCalled();
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });

  it("refuses invalid prompt and parameters before a dispatch claim", async () => {
    const h = await editHarness();
    for (const arguments_ of [
      { ...h.call.arguments, prompt: "bad\u0000prompt" },
      { ...h.call.arguments, parameters: { quality: "invalid" } }
    ]) {
      const error = await h.service.execute({ ...h.call, arguments: arguments_ }, h.context, undefined,
        { beforeDispatch: h.beforeDispatch }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ImageInputError);
      expect(imageDispatchMustStop(error)).toBe(false);
    }
    expect(h.beforeDispatch).not.toHaveBeenCalled();
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });

  it.each(["11111111-1111-4111-8111-111111111111x", "11111111-1111-4111-8111-111111111112"])("allows correction of an unavailable ID %s", async (id) => {
    const h = await editHarness();
    h.call.arguments.image_ids = [h.reference.id, id];
    const error = await h.service.execute(h.call, h.context, undefined, { beforeDispatch: h.beforeDispatch }).catch((error: unknown) => error);
    const failure = imageInputFailure(error)!;
    expect(failure.code).toBe("image_reference_not_found");
    expect(failure.message).toContain(id);
    expect(failure.message).not.toMatch(/uncertain|not repeat/i);
    expect(h.beforeDispatch).not.toHaveBeenCalled();
    expect(h.getObject).not.toHaveBeenCalled();
    h.call.arguments.image_ids = [h.reference.id];
    await expect(h.service.execute(h.call, h.context, undefined, { beforeDispatch: h.beforeDispatch })).rejects.toThrow("fixture_dispatch_boundary");
    expect(h.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });

  it.each(["binding", "reference_read"] as const)("logs an unexpected failure at %s without content", async (stage) => {
    const h = await editHarness();
    const observation = await captureRunObservation();
    const error = new Error("PRIVATE exception with https://secret.example and sk-secret");
    if (stage === "binding") h.binding.mockRejectedValue(error);
    else h.getObject.mockRejectedValue(error);
    await expect(h.service.execute(h.call, h.context)).rejects.toBe(error);
    expect(observation.records()).toContainEqual(expect.objectContaining({ event: "image_execution", stage, code: "tool_call_failed" }));
    expect(JSON.stringify(observation.records())).not.toMatch(/PRIVATE|private-reference|secret.example|sk-secret/);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });
});

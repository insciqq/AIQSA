import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
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

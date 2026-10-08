import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ConversationFileReference } from "../providers/types";
import { artifactTool, describeArtifactTool } from "../tools/artifact";
import type { ToolExecutionContext } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import { createArtifactService } from "./service";

const image = { attachmentId: "image-one", messageId: "message-one", fileName: "photo.png", origin: "upload" as const };
const file: ConversationFileReference = { attachmentId: "page-one", messageId: "message-one", fileName: "page.html",
  mimeType: "text/html", byteSize: 64, kind: "document", origin: "upload" };

describe("artifact references admitted at run acceptance", () => {
  it.each([
    { label: "file references", request: { fileReferences: [file, { ...file, attachmentId: "image-one", mimeType: "image/png", kind: "image" }],
      imageReferences: [image] }, allowed: ["page-one", "image-one"] },
    { label: "a snapshot accepted before file references", request: { imageReferences: [image] }, allowed: ["image-one"] },
    { label: "no conversation files", request: {}, allowed: [] }
  ])("lets $label decide the referenceable conversation files", async ({ request, allowed }) => {
    type Query = { where: { OR?: Array<{ id?: { in: string[] }; producerModelRunId?: string }> } };
    const findMany = vi.fn(async (_query: Query) => []);
    const db = { artifactVersion: { findFirst: async () => null, findUnique: async () => null },
      chat: { findFirst: async () => ({ id: "chat" }) }, attachment: { findMany }, $transaction: vi.fn() } as unknown as PrismaClient;
    const service = createArtifactService(db, {} as StorageAdapter);
    const result = await service.execute({ id: "call", name: "create_artifact", arguments: { intent: "create", kind: "image", title: "Synthetic",
      files: [{ path: "photo.png", mimeType: "image/png", asset_ref: "image-one" }] } },
    { userId: "owner", runId: "run", persistedToolCallId: "persisted",
      request: { chatId: "chat", artifactTool: true, ...request } } as unknown as ToolExecutionContext);
    expect(result.status).toBe("error");
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0]![0].where.OR).toEqual([{ id: { in: allowed } }, { producerModelRunId: "run" }]);
  });

  it("keeps the frozen description within the snapshot bound under the widest resource policy", () => {
    const host = (prefix: string, index: number) => `${prefix}${index}-${"a".repeat(40)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example`;
    const widest = { on: true, libraryHosts: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com",
      ...Array.from({ length: 11 }, (_, index) => host("l", index))], imageHosts: Array.from({ length: 16 }, (_, index) => host("i", index)) };
    expect(widest.libraryHosts.every((name) => name.length <= 253)).toBe(true);
    const description = describeArtifactTool(widest);
    expect(description.length).toBeLessThanOrEqual(16_384);
    for (const rule of ["asset_ref to the exact file_id of a conversation file", "unpack: true on an application/zip reference",
      "edits even at intent=create", "ordinary fetch('data.json')", "Links to other local HTML pages open inside the viewer",
      "24 MiB per file, 32 MiB per artifact, 64 MiB rendered page"]) expect(description).toContain(rule);
    const files = artifactTool(description).inputSchema.properties as { files: { items: { properties: { asset_ref: { description: string } } } } };
    expect(files.files.items.properties.asset_ref.description).toContain("mimeType must equal the file's MIME type");
  });
});

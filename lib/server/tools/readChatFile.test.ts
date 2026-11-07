// @vitest-environment node
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { createDirectImageBudget } from "../workspace/directImageView";
import { projectTranscript, type TranscriptItem } from "../engine/transcript";
import { contextItemTokens } from "../engine/contextMeasure";
import { CHAT_FILE_READ_LIMIT, createChatFileTool, createPrismaChatFileReader, type ChatFile } from "./readChatFile";

const file: ChatFile = { extractedText: "Section 3: Keep the originals.", fileName: "report.docx", kind: "document", status: "ready", metadata: {} };
const call = (args: Record<string, unknown> = { attachment_id: "doc" }, id = "read-1") => ({ arguments: args, id, name: "read_chat_file" });
function request(extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ type: "text", text: "Section 3?" }] },
    context: { mode: "branch_path", messages: [{ id: "first", role: "user", content: { blocks: [
      { type: "file", attachmentId: "doc", fileName: "report.docx" }, { type: "image", attachmentId: "old-image" }
    ] } }] }, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: false, toolCalling: true, vision: false },
    modelId: "fake", provider: "fake", params: {}, prompt: { developer: null, system: null }, searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", ...extra };
}
function tool(value: ChatFile | null = file, extra: Partial<Parameters<typeof createChatFileTool>[0]> = {}) {
  const read = vi.fn(async () => value);
  return { read, tool: createChatFileTool({ request: request(), userId: "owner", runId: "run", reader: { read }, runEnded: null, ...extra }) };
}
function json(result: Awaited<ReturnType<ReturnType<typeof createChatFileTool>["execute"]>>) {
  const part = result.content[0]!;
  if (part.type !== "json") throw new Error("Expected JSON");
  return part.value as Record<string, unknown>;
}

describe("read_chat_file", () => {
  it("reads an earlier document without Workspace, paginates exact text, and labels it untrusted", async () => {
    const { tool: reader, read } = tool();
    const first = json(await reader.execute(call({ attachment_id: "doc", limit: 10 }), 1));
    expect(first).toMatchObject({ name: "report.docx", kind: "document", text: "Section 3:", offset: 0, nextOffset: 10 });
    expect(first.note).toContain("untrusted data");
    const second = json(await reader.execute(call({ attachment_id: "doc", offset: first.nextOffset }), 2));
    expect(String(first.text) + String(second.text)).toBe(file.extractedText);
    expect(second.nextOffset).toBeNull();
    expect(read).toHaveBeenCalledWith({ attachmentId: "doc", chatId: "chat", userId: "owner" });
  });

  it("bounds arguments before any read and refuses siblings without disclosing their existence", async () => {
    const { tool: reader, read } = tool();
    for (const arguments_ of [ { attachment_id: "x".repeat(257) }, { attachment_id: "doc", offset: -1 },
      { attachment_id: "doc", limit: CHAT_FILE_READ_LIMIT + 1 }, { attachment_id: "doc", query: "section 3" } ]) {
      expect(json(await reader.execute(call(arguments_), 1)).error).toBe("chat_file_arguments_invalid");
    }
    expect(read).not.toHaveBeenCalled();
    const missing = json(await tool(null).tool.execute(call(), 1));
    for (const attachment_id of ["another-user", "another-chat", "sibling", "missing"]) {
      expect(json(await reader.execute(call({ attachment_id }), 1))).toEqual(missing);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("puts owner, exact chat and live lifecycle in the database predicate", async () => {
    const findFirst = vi.fn(async () => null);
    const reader = createPrismaChatFileReader({ attachment: { findFirst } } as unknown as PrismaClient);
    await reader.read({ attachmentId: "doc", chatId: "chat", userId: "owner" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "doc", chatId: "chat", userId: "owner", savedAt: null, chat: { userId: "owner", permanentDeletionAt: null }
    } }));
  });

  it("reports missing and partial extraction instead of treating it as empty content", async () => {
    expect(json(await tool({ ...file, extractedText: null }).tool.execute(call(), 1)))
      .toMatchObject({ error: "chat_file_no_text", message: expect.stringContaining("Do not infer that the file is empty") });
    const partial = { ...file, metadata: { document: { characterCount: 29, extractedTextMaxChars: 100, status: "partial", truncated: true } } };
    expect(json(await tool(partial).tool.execute(call(), 1)).note).toContain("text stops early");
    expect(json(await tool({ ...file, status: "failed" }).tool.execute(call(), 1)).error).toBe("chat_file_unreadable");
  });

  it("never loses escaped characters to a second excerpt", async () => {
    const text = '\u0001"\\\n'.repeat(8000);
    const { tool: reader } = tool({ ...file, extractedText: text });
    let offset: number | null = 0;
    let actual = "";
    while (offset !== null) {
      const result = await reader.execute(call({ attachment_id: "doc", offset }), 1);
      expect(JSON.stringify(json(result)).length).toBeLessThanOrEqual(24000);
      actual += String(json(result).text);
      offset = json(result).nextOffset as number | null;
    }
    expect(actual).toBe(text);
  });

  it("returns older image pixels for the next request only, counts them, and frees them at run end", async () => {
    let finish!: () => void;
    const runEnded = new Promise<void>((resolve) => { finish = resolve; });
    const budget = createDirectImageBudget();
    const readImage = vi.fn(async () => ({ bytes: Buffer.from("synthetic pixels"), mimeType: "image/png" as const, width: 100, height: 100 }));
    const base = request();
    const { tool: viewer } = tool({ ...file, kind: "image" }, { request: request({ modelCapabilities: { ...base.modelCapabilities, vision: true } }),
      readImage, budget, resultImages: true, runEnded });
    const shown = await viewer.execute(call({ attachment_id: "old-image" }), 1);
    expect(readImage).toHaveBeenCalledWith({ attachmentId: "old-image", chatId: "chat", userId: "owner" }, undefined);
    const items: TranscriptItem[] = [ { id: "c", kind: "tool_call", callId: shown.callId, name: shown.name, arguments: "{}" },
      { id: "r", kind: "tool_result", callId: shown.callId, name: shown.name, outcome: "complete", output: JSON.stringify(json(shown)) } ];
    const target = { model: "fake", provider: "fake" };
    const history = projectTranscript(items, target, { images: viewer.images });
    expect(history[1]).toMatchObject({ type: "tool_result", images: [{ data: Buffer.from("synthetic pixels").toString("base64") }] });
    expect(contextItemTokens(items[1]!, target, () => 1, "opaque", undefined, viewer.images)).toBeGreaterThan(100);
    expect(projectTranscript(items, target)[1]).not.toHaveProperty("images");
    expect(viewer.images.attached({ ...(items[1] as Extract<TranscriptItem, { kind: "tool_result" }>), output: "Another file's result" }))
      .toBeUndefined();
    expect(JSON.stringify(items)).not.toContain(Buffer.from("synthetic pixels").toString("base64"));
    expect(budget.usage().heldBytes).toBeGreaterThan(0);
    finish(); await runEnded;
    expect(viewer.images.attached(items[1] as Extract<TranscriptItem, { kind: "tool_result" }>)).toBeUndefined();
    expect(budget.usage().heldBytes).toBe(0);
  });

  it("names an animated GIF's preview as its first frame", async () => {
    const readImage = vi.fn(async () => ({ bytes: Buffer.from("synthetic frame"), mimeType: "image/png" as const, width: 4, height: 3, frames: 12 }));
    const base = request();
    const { tool: viewer } = tool({ ...file, kind: "image" }, { request: request({ modelCapabilities: { ...base.modelCapabilities, vision: true } }),
      readImage, resultImages: true });
    const shown = await viewer.execute(call({ attachment_id: "old-image" }), 1);
    expect(JSON.stringify(json(shown))).toContain("Image preview of the first frame of an animated GIF with 12 frames.");
  });

  it("refuses an image on a nonvision model without reading pixels", async () => {
    const readImage = vi.fn();
    const { tool: reader } = tool({ ...file, kind: "image" }, { readImage, resultImages: true });
    expect(json(await reader.execute(call({ attachment_id: "old-image" }), 1)).error).toBe("chat_image_unavailable");
    expect(readImage).not.toHaveBeenCalled();
  });

  it("refuses an image to a vision model whose route carries no result image, without reading pixels", async () => {
    const readImage = vi.fn();
    const base = request();
    const { tool: reader } = tool({ ...file, kind: "image" }, { readImage,
      request: request({ modelCapabilities: { ...base.modelCapabilities, vision: true } }) });
    expect(json(await reader.execute(call({ attachment_id: "old-image" }), 1)).error).toBe("chat_image_unavailable");
    expect(readImage).not.toHaveBeenCalled();
  });
});

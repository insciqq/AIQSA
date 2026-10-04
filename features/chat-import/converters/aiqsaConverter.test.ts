// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatArchiveManifest, ChatExportDocument } from "@/lib/contracts/chatExport";
import { buildTarGz, buildZip } from "../archive/archive.testFixtures";
import { openImportFile, type ImportFile } from "../importFile";
import { AIQSA_DOCUMENT_MAX_BYTES, createAiqsaConverter } from "./aiqsaConverter";
import type { ImportConverterEvent } from "./converterTypes";

/** Keys in the order AIQSA writes them: the format first. */
function exportDocument(title: string, overrides: Partial<ChatExportDocument["chat"]> = {}): ChatExportDocument {
  return {
    format: "aiqsa.chat",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chat: {
      activeLeafId: "m4",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { attachments: [{ byteSize: 10, mimeType: "image/png", name: "photo_1.png" }], createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: "Look at this" },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "m2", model: { modelId: "first-model", provider: "openai" }, parentId: "m1", role: "assistant", status: "complete", text: "A cat" },
        { createdAt: "2026-09-01T10:02:00.000Z", id: "m3", parentId: "m1", role: "assistant", status: "cancelled", text: "Partial" },
        { createdAt: "2026-09-01T10:03:00.000Z", id: "m4", model: { modelId: "second-model", provider: "openai" }, parentId: "m3", role: "assistant", status: "complete", text: "Regenerated" }
      ],
      pinned: true,
      title,
      updatedAt: "2026-09-02T10:00:00.000Z",
      ...overrides
    }
  };
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function manifest(paths: readonly string[]): ChatArchiveManifest {
  return {
    format: "aiqsa.chat-archive",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chats: paths.map((path, index) => ({
      archived: false,
      markdownPath: path.replace(/\.json$/u, ".md"),
      path,
      title: `Listed ${index + 1}`,
      updatedAt: "2026-09-02T10:00:00.000Z"
    }))
  };
}

async function file(content: BlobPart, name: string): Promise<ImportFile> {
  return openImportFile(new File([content], name));
}

async function events(files: readonly ImportFile[]): Promise<ImportConverterEvent[]> {
  const converter = createAiqsaConverter();
  const detection = await converter.detect(files);
  const output: ImportConverterEvent[] = [];
  for await (const event of converter.convert(detection.claimed)) output.push(event);
  return output;
}

describe("AIQSA converter", () => {
  it("turns a single-chat export into a v1 document with attachment notes and a source model label", async () => {
    const output = await events([await file(pretty(exportDocument("Cats")), "cats.json")]);
    expect(output.filter((event) => event.type !== "chat")).toEqual([
      { chats: 1, type: "total" },
      { count: 1, kind: "attachment", type: "skipped" }
    ]);
    const chat = output.find((event) => event.type === "chat");
    if (chat?.type !== "chat") throw new Error("no chat");
    expect(chat.chat).toMatchObject({ source: "AIQSA", sourceModel: "second-model" });
    expect(chat.chat.sourceKey).toBeUndefined();
    expect(chat.chat.document.chat.messages.map((message) => message.text)).toEqual([
      "Look at this\n\n_[Attachment not imported: photo\\_1.png]_", "A cat", "Partial", "Regenerated"
    ]);
    expect(chat.chat.document.chat.messages.every((message) => !("model" in message) && !("attachments" in message))).toBe(true);
    expect(chat.chat.document.chat).toMatchObject({ activeLeafId: "m4", pinned: true, title: "Cats" });
  });

  it("says how an answer without text ended, since imported messages are stored complete", async () => {
    const base = exportDocument("Endings");
    const messages = base.chat.messages.map((message) =>
      message.id === "m3" ? { ...message, text: "" } : message.id === "m2" ? { ...message, status: "error" as const, text: " " } : message);
    const output = await events([await file(pretty({ ...base, chat: { ...base.chat, messages } }), "endings.json")]);
    const chat = output.find((event) => event.type === "chat");
    if (chat?.type !== "chat") throw new Error("no chat");
    expect(chat.chat.document.chat.messages.map((message) => message.text)).toEqual([
      "Look at this\n\n_[Attachment not imported: photo\\_1.png]_", "_[Answer failed]_", "_[Answer stopped before any text]_", "Regenerated"
    ]);
  });

  it("imports a bulk tar.gz through its manifest, reading only listed documents", async () => {
    const empty = exportDocument("Empty", { activeLeafId: null, messages: [] });
    const archive = await buildTarGz([
      { content: pretty(manifest(["a.json", "archived/b.json", "missing.json", "broken.json", "empty.json"])), path: "manifest.json" },
      { content: "# A", path: "a.md" },
      { content: pretty(exportDocument("Chat A")), path: "a.json" },
      { content: pretty(exportDocument("Chat B", { archived: true })), path: "archived/b.json" },
      { content: "{ not json", path: "broken.json" },
      { content: pretty(empty), path: "empty.json" },
      { content: pretty(exportDocument("Unlisted")), path: "unlisted.json" }
    ]);
    const output = await events([await file(archive, "aiqsa-chats.tar.gz")]);
    expect(output[0]).toEqual({ chats: 5, type: "total" });
    const chats = output.flatMap((event) => event.type === "chat" ? [event.chat.document.chat.title] : []);
    expect(chats).toEqual(["Chat A", "Chat B"]);
    expect(output.filter((event) => event.type === "failed")).toEqual([
      { reason: "file_unreadable", title: "Listed 4", type: "failed" },
      { reason: "missing_from_archive", title: "Listed 3", type: "failed" }
    ]);
    expect(output).toContainEqual({ count: 1, kind: "empty_chat", type: "skipped" });
  });

  it("finds the manifest in a folder of a zip and reports damaged documents by their code", async () => {
    const invalid = { ...exportDocument("Bad"), version: 7 };
    const zip = await buildZip([
      { content: pretty(manifest(["chat.json", "bad.json"])), path: "export-folder/manifest.json" },
      { content: pretty(exportDocument("Zipped")), path: "export-folder/chat.json" },
      { content: pretty(invalid), path: "export-folder/bad.json" }
    ]);
    const output = await events([await file(zip, "export.zip")]);
    expect(output.flatMap((event) => event.type === "chat" ? [event.chat.document.chat.title] : [])).toEqual(["Zipped"]);
    expect(output).toContainEqual({ reason: "chat_export_version_unsupported", title: "Bad", type: "failed" });
  });

  it("reports a document too large to send as too large without reading it", async () => {
    const huge = new Uint8Array(AIQSA_DOCUMENT_MAX_BYTES + 1).fill(0x20);
    huge.set(new TextEncoder().encode("{\"format\":\"aiqsa.chat\",\"version\":1,"));
    const output = await events([await file(huge, "huge.json")]);
    expect(output).toEqual([{ chats: 1, type: "total" }, { reason: "too_large", title: "huge.json", type: "failed" }]);
  });

  it("claims only AIQSA files and explains what it cannot import", async () => {
    const converter = createAiqsaConverter();
    const documentFile = await file(pretty(exportDocument("Doc")), "doc.json");
    const { chat, ...rest } = exportDocument("Sorted keys");
    const reordered = await file(JSON.stringify({ chat, ...rest }), "sorted.json");
    const manifestFile = await file(pretty(manifest(["a.json"])), "manifest.json");
    const chatgptLike = await file(await buildZip([{ content: "[]", path: "conversations.json" }]), "chatgpt.zip");
    const plainTar = await file(await buildTarGz([{ content: "x", path: "x.txt" }]), "other.tar.gz");
    const foreignJson = await file("[{\"mapping\":{}}]", "conversations.json");
    const damaged = await file(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "damaged.zip");
    const bomb = await file(await buildTarGz([{ content: new Uint8Array(8 * 1_024 * 1_024), path: "zeros.bin" }]), "bomb.tar.gz");
    const detection = await converter.detect([documentFile, reordered, manifestFile, chatgptLike, plainTar, foreignJson, damaged, bomb]);
    expect(detection.claimed).toEqual([documentFile, reordered]);
    expect(detection.refused?.map((refusal) => [refusal.file.name, refusal.reason, refusal.message ?? null])).toEqual([
      ["manifest.json", "unsupported_file", "This is the index of a bulk export. Pick the .tar.gz archive itself."],
      ["other.tar.gz", "unsupported_file", null],
      ["damaged.zip", "archive_invalid", null],
      ["bomb.tar.gz", "archive_ratio_exceeded", null]
    ]);
  });
});

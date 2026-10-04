// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatExportDocument } from "@/lib/contracts/chatExport";
import { decodeChatImportRequestItems } from "@/lib/contracts/chatImport";
import type { ChatImportConverter, ConvertedChat, ImportConverterEvent } from "./converters/converterTypes";
import type { ImportFile } from "./importFile";
import { importBatches, utf8ByteLength, type ImportBatch } from "./importPipeline";

const now = () => new Date("2026-10-05T12:00:00.000Z");

function fakeFile(name: string): ImportFile {
  return {
    archive: () => Promise.reject(new Error("not an archive")),
    head: async () => "",
    kind: "json",
    name,
    size: 1,
    text: async () => ""
  };
}

function document(title: string, text = "Answer"): ChatExportDocument {
  return {
    chat: {
      activeLeafId: "a",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { createdAt: "2026-09-01T10:00:00.000Z", id: "q", parentId: null, role: "user", status: "complete", text: "Question" },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "a", parentId: "q", role: "assistant", status: "complete", text }
      ],
      pinned: false,
      title,
      updatedAt: "2026-09-02T10:00:00.000Z"
    },
    exportedAt: "2026-10-01T00:00:00.000Z",
    format: "aiqsa.chat",
    version: 1
  };
}

/** A converter claiming the files whose names start with its prefix and emitting the given events. */
function converter(prefix: string, emitted: readonly ImportConverterEvent[], source: ConvertedChat["source"] = "CLAUDE"): ChatImportConverter {
  return {
    async *convert() {
      yield* emitted;
    },
    async detect(files) {
      return {
        claimed: files.filter((file) => file.name.startsWith(prefix)),
        refused: files.filter((file) => file.name === `${prefix}-index.json`)
          .map((file) => ({ file, message: "Pick the conversations file.", reason: "unsupported_file" as const }))
      };
    },
    source
  };
}

const chat = (title: string, text?: string, extra: Partial<ConvertedChat> = {}): ImportConverterEvent => ({
  chat: { document: document(title, text), source: "CLAUDE", sourceKey: `key-${title}`, ...extra },
  type: "chat"
});

async function collect(generator: AsyncGenerator<ImportBatch>): Promise<ImportBatch[]> {
  const output: ImportBatch[] = [];
  for await (const batch of generator) output.push(batch);
  return output;
}

function bodyTitles(batch: ImportBatch): string[] | null {
  if (!batch.body) return null;
  const items = decodeChatImportRequestItems(JSON.parse(batch.body)) as Array<{ document: ChatExportDocument }> | null;
  return items?.map((item) => item.document.chat.title) ?? null;
}

describe("import pipeline", () => {
  it("packs chats up to the chat count and byte limit, sends a large chat alone and never sends one too large", async () => {
    const small = (title: string) => chat(title);
    const events: ImportConverterEvent[] = [
      { chats: 7, type: "total" },
      small("one"), small("two"), small("three"), small("four"),
      // Fits a request alone (about 3.4 KB), never beside another chat.
      chat("large", "L".repeat(2_900)),
      chat("huge", "H".repeat(9_000)),
      small("five")
    ];
    const batches = await collect(importBatches([fakeFile("claude-export.zip")], {
      converters: [converter("claude", events)], maxBodyBytes: 3_500, maxChats: 3, now
    }));
    expect(batches.map(bodyTitles)).toEqual([["one", "two", "three"], ["four"], ["large"], ["five"]]);
    expect(batches.map((batch) => batch.done)).toEqual([false, false, false, true]);
    expect(batches.every((batch) => !batch.body || utf8ByteLength(batch.body) <= 3_500)).toBe(true);
    expect(batches.flatMap((batch) => batch.failed)).toEqual([{ reason: "too_large", title: "huge" }]);
    expect(batches.reduce((total, batch) => total + batch.totalDelta, 0)).toBe(7);
    expect(batches[2]!.sent).toEqual([{ messages: 2, title: "large" }]);
  });

  it("validates each chat as the server will and keeps source identity rules", async () => {
    const broken = document("broken");
    const events: ImportConverterEvent[] = [
      { chat: { document: { ...broken, chat: { ...broken.chat, activeLeafId: "missing" } }, source: "CLAUDE", sourceKey: "k" }, type: "chat" },
      { chat: { document: document("no key"), source: "CHATGPT" }, type: "chat" },
      { chat: { document: document("aiqsa"), source: "AIQSA", sourceKey: "ignored", sourceModel: "model-x" }, type: "chat" },
      { count: 2, kind: "image", type: "skipped" },
      { reason: "missing_from_archive", title: "gone", type: "failed" }
    ];
    const [batch] = await collect(importBatches([fakeFile("claude.zip")], { converters: [converter("claude", events)], now }));
    expect(batch!.failed).toEqual([
      { reason: "chat_export_active_leaf_missing", title: "broken" },
      { reason: "chat_import_item_invalid", title: "no key" },
      { reason: "missing_from_archive", title: "gone" }
    ]);
    expect(batch!.skipped).toEqual({ image: 2 });
    const items = decodeChatImportRequestItems(JSON.parse(batch!.body!)) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "AIQSA", sourceModel: "model-x" });
    expect(items[0]).not.toHaveProperty("sourceKey");
  });

  it("gives each file to the first converter that claims it and reports the rest", async () => {
    const first = converter("aiqsa", [chat("from first")]);
    const second = converter("claude", [chat("from second")]);
    const batches = await collect(importBatches(
      [fakeFile("claude-conversations.json"), fakeFile("aiqsa.json"), fakeFile("claude-index.json"), fakeFile("photo.png")],
      { converters: [first, second], now }
    ));
    expect(batches.flatMap((batch) => bodyTitles(batch) ?? [])).toEqual(["from first", "from second"]);
    expect(batches.flatMap((batch) => batch.failed)).toEqual([
      { file: true, message: "Pick the conversations file.", reason: "unsupported_file", title: "claude-index.json" },
      { file: true, reason: "unsupported_file", title: "photo.png" }
    ]);
  });

  it("flushes local outcomes so progress moves without sendable chats", async () => {
    const failures: ImportConverterEvent[] = ["a", "b", "c"].map((title) => ({ reason: "too_large", title, type: "failed" }));
    const batches = await collect(importBatches([fakeFile("claude.zip")], {
      converters: [converter("claude", [...failures, { count: 1, kind: "empty_chat", type: "skipped" }])], flushOutcomes: 2, now
    }));
    expect(batches.map((batch) => [batch.body, batch.failed.length, batch.skipped, batch.done])).toEqual([
      [null, 2, {}, false],
      [null, 1, { empty_chat: 1 }, false],
      [null, 0, {}, true]
    ]);
  });

  it("measures UTF-8 bytes like the request body", () => {
    for (const value of ["ascii", "héllo", "日本語", "emoji 🙂 pair", "lone \ud800 surrogate"]) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
  });
});

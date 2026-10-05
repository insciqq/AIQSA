// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeChatImportItem } from "@/lib/contracts/chatImport";
import type { ChatExportDocumentMessage } from "@/lib/contracts/chatExport";
import { buildZip } from "../archive/archive.testFixtures";
import type { ImportArchive } from "../archive/archiveTypes";
import { openImportFile, type ImportFile } from "../importFile";
import { importBatches } from "../importPipeline";
import {
  CLAUDE_CONVERSATIONS_MAX_BYTES,
  CLAUDE_EXPORT_INDEX_MESSAGE,
  CLAUDE_OTHER_PART_MESSAGE,
  createClaudeConverter
} from "./claudeConverter";
import {
  conversation,
  editedConversation,
  emptyConversation,
  exportIndex,
  message,
  olderConversation,
  regeneratedConversation,
  ROOT,
  text
} from "./claudeExport.testFixtures";
import type { ConvertedChat, ImportConverterEvent } from "./converterTypes";

const json = (value: unknown) => JSON.stringify(value);

async function file(content: BlobPart, name: string): Promise<ImportFile> {
  return openImportFile(new File([content], name));
}

/** The file with a record of every archive entry a converter selected for reading. */
function recordingFile(inner: ImportFile, selected: string[]): ImportFile {
  return {
    archive: async (): Promise<ImportArchive> => {
      const archive = await inner.archive();
      return {
        entries: (select) => archive.entries((info) => {
          const read = select(info);
          if (read) selected.push(info.path);
          return read;
        }),
        format: archive.format
      };
    },
    head: (maxBytes) => inner.head(maxBytes),
    kind: inner.kind,
    name: inner.name,
    size: inner.size,
    text: (maxBytes) => inner.text(maxBytes)
  };
}

async function run(files: readonly ImportFile[]) {
  const converter = createClaudeConverter();
  const detection = await converter.detect(files);
  const events: ImportConverterEvent[] = [];
  for await (const event of converter.convert(detection.claimed)) events.push(event);
  return { detection, events };
}

function chats(events: readonly ImportConverterEvent[]): ConvertedChat[] {
  return events.flatMap((event) => event.type === "chat" ? [event.chat] : []);
}

function skipped(events: readonly ImportConverterEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) if (event.type === "skipped") counts[event.kind] = (counts[event.kind] ?? 0) + event.count;
  return counts;
}

const shape = (messages: readonly ChatExportDocumentMessage[]) =>
  messages.map(({ createdAt, id, parentId, role }) => ({ createdAt, id, parentId, role }));

const allConversations = [editedConversation, regeneratedConversation, olderConversation, emptyConversation];

describe("Claude converter", () => {
  it("imports the conversations part of the multi-part export, reading only conversations.json", async () => {
    const zip = await buildZip([{ content: json(allConversations), path: "conversations.json" }]);
    const selected: string[] = [];
    const part = recordingFile(await file(zip, "conversations-000.zip"), selected);
    const { detection, events } = await run([part]);
    expect(detection.claimed).toEqual([part]);
    expect(events[0]).toEqual({ chats: 4, type: "total" });
    expect(chats(events).map((chat) => [chat.document.chat.title, chat.sourceKey, chat.sourceModel, chat.source])).toEqual([
      ["Edited first question", "conv-edited-0001", "Claude", "CLAUDE"],
      ["Regenerated answer", "conv-regen-0002", "Claude", "CLAUDE"],
      ["Untitled", "conv-older-0003", "Claude", "CLAUDE"]
    ]);
    expect(skipped(events)).toEqual({ artifact: 1, attachment: 2, empty_chat: 1, image: 1, missing_message: 1, tool: 6 });
    expect(new Set(selected)).toEqual(new Set(["conversations.json"]));
  });

  it("reads the older single zip without touching account data or projects", async () => {
    const zip = await buildZip([
      { content: json([{ email_address: "synthetic@example.invalid", full_name: "Synthetic" }]), path: "users.json" },
      { content: json([{ name: "Project", docs: [] }]), path: "projects.json" },
      { content: json([regeneratedConversation]), path: "data-2026/conversations.json" }
    ]);
    const selected: string[] = [];
    const { events } = await run([recordingFile(await file(zip, "data-2026.zip"), selected)]);
    expect(chats(events).map((chat) => chat.document.chat.title)).toEqual(["Regenerated answer"]);
    expect(new Set(selected)).toEqual(new Set(["data-2026/conversations.json"]));
  });

  it("keeps both roots of an edited first message and opens the newest branch", async () => {
    const { events } = await run([await file(json([editedConversation]), "conversations.json")]);
    const [chat] = chats(events);
    expect(shape(chat!.document.chat.messages)).toEqual([
      { createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user" },
      { createdAt: "2026-09-01T10:01:00.000Z", id: "m2", parentId: "m1", role: "assistant" },
      { createdAt: "2026-09-01T10:05:00.000Z", id: "m3", parentId: null, role: "user" },
      { createdAt: "2026-09-01T10:06:00.000Z", id: "m4", parentId: "m3", role: "assistant" }
    ]);
    expect(chat!.document.chat).toMatchObject({
      activeLeafId: "m4",
      archived: false,
      createdAt: "2026-09-01T10:00:00.000Z",
      pinned: false,
      updatedAt: "2026-09-01T12:00:00.000Z"
    });
  });

  it("keeps regenerated answers as sibling branches without duplicate turns", async () => {
    const { events } = await run([await file(json([regeneratedConversation]), "conversations.json")]);
    const [chat] = chats(events);
    expect(chat!.document.chat.messages.map(({ id, parentId, text: body }) => [id, parentId, body])).toEqual([
      ["m1", null, "Name a color."],
      ["m2", "m1", "Blue."],
      ["m3", "m2", "Another?"],
      ["m4", "m1", "Green."]
    ]);
    expect(chat!.document.chat.activeLeafId).toBe("m4");
  });

  it("links cited sources once per message, skips thinking and search, and notes every other tool and the artifact", async () => {
    const { events } = await run([await file(json([editedConversation]), "conversations.json")]);
    const texts = chats(events)[0]!.document.chat.messages.map((item) => item.text);
    expect(texts).toEqual([
      "What is the sky made of?",
      "Air is mostly nitrogen [example.org](https://www.example.org/sky). It also has oxygen. [example.net](https://example.net/air_%28gas%29)\n\nLater the same source again.",
      "What is the sea made of?\n\n_[Files not included in the Claude export: sea\\_photo.png, report.pdf]_",
      "Water, mostly.\n\n_[Tool activity not imported: bash\\_tool ×2, view, create\\_file, present\\_files, ask\\_user\\_input\\_v0]_\n\n_[Artifact not imported: Sea plan]_"
    ]);
    expect(texts.join("\n")).not.toMatch(/Private reasoning|Search result text|javascript:/u);
  });

  it("reattaches a message whose parent is missing to the previous message in time, never to its own child", async () => {
    const { events } = await run([await file(json([olderConversation]), "conversations.json")]);
    const [chat] = chats(events);
    expect(chat!.document.chat.messages.map(({ createdAt, id, parentId, text: body }) => [id, parentId, createdAt, body])).toEqual([
      ["m1", null, "2026-08-01T09:00:00.000Z", "Summarize my notes.\n\n_[File not included in the Claude export: notes.txt]_"],
      ["m2", "m1", "2026-08-01T09:01:00.000Z", "They are short."],
      ["m3", "m2", "2026-08-01T09:10:00.000Z", "And then?\n\n_[Earlier message not included in the Claude export]_"],
      // Dated before its question: moved to the question's time.
      ["m4", "m3", "2026-08-01T09:10:00.000Z", "_[Empty message]_"]
    ]);
    expect(JSON.stringify(chat)).not.toContain("EXTRACTED-BODY-NOT-IMPORTED");
    expect(skipped(events)).toEqual({ attachment: 1, missing_message: 1 });
  });

  it("chains a conversation without any parent fields in time order and treats absent parents as roots otherwise", async () => {
    const legacy = conversation("conv-legacy", "Legacy", [
      message({ at: "2026-07-01T10:01:00Z", content: [text("Answer")], sender: "assistant", uuid: "l-a1" }),
      message({ at: "2026-07-01T10:00:00Z", content: [text("Question")], uuid: "l-h1" })
    ]);
    const mixed = conversation("conv-mixed", "Mixed", [
      message({ at: "2026-07-01T10:00:00Z", content: [text("One")], uuid: "x-1" }),
      message({ at: "2026-07-01T10:01:00Z", content: [text("Two")], parent: ROOT, uuid: "x-2" })
    ]);
    const { events } = await run([await file(json([legacy, mixed]), "conversations.json")]);
    const [first, second] = chats(events);
    expect(first!.document.chat.messages.map(({ id, parentId, text: body }) => [id, parentId, body])).toEqual([
      ["m1", null, "Question"], ["m2", "m1", "Answer"]
    ]);
    expect(second!.document.chat.messages.map(({ parentId }) => parentId)).toEqual([null, null]);
    expect(second!.document.chat.activeLeafId).toBe("m2");
  });

  it("produces chats the import contract accepts", async () => {
    const converter = createClaudeConverter();
    const now = () => new Date("2026-10-05T00:00:00.000Z");
    const bodies: string[] = [];
    for await (const batch of importBatches([await file(json(allConversations), "conversations.json")], {
      accountId: "account-1", converters: [converter], now
    })) {
      expect(batch.failed).toEqual([]);
      if (batch.body) bodies.push(batch.body);
    }
    const items = bodies.flatMap((body) => (JSON.parse(body) as { chats: unknown[] }).chats);
    expect(items).toHaveLength(3);
    for (const item of items) expect(decodeChatImportItem(item, now()).ok).toBe(true);
  });

  it("refuses a lone export index with what to download, and stays quiet about it beside the conversations part", async () => {
    const index = await file(`${JSON.stringify(exportIndex, null, 2)}\n`, "claude.json");
    const alone = await run([index]);
    expect(alone.detection.claimed).toEqual([]);
    expect(alone.detection.refused).toEqual([{ file: index, message: CLAUDE_EXPORT_INDEX_MESSAGE, reason: "unsupported_file" }]);
    expect(alone.events).toEqual([]);

    const part = await file(await buildZip([{ content: json([regeneratedConversation]), path: "conversations.json" }]), "conversations-000.zip");
    const together = await run([index, part]);
    expect(together.detection.refused).toEqual([]);
    expect(together.events.filter((event) => event.type !== "chat")).toEqual([{ chats: 1, type: "total" }]);
    expect(chats(together.events)).toHaveLength(1);
  });

  it("explains other parts of the export and leaves foreign files to other converters", async () => {
    const metadata = await file(await buildZip([
      { content: "[]", path: "users.json" }, { content: "[]", path: "login_history.json" }
    ]), "light_metadata-000.zip");
    const frames = await file(await buildZip([{ content: "<p>v1</p>", path: "artifacts/a1/versions/1/index.html" }]), "frames-000.zip");
    const projects = await file(await buildZip([{ content: "{}", path: "projects/p1.json" }]), "projects-000.zip");
    const chatgpt = await file(await buildZip([
      { content: "[{\"mapping\":{}}]", path: "conversations.json" }, { content: "<html></html>", path: "chat.html" }
    ]), "chatgpt.zip");
    const chatgptJson = await file("[{\"title\":\"x\",\"mapping\":{}}]", "conversations.json");
    const escaped = await file(json([{ title: "\"chat_messages\": in a string", mapping: {} }]), "other.json");
    const damaged = await file(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "damaged.zip");
    const { detection } = await run([metadata, frames, projects, chatgpt, chatgptJson, escaped, damaged]);
    expect(detection.claimed).toEqual([]);
    expect(detection.refused?.map((refusal) => [refusal.file.name, refusal.reason, refusal.message ?? null])).toEqual([
      ["light_metadata-000.zip", "unsupported_file", CLAUDE_OTHER_PART_MESSAGE],
      ["frames-000.zip", "unsupported_file", CLAUDE_OTHER_PART_MESSAGE],
      ["projects-000.zip", "unsupported_file", CLAUDE_OTHER_PART_MESSAGE],
      ["damaged.zip", "archive_invalid", null]
    ]);
  });

  it("claims an older zip of an account without chats and imports nothing", async () => {
    const zip = await file(await buildZip([
      { content: "[]", path: "conversations.json" }, { content: "[]", path: "users.json" }, { content: "[]", path: "projects.json" }
    ]), "data-empty.zip");
    const { detection, events } = await run([zip]);
    expect(detection.claimed).toEqual([zip]);
    expect(events).toEqual([{ chats: 0, type: "total" }]);
  });

  it("reports malformed conversations by name and keeps the others", async () => {
    const duplicate = conversation("conv-dup", "Duplicate ids", [
      message({ at: "2026-07-01T10:00:00Z", content: [text("A")], parent: ROOT, uuid: "same" }),
      message({ at: "2026-07-01T10:01:00Z", content: [text("B")], parent: "same", uuid: "same" })
    ]);
    const cycle = conversation("conv-cycle", "Cycle", [
      message({ at: "2026-07-01T10:00:00Z", content: [text("A")], parent: "c-2", uuid: "c-1" }),
      message({ at: "2026-07-01T10:01:00Z", content: [text("B")], parent: "c-1", uuid: "c-2" })
    ]);
    const badSender = conversation("conv-bad", "Bad sender", [{ ...message({ at: "2026-07-01T10:00:00Z", uuid: "b-1" }), sender: "system" }]);
    const { events } = await run([await file(json([duplicate, cycle, badSender, regeneratedConversation, 7]), "conversations.json")]);
    expect(events.filter((event) => event.type === "failed")).toEqual([
      { reason: "chat_export_message_id_duplicate", title: "Duplicate ids", type: "failed" },
      { reason: "chat_export_tree_cycle", title: "Cycle", type: "failed" },
      { reason: "chat_export_shape_invalid", title: "Bad sender", type: "failed" },
      { reason: "chat_export_shape_invalid", title: "Untitled", type: "failed" }
    ]);
    expect(chats(events).map((chat) => chat.document.chat.title)).toEqual(["Regenerated answer"]);
  });

  it("bounds the conversations file before reading it", async () => {
    const huge: ImportFile = {
      archive: () => Promise.reject(new Error("not an archive")),
      head: () => Promise.resolve("[{\"uuid\":\"x\",\"chat_messages\":[]}"),
      kind: "json",
      name: "conversations.json",
      size: CLAUDE_CONVERSATIONS_MAX_BYTES + 1,
      text: () => Promise.reject(new Error("read past the bound"))
    };
    const { events } = await run([huge]);
    expect(events).toEqual([{ file: true, message: expect.stringContaining("256 MB") as unknown, reason: "too_large", title: "conversations.json", type: "failed" }]);
  });
});

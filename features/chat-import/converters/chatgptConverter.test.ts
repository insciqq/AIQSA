// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildZip, type ZipFixtureEntry } from "../archive/archive.testFixtures";
import { openImportFile, type ImportFile } from "../importFile";
import { importBatches, type ImportBatch } from "../importPipeline";
import {
  branchedConversation,
  citationsConversation,
  claudeLikeConversations,
  emptyConversation,
  exportManifest,
  legacyBranchConversation,
  legacyToolConversation,
  multimodalConversation
} from "./chatgpt.testFixtures";
import {
  createChatGptConverter,
  jsonArrayItems,
  startsWithChatGptConversation
} from "./chatgptConverter";
import type { ImportConverterEvent } from "./converterTypes";
import { createChatImportConverters } from "./registry";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const json = (value: unknown) => JSON.stringify(value, null, 2);
const encoder = new TextEncoder();

/**
 * Entries a converter must never read: a damaged CRC makes any read fail
 * with `archive_entry_damaged`.
 */
const UNREAD: readonly ZipFixtureEntry[] = [
  "chat.html",
  "user.json",
  "user_settings.json",
  "ads.json",
  "library_files.json",
  "shared_conversations.json",
  "conversation_asset_file_names.json",
  "file_00000000abc-photo.dat"
].map((path) => ({ content: `${path} must stay compressed`, declaredCrc: 1, path }));

async function file(content: BlobPart, name: string): Promise<ImportFile> {
  return openImportFile(new File([content], name));
}

async function zipFile(entries: readonly ZipFixtureEntry[], name = "chatgpt-export.zip"): Promise<ImportFile> {
  return openImportFile(new File([await buildZip(entries)], name));
}

async function events(files: readonly ImportFile[], conversationMaxBytes?: number) {
  const converter = createChatGptConverter({ now: () => NOW, ...(conversationMaxBytes ? { conversationMaxBytes } : {}) });
  const detection = await converter.detect(files);
  const output: ImportConverterEvent[] = [];
  for await (const event of converter.convert(detection.claimed)) output.push(event);
  return { detection, output };
}

async function batches(files: readonly ImportFile[]): Promise<ImportBatch[]> {
  const steps: ImportBatch[] = [];
  for await (const step of importBatches(files, { accountId: "account-1", converters: createChatImportConverters(), now: () => NOW })) {
    steps.push(step);
  }
  return steps;
}

function summary(steps: readonly ImportBatch[]) {
  const skipped: Record<string, number> = {};
  for (const step of steps) {
    for (const [kind, count] of Object.entries(step.skipped)) skipped[kind] = (skipped[kind] ?? 0) + count;
  }
  return {
    failed: steps.flatMap((step) => step.failed),
    sent: steps.flatMap((step) => step.sent.map((chat) => chat.title)),
    skipped,
    total: steps.reduce((total, step) => total + step.totalDelta, 0)
  };
}

function sentItems(steps: readonly ImportBatch[]) {
  return steps.flatMap((step) => step.body ? (JSON.parse(step.body) as { chats: Array<Record<string, unknown>> }).chats : []);
}

describe("ChatGPT export reading", () => {
  it("imports a sharded zip through the pipeline, reading only the manifest and the listed shards", async () => {
    const zip = await zipFile([
      { content: json(exportManifest(["conversations-000.json", "conversations-001.json"])), path: "export_manifest.json" },
      ...UNREAD.slice(0, 4),
      { content: json([branchedConversation(), emptyConversation()]), path: "conversations-000.json" },
      ...UNREAD.slice(4),
      { content: json([multimodalConversation(), citationsConversation()]), path: "conversations-001.json" }
    ]);
    const steps = await batches([zip]);
    expect(summary(steps)).toEqual({
      failed: [],
      sent: ["Branches", "Untitled", "Citations"],
      skipped: { attachment: 1, audio: 2, empty_chat: 1, image: 2 },
      total: 4
    });
    const items = sentItems(steps);
    expect(items.map((item) => [item.source, item.sourceKey, item.sourceModel])).toEqual([
      ["CHATGPT", "conv-branches", "gpt-synthetic"],
      ["CHATGPT", "conv-media", undefined],
      ["CHATGPT", "conv-citations", "gpt-synthetic-search"]
    ]);
    expect(steps.map((step) => step.body ?? "").join("")).not.toMatch(/[\ue200-\ue2ff]/u);
  });

  it("imports a legacy single conversations.json zip, also inside a folder", async () => {
    const zip = await zipFile([
      { content: "x", declaredCrc: 1, path: "export/chat.html" },
      { content: json([legacyToolConversation(), legacyBranchConversation()]), path: "export/conversations.json" },
      { content: "x", declaredCrc: 1, path: "export/user.json" }
    ]);
    const steps = await batches([zip]);
    expect(summary(steps)).toEqual({ failed: [], sent: ["Legacy tools", "Legacy branch"], skipped: { image: 1 }, total: 2 });
  });

  it("imports conversation files picked directly, with or without the export index", async () => {
    const shard = await file(json([branchedConversation()]), "conversations-000.json");
    const index = await file(json(exportManifest(["conversations-000.json"])), "export_manifest.json");
    expect(summary(await batches([shard, index]))).toMatchObject({ failed: [], sent: ["Branches"], total: 1 });
    const legacy = await file(json([legacyBranchConversation()]), "conversations.json");
    expect(summary(await batches([legacy]))).toMatchObject({ failed: [], sent: ["Legacy branch"], total: 1 });
  });

  it("refuses the export index alone with what to pick instead", async () => {
    const index = await file(json(exportManifest(["conversations-000.json"])), "export_manifest.json");
    expect(summary(await batches([index])).failed).toEqual([{
      file: true,
      message: "This is the index of a ChatGPT export. Pick the .zip itself or its conversations JSON files.",
      reason: "unsupported_file",
      title: "export_manifest.json"
    }]);
  });

  it("leaves Claude's conversations.json and other arrays to other converters", async () => {
    const claude = await zipFile([{ content: json(claudeLikeConversations()), path: "conversations.json" }], "claude.zip");
    const loose = await file(json(claudeLikeConversations()), "conversations.json");
    const empty = await file("[]", "conversations.json");
    const { detection } = await events([claude, loose, empty]);
    expect(detection).toEqual({ claimed: [], refused: [] });
  });

  it("reports a listed shard missing from the archive and malformed conversations by title", async () => {
    const broken = `[${json(branchedConversation())},\n{"title": "Broken \\"one\\"", "mapping": {,}},\n{"id": "no-mapping", "title": "Shapeless"}\n]`;
    const zip = await zipFile([
      { content: json(exportManifest(["conversations-000.json", "conversations-001.json"])), path: "export_manifest.json" },
      { content: broken, path: "conversations-000.json" }
    ]);
    const { output } = await events([zip]);
    expect(output.filter((event) => event.type !== "chat")).toEqual([
      { chats: 3, type: "total" },
      { reason: "chat_export_shape_invalid", title: "Broken \"one\"", type: "failed" },
      { reason: "chat_export_shape_invalid", title: "Shapeless", type: "failed" },
      { file: true, reason: "missing_from_archive", title: "conversations-001.json", type: "failed" }
    ]);
    expect(output.filter((event) => event.type === "chat")).toHaveLength(1);
  });

  it("reports an oversized conversation by its title without parsing it", async () => {
    const big = `[{"title": "Huge", "mapping": {}, "pad": "${"x".repeat(3 * 1_024 * 1_024)}"}, ${json(legacyBranchConversation())}]`;
    const { output } = await events([await file(big, "conversations-002.json")], 2 * 1_024 * 1_024);
    expect(output.filter((event) => event.type !== "chat")).toEqual([
      { chats: 2, type: "total" },
      { message: "The conversation is larger than 2 MB", reason: "too_large", title: "Huge", type: "failed" }
    ]);
    expect(output.filter((event) => event.type === "chat")).toHaveLength(1);
  });
});

describe("ChatGPT export scanning", () => {
  it("finds a conversation array by the first item's own mapping key", () => {
    expect(startsWithChatGptConversation("\ufeff [ {\"title\": \"a, [b]\", \"mapping\": {")).toBe(true);
    expect(startsWithChatGptConversation("[{\"title\": \"mapping\", \"x\": {\"mapping\": 1}, \"uuid\": 1}, {\"mapping\": {}}]")).toBe(false);
    expect(startsWithChatGptConversation("{\"mapping\": {}}")).toBe(false);
    expect(startsWithChatGptConversation("[]")).toBe(false);
    expect(startsWithChatGptConversation("[{\"title\": \"unterminated")).toBe(false);
  });

  it("splits a top-level array into items without parsing it", () => {
    const source = "\ufeff[ {\"a\": \"x],\\\"{\"}, [1, {\"b\": 2}] ,\"s,\" , 3 ]trailing";
    const bytes = encoder.encode(source);
    const items = jsonArrayItems(bytes)!.map(([start, end]) => new TextDecoder().decode(bytes.subarray(start, end)).trim());
    expect(items).toEqual(["{\"a\": \"x],\\\"{\"}", "[1, {\"b\": 2}]", "\"s,\"", "3"]);
    expect(jsonArrayItems(encoder.encode(" [ ] "))).toEqual([]);
    expect(jsonArrayItems(encoder.encode("{\"a\": 1}"))).toBeNull();
    const unterminated = encoder.encode("[{\"a\": 1}, {\"b\"");
    expect(jsonArrayItems(unterminated)!.map(([start, end]) => new TextDecoder().decode(unterminated.subarray(start, end)).trim()))
      .toEqual(["{\"a\": 1}", "{\"b\""]);
  });
});

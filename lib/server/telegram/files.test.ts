import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, telegramPhotoFixture } from "@/tests/support/fakeTelegramBotApi";
import type { ThreadArtifactSummary } from "../../contracts/chats";
import failureCodes from "../observability/failureCodes.json";
import type { StorageAdapter } from "../uploads/storage";
import { createTelegramBotApi, createTelegramPacer } from "./botApi";
import type { TelegramRunEventContext } from "./bridge/events";
import type { TelegramAccessDecision } from "./control/access";
import { TELEGRAM_COPY } from "./copy";
import type { TelegramBotSession } from "./dispatcher";
import {
  cleanTelegramFileName, createPrismaTelegramFileReader, createPrismaTelegramRunExportReader, createTelegramRunFiles, deliverTelegramFiles,
  planTelegramFiles, TELEGRAM_DOCUMENT_MAX_BYTES, TELEGRAM_FILE_LOG_CODES, TELEGRAM_FILE_NAME_MAX_LENGTH, TELEGRAM_FILES_EXPORT_WAIT_MS,
  TELEGRAM_PHOTO_MAX_BYTES, telegramAnswerFiles, type TelegramAnswerFile, type TelegramRunExport
} from "./files";
import { createTelegramOutbound } from "./outbound";
import type { TelegramLinkRecord } from "./store/links";
import type { TelegramMessageRef } from "./store/messageRefs";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const MB = 1024 * 1024;
const OWNER = { chatId: "chat-1", linkId: "link-1", userId: "user-1" } as const;

function file(attachmentId: string, fileName: string, mimeType: string, byteSize = 64): TelegramAnswerFile {
  return { attachmentId, byteSize, fileName, mimeType };
}

/** The real Bot API client and outbound against the fake, with in-memory bytes behind the reader. */
function setup() {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport: fake.transport });
  const refs: TelegramMessageRef[] = [];
  const outbound = createTelegramOutbound({
    api, appBaseUrl: "https://aiqsa.example", botId: fake.bot.id, callbacks: { create: async () => [] },
    messageRefs: { record: async (entries) => { refs.push(...entries); } }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const bytes = new Map<string, Buffer>();
  const reads: Array<Readonly<{ attachmentId: string; maxBytes: number; userId: string }>> = [];
  const read = vi.fn(async (input: Readonly<{ attachmentId: string; maxBytes: number; userId: string }>) => {
    reads.push(input);
    return bytes.get(input.attachmentId) ?? null;
  });
  return { bytes, fake, outbound, read, reads, refs, session, user };
}

describe("Telegram answer files: which go and how", () => {
  it("sends at most ten files: images up to 10 MB as photos, the rest up to 50 MB as documents", () => {
    const files = [
      file("jpeg", "chart.jpg", "image/jpeg"), file("png", "plot.png", "image/png"), file("webp", "pic.webp", "image/webp"),
      file("big-image", "scan.png", "image/png", TELEGRAM_PHOTO_MAX_BYTES + 1), file("gif", "anim.gif", "image/gif"),
      file("pdf", "report.pdf", "application/pdf", TELEGRAM_DOCUMENT_MAX_BYTES), file("huge", "dump.bin", "application/octet-stream",
        TELEGRAM_DOCUMENT_MAX_BYTES + 1), file("empty", "empty.txt", "text/plain", 0),
      ...Array.from({ length: 6 }, (_, index) => file(`text-${index}`, `notes-${index}.txt`, "text/plain"))
    ];
    const plan = planTelegramFiles(files);
    expect(plan.items.map((item) => [item.file.attachmentId, item.kind])).toEqual([
      ["jpeg", "photo"], ["png", "photo"], ["webp", "photo"], ["big-image", "document"], ["gif", "document"], ["pdf", "document"],
      ["text-0", "document"], ["text-1", "document"], ["text-2", "document"], ["text-3", "document"]
    ]);
    expect(plan.left).toBe(4);
  });

  it("lists an answer's generated images, then its files, each once", () => {
    const summary = {
      generatedFiles: [
        { attachmentId: "file-1", byteSize: 10, fileName: "a.csv", mimeType: "text/csv", relativePath: "outputs/a.csv" },
        { attachmentId: "image-1", byteSize: 20, fileName: "b.png", mimeType: "image/png", relativePath: "outputs/b.png" }
      ],
      generatedImages: [{ attachmentId: "image-1", byteSize: 20, fileName: "b.png", height: 1, mimeType: "image/png" as const,
        sourceAttachmentIds: [], width: 1 }]
    } satisfies Pick<ThreadArtifactSummary, "generatedFiles" | "generatedImages">;
    expect(telegramAnswerFiles(summary).map((entry) => entry.attachmentId)).toEqual(["image-1", "file-1"]);
    expect(telegramAnswerFiles(null)).toEqual([]);
  });

  it.each([
    ["reports/2026/Q3 report.pdf", "application/pdf", "Q3 report.pdf"],
    ["..\\..\\evil‮txt.exe", "application/octet-stream", "eviltxt.exe"],
    ["a\"b*c:d<e>f?g|h.txt", "text/plain", "a_b_c_d_e_f_g_h.txt"],
    ["  ...hidden \n notes.md  ", "text/markdown", "hidden notes.md"],
    ["\u0000\u0007​", "image/png", "file.png"],
    ["", "application/x-unknown", "file"],
    ["....", "application/pdf", "file.pdf"]
  ])("cleans the shown name %j", (name, mimeType, expected) => {
    expect(cleanTelegramFileName(name, mimeType)).toBe(expected);
  });

  it("bounds a long name by characters, keeping its extension and whole characters", () => {
    const long = cleanTelegramFileName(`${"report ".repeat(60)}.csv`, "text/csv");
    expect(long.length).toBeLessThanOrEqual(TELEGRAM_FILE_NAME_MAX_LENGTH);
    expect(long.endsWith(".csv")).toBe(true);
    const emoji = cleanTelegramFileName(`${"😀".repeat(200)}.txt`, "text/plain");
    expect(Array.from(emoji)).toHaveLength(TELEGRAM_FILE_NAME_MAX_LENGTH);
    expect(emoji.endsWith("😀.txt")).toBe(true);
  });
});

describe("Telegram answer files: bytes through the owner's download authority", () => {
  type Row = { byteSize: number; fileName: string; id: string; mimeType: string; projectId: string | null; status: string; storageKey: string;
    userId: string | null };

  function reader(rows: readonly Row[], objects: Map<string, Buffer>, options: Readonly<{ failStorage?: boolean }> = {}) {
    const tx = {
      attachment: {
        findUnique: async ({ where }: { where: { id: string; status: string } }) => {
          const row = rows.find((candidate) => candidate.id === where.id && candidate.status === where.status);
          return row ? { ...row } : null;
        }
      }
    };
    const prisma = { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
    const getObject = vi.fn(async (storageKey: string, read?: { maxBytes?: number }) => {
      if (options.failStorage) throw new Error("synthetic storage outage");
      const body = objects.get(storageKey);
      if (!body) throw new Error("missing object");
      if (read?.maxBytes !== undefined && body.length > read.maxBytes) throw new Error("too large");
      return { body, contentType: "application/octet-stream", storageKey };
    });
    return { getObject, read: createPrismaTelegramFileReader({ prisma, storage: () => ({ getObject }) as unknown as StorageAdapter }) };
  }

  const owned: Row = {
    byteSize: 5, fileName: "report.txt", id: "attachment-1", mimeType: "text/plain", projectId: null, status: "ready", storageKey: "object-1",
    userId: "user-1"
  };

  it("reads only a ready file of the user's own, within the bound and its recorded size", async () => {
    const objects = new Map([["object-1", Buffer.from("bytes")], ["object-2", Buffer.from("longer than recorded")]]);
    const { read } = reader([owned, { ...owned, id: "processing", status: "processing" }, { ...owned, id: "resized", storageKey: "object-2" }],
      objects);
    expect(await read({ attachmentId: "attachment-1", maxBytes: 1_024, userId: "user-1" })).toEqual(Buffer.from("bytes"));
    expect(await read({ attachmentId: "attachment-1", maxBytes: 1_024, userId: "user-2" })).toBeNull();
    expect(await read({ attachmentId: "attachment-1", maxBytes: 4, userId: "user-1" })).toBeNull();
    expect(await read({ attachmentId: "processing", maxBytes: 1_024, userId: "user-1" })).toBeNull();
    expect(await read({ attachmentId: "resized", maxBytes: 1_024, userId: "user-1" })).toBeNull();
    expect(await read({ attachmentId: "missing", maxBytes: 1_024, userId: "user-1" })).toBeNull();
  });

  it("leaves a file storage cannot return in AIQSA", async () => {
    const { read } = reader([owned], new Map(), { failStorage: true });
    expect(await read({ attachmentId: "attachment-1", maxBytes: 1_024, userId: "user-1" })).toBeNull();
  });
});

describe("Telegram answer files: sending", () => {
  it("sends photos and documents under their cleaned names, referenced to the chat, and names what stayed in AIQSA once", async () => {
    const h = setup();
    const files = [
      file("photo-1", "charts/chart.jpg", "image/jpeg", 305), file("doc-1", "report‮.pdf", "application/pdf", 18),
      ...Array.from({ length: 10 }, (_, index) => file(`more-${index}`, `more-${index}.txt`, "text/plain", 4))
    ];
    h.bytes.set("photo-1", telegramPhotoFixture());
    h.bytes.set("doc-1", Buffer.from("%PDF-1.7 synthetic"));
    for (let index = 0; index < 10; index += 1) h.bytes.set(`more-${index}`, Buffer.from("text"));
    const result = await deliverTelegramFiles({ chatId: h.user.id, files, outbound: h.outbound, owner: OWNER, read: h.read, userId: "user-1" });

    expect(result).toEqual({ failed: 0, left: 2, sent: 10 });
    expect(h.fake.calls("sendPhoto").map((call) => call.file)).toEqual([expect.objectContaining({ field: "photo", filename: "chart.jpg" })]);
    expect(h.fake.calls("sendDocument").map((call) => call.file?.filename)).toEqual([
      "report.pdf", ...Array.from({ length: 8 }, (_, index) => `more-${index}.txt`)
    ]);
    expect(h.reads.map((entry) => entry.maxBytes)).toEqual([TELEGRAM_PHOTO_MAX_BYTES, ...Array.from({ length: 9 }, () => TELEGRAM_DOCUMENT_MAX_BYTES)]);
    expect(h.reads.every((entry) => entry.userId === "user-1")).toBe(true);
    const summary = h.fake.botMessages(h.user.id).at(-1)!;
    expect(summary.text).toBe("2 more files are in AIQSA.");
    expect(summary.reply_markup).toEqual({ inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: "https://aiqsa.example/c/chat-1" }]] });
    expect(h.refs).toHaveLength(11);
    expect(h.refs.every((ref) => ref.chatId === "chat-1" && ref.linkId === "link-1")).toBe(true);
  });

  it("sends a photo Telegram refuses as a document, and counts unreadable or refused files in one line", async () => {
    const h = setup();
    h.bytes.set("wide", telegramPhotoFixture());
    h.bytes.set("refused", Buffer.from("synthetic"));
    h.fake.failNext("sendPhoto", { description: "Bad Request: PHOTO_INVALID_DIMENSIONS", status: 400 });
    const files = [file("wide", "wide.png", "image/png", 305), file("gone", "gone.csv", "text/csv"), file("refused", "refused.txt", "text/plain")];
    const outbound = {
      ...h.outbound,
      sendFile: (input: Parameters<typeof h.outbound.sendFile>[0]) => {
        // Telegram refuses this one document itself.
        if (input.file.filename === "refused.txt") h.fake.failNext("sendDocument", { description: "Bad Request: file is empty", status: 400 });
        return h.outbound.sendFile(input);
      }
    };
    const result = await deliverTelegramFiles({ chatId: h.user.id, files, outbound, owner: OWNER, read: h.read, userId: "user-1" });

    expect(result).toEqual({ failed: 2, left: 0, sent: 1 });
    expect(h.fake.calls("sendPhoto").map((call) => call.status)).toEqual([400]);
    expect(h.fake.calls("sendDocument").map((call) => [call.file?.filename, call.status])).toEqual([["wide.png", 200], ["refused.txt", 400]]);
    expect(h.fake.botMessages(h.user.id).at(-1)!.text).toBe("2 files couldn't be sent here; they're in AIQSA.");
  });

  it("stops at a chat that refuses files, counting the rest, and never names a file Telegram may have received", async () => {
    const h = setup();
    for (const id of ["a", "b", "c"]) h.bytes.set(id, Buffer.from(id));
    h.fake.failNext("sendDocument", { drop: true });
    const sent = await deliverTelegramFiles({
      chatId: h.user.id, files: [file("a", "a.txt", "text/plain", 1), file("b", "b.txt", "text/plain", 1)], outbound: h.outbound, owner: OWNER,
      read: h.read, userId: "user-1"
    });
    // The dropped connection may have delivered the first file: it is neither sent again nor named as missing.
    expect(sent).toEqual({ failed: 0, left: 0, sent: 1 });
    expect(h.fake.botMessages(h.user.id).filter((message) => message.kind === "text")).toHaveLength(0);

    h.fake.failNext("sendDocument", { status: 403 });
    const blocked = await deliverTelegramFiles({
      chatId: h.user.id, files: [file("a", "a.txt", "text/plain", 1), file("b", "b.txt", "text/plain", 1), file("c", "c.txt", "text/plain", 1)],
      outbound: h.outbound, owner: OWNER, read: h.read, userId: "user-1"
    });
    expect(blocked).toEqual({ failed: 3, left: 0, sent: 0 });
    expect(h.fake.botMessages(h.user.id).at(-1)!.text).toBe("3 files couldn't be sent here; they're in AIQSA.");
  });
});

describe("Telegram answer files: after a run's final message", () => {
  function link(telegramChatId: number, botId: number): TelegramLinkRecord {
    return {
      agentEnabled: false, botId, currentChatId: "chat-1", displayName: null, id: "link-1", lastSeenAt: new Date(0), linkedAt: new Date(0),
      pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null, telegramChatId, telegramUserId: telegramChatId,
      telegramUsername: null, userId: "user-1", workspaceEnabled: true
    };
  }

  function harness(allowed = true) {
    const h = setup();
    const access = {
      resolveTelegramAccess: vi.fn(async (): Promise<TelegramAccessDecision> => allowed
        ? { allowed: true, control: {} as never, link: link(h.user.id, h.fake.bot.id) }
        : { allowed: false, link: link(h.user.id, h.fake.bot.id), reasonCode: "telegram_access_off" })
    };
    const files = createTelegramRunFiles({ access, read: h.read });
    const context: TelegramRunEventContext = {
      bot: h.session, chatId: "chat-1", linkId: "link-1", runId: "run-1", source: "live", telegramChatId: h.user.id, userId: "user-1"
    };
    return { ...h, access, context, files };
  }

  const summary: ThreadArtifactSummary = {
    citations: [], generatedFiles: [{ attachmentId: "out-1", byteSize: 4, fileName: "result.txt", mimeType: "text/plain",
      relativePath: "outputs/result.txt" }],
    reasoningText: [], sources: []
  };

  it("sends the generated files once the final message reached Telegram, live or after a restart", async () => {
    const h = harness();
    h.bytes.set("out-1", Buffer.from("done"));
    h.files.listener({ artifactSummary: summary, messageIds: [1], sent: true, status: "complete", type: "delivered" }, h.context);
    await h.files.idle();
    expect(h.fake.calls("sendDocument").map((call) => call.file?.filename)).toEqual(["result.txt"]);
    h.files.listener({ artifactSummary: summary, messageIds: [2], sent: true, status: "cancelled", type: "delivered" },
      { ...h.context, runId: "run-2", source: "recovery" });
    await h.files.idle();
    expect(h.fake.calls("sendDocument")).toHaveLength(2);
  });

  it("sends nothing for an answer that did not reach Telegram, has no files, or whose access is off now", async () => {
    const h = harness();
    h.files.listener({ artifactSummary: summary, messageIds: [], sent: false, status: "complete", type: "delivered" }, h.context);
    h.files.listener({ messageIds: [1], sent: true, status: "complete", type: "delivered" }, h.context);
    h.files.listener({ status: "complete", type: "done" }, h.context);
    await h.files.idle();
    expect(h.read).not.toHaveBeenCalled();
    const off = harness(false);
    off.files.listener({ artifactSummary: summary, messageIds: [1], sent: true, status: "complete", type: "delivered" }, off.context);
    await off.files.idle();
    expect(off.access.resolveTelegramAccess).toHaveBeenCalledWith("user-1");
    expect(off.read).not.toHaveBeenCalled();
    expect(off.fake.calls("sendDocument")).toHaveLength(0);
  });

  it("reads the export state of the user's own run: none without Workspace, pending until complete or failed", async () => {
    const rows = new Map([["run-ws", "EXPORTING"], ["run-new", "PENDING"], ["run-done", "COMPLETE"], ["run-bad", "FAILED"]]);
    const findFirst = vi.fn(async ({ where }: { where: { modelRunId: string; modelRun: { userId: string } } }) => {
      const state = where.modelRun.userId === "user-1" ? rows.get(where.modelRunId) : undefined;
      return state ? { exportState: state } : null;
    });
    const read = createPrismaTelegramRunExportReader({ workspaceRunBinding: { findFirst } } as unknown as Pick<PrismaClient, "workspaceRunBinding">);
    expect(await read({ runId: "run-ws", userId: "user-1" })).toBe("pending");
    expect(await read({ runId: "run-new", userId: "user-1" })).toBe("pending");
    expect(await read({ runId: "run-done", userId: "user-1" })).toBe("complete");
    expect(await read({ runId: "run-bad", userId: "user-1" })).toBe("failed");
    expect(await read({ runId: "run-chat", userId: "user-1" })).toBe("none");
    expect(await read({ runId: "run-ws", userId: "user-2" })).toBe("none");
  });

  it("waits for a Workspace run's files to be exported, reads them anew, and names what is still being prepared after two minutes", async () => {
    const h = harness();
    h.bytes.set("out-1", Buffer.from("done"));
    let clock = 0;
    const sleeps: number[] = [];
    const states: TelegramRunExport[] = ["pending", "pending", "complete"];
    const exportState = vi.fn(async (): Promise<TelegramRunExport> => states.shift() ?? "complete");
    const fresh = vi.fn(async () => [file("out-1", "result.txt", "text/plain", 4)]);
    const timing = { now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; } };
    const exported = createTelegramRunFiles({ access: h.access, outputs: { exportState, files: fresh }, read: h.read, ...timing });
    // The answer was delivered before its Workspace outputs were published: its summary has no files yet.
    exported.listener({ messageIds: [1], sent: true, status: "complete", type: "delivered" }, h.context);
    await exported.idle();
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(fresh).toHaveBeenCalledWith({ runId: "run-1", userId: "user-1" });
    expect(h.fake.calls("sendDocument").map((call) => call.file?.filename)).toEqual(["result.txt"]);
    expect(h.fake.botMessages(h.user.id).filter((message) => message.kind === "text")).toHaveLength(0);

    sleeps.length = 0;
    const slow = createTelegramRunFiles({
      access: h.access, outputs: { exportState: async () => "pending", files: async () => [] }, read: h.read, ...timing
    });
    slow.listener({ messageIds: [2], sent: true, status: "complete", type: "delivered" }, { ...h.context, runId: "run-2" });
    await slow.idle();
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(TELEGRAM_FILES_EXPORT_WAIT_MS);
    expect(sleeps.length).toBeGreaterThan(5);
    expect(h.fake.botMessages(h.user.id).at(-1)!.text).toBe("More files are still being prepared in AIQSA.");

    const failed = createTelegramRunFiles({
      access: h.access, outputs: { exportState: async () => "failed", files: async () => [] }, read: h.read, ...timing
    });
    failed.listener({ messageIds: [3], sent: true, status: "complete", type: "delivered" }, { ...h.context, runId: "run-3" });
    await failed.idle();
    expect(h.fake.botMessages(h.user.id).at(-1)!.text).toBe("Some files couldn't be prepared; AIQSA shows why.");

    const before = h.fake.botMessages(h.user.id).length;
    const plain = vi.fn(async () => [file("never", "never.txt", "text/plain")]);
    const chat = createTelegramRunFiles({ access: h.access, outputs: { exportState: async () => "none", files: plain }, read: h.read, ...timing });
    chat.listener({ messageIds: [4], sent: true, status: "complete", type: "delivered" }, { ...h.context, runId: "run-4" });
    await chat.idle();
    expect(plain).not.toHaveBeenCalled();
    expect(h.fake.botMessages(h.user.id)).toHaveLength(before);
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_FILE_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

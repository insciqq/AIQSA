// @vitest-environment node

import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@/lib/domain/content";
import { createUploadPermitGate } from "@/lib/server/http/uploadPermitGate";
import type { SpeechToTextRoleResolution } from "@/lib/server/speechToText/role";
import { transcribeUserAudio, type TranscribeUserAudioDeps } from "@/lib/server/speechToText/transcribeUserAudio";
import { createUploadHandler, type CreatedAttachment } from "@/lib/server/uploads/handlers";
import type { UsageLimitStatus } from "@/lib/server/usageLimits/repository";
import { telegramPhotoFixture, type FakeTelegramUser } from "@/tests/support/fakeTelegramBotApi";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createBridgeHarness, type BridgeHarness } from "@/tests/support/telegramChatBridge";
import failureCodes from "../../observability/failureCodes.json";
import {
  TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, TELEGRAM_MEDIA_COPY, telegramReasonText, telegramUnsupportedFileText, telegramVoiceTranscriptText
} from "../copy";
import { createTelegramMediaHandler, TELEGRAM_MEDIA_LOG_CODES, type TelegramMediaServices } from "./index";
import { telegramAttachmentTypeNames } from "./plan";

/**
 * Media through the real dispatcher, chat bridge, merge window and Bot API
 * client against the fake Bot API: the product's own upload handler (memory
 * storage) and Speech to text path (stub role and adapter) as the services.
 */

const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0,
  lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null }, userSpentMicros: 0
};
const ROLE: SpeechToTextRoleResolution = {
  binding: {
    connection: { allowPrivateNetwork: false, apiRoot: "https://stt.example/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
    connectionDisplayName: "Speech", connectionId: "c1", credentialId: "k", credentialVersionId: "kv", family: "openai_compatible",
    secret: async () => "key"
  },
  modelId: "whisper-1",
  ok: true
};
const TRANSCRIPT = "What is on the diagram /unlink @someone";

type StoredAttachment = { fileName: string; kind: string; mimeType: string; status: string; userId: string };

function mediaServices(options: Readonly<{ role?: SpeechToTextRoleResolution; transcript?: string; processing?: string[] }> = {}) {
  const attachments = new Map<string, StoredAttachment>();
  const uploads: Array<Readonly<{ fileName: string; type: string; scope: string | null }>> = [];
  const transcriptions: Uint8Array[] = [];
  /** Statuses `attachmentStatus` reports in turn for a processing attachment; then `ready`. */
  const processing = [...(options.processing ?? ["processing"])];
  let counter = 0;
  const transcribeDeps: TranscribeUserAudioDeps = {
    createAdapter: () => ({
      async transcribe({ audio }) {
        transcriptions.push(audio);
        return { text: ` ${options.transcript ?? TRANSCRIPT} `, usage: { costUsd: 0.0001, inputTokens: null, outputTokens: null, seconds: 1, totalTokens: null } };
      }
    }),
    rateLimiter: { check: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    resolveRole: async () => options.role ?? ROLE,
    usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS },
    writeUsage: async () => undefined
  };
  let upload = (userId: string) => createUploadHandler({
    async createAttachment(input) {
      counter += 1;
      const id = `attachment-${counter}`;
      attachments.set(id, { fileName: input.fileName, kind: input.kind, mimeType: input.mimeType, status: input.status, userId: input.userId });
      return { ...input, id } satisfies CreatedAttachment;
    },
    getMaxBytes: () => 25_000_000,
    resolveAuth: async () => ({
      expiresAt: new Date(Date.now() + 60_000), id: "telegram",
      user: { displayName: "Alex", email: null, id: userId, role: "user", status: "active" }, userId
    }),
    storage: createMemoryStorageAdapter(),
    uploadPermitGate: createUploadPermitGate(4),
    workspaceScopeAvailable: async () => true
  });
  const services: TelegramMediaServices = {
    appBaseUrl: () => "https://aiqsa.example",
    async attachmentStatus({ attachmentId, userId }) {
      const attachment = attachments.get(attachmentId);
      if (!attachment || attachment.userId !== userId) return null;
      if (attachment.status === "processing") attachment.status = processing.shift() ?? "ready";
      return attachment.status;
    },
    transcribe: ({ audio, userId }) => transcribeUserAudio(transcribeDeps, { audio, userId }),
    async upload({ request, userId }) {
      const form = await request.clone().formData();
      const file = form.get("file") as File;
      uploads.push({ fileName: file.name, scope: form.get("scope") as string | null, type: file.type });
      return upload(userId)(request);
    },
    uploadMaxBytes: () => 25_000_000
  };
  return {
    attachments, services, transcriptions, uploads,
    replaceUpload(next: typeof upload) { upload = next; }
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
});

function harness(options: Parameters<typeof mediaServices>[0] & Readonly<{ workspaceEnabled?: boolean; readyTimeoutMs?: number }> = {}) {
  const h = createBridgeHarness();
  closers.push(h.close);
  const user = h.fake.inject.addUser({ firstName: "Alex" });
  h.link(user, "user-1", { workspaceEnabled: options.workspaceEnabled ?? false });
  const media = mediaServices(options);
  let clock = Date.now();
  h.registry.registerMessage(createTelegramMediaHandler({
    conversation: h.bridge.conversation,
    now: () => clock,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    services: async () => media.services,
    sleep: async (ms) => { clock += ms; }
  }));
  return { ...h, media, user };
}

function texts(h: BridgeHarness, user: FakeTelegramUser): string[] {
  return h.fake.botMessages(user.id).flatMap((message) => message.text === undefined ? [] : [message.text]);
}

function sentBlocks(h: BridgeHarness, index = 0): ContentBlock[] {
  return (h.aiqsa.sent[index]!.body.content as { blocks: ContentBlock[] }).blocks;
}

function message(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.message as Record<string, unknown>;
}

async function samplePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage();
  return Buffer.from(await document.save());
}

describe("Telegram media: voice messages", () => {
  it("downloads only after admission, quotes the transcript safely and sends it as the user's message after the caption", async () => {
    const h = harness();
    const raw = h.fake.inject.voice(h.user, { caption: "Summarize this", duration: 180 });
    await h.deliver(raw);
    await h.settle();

    expect(h.media.transcriptions).toHaveLength(1);
    expect(Buffer.from(h.media.transcriptions[0]!).subarray(0, 4).toString("latin1")).toBe("OggS");
    const [quote] = h.fake.calls("sendRichMessage");
    expect(quote!.params).toEqual({
      chat_id: h.user.id,
      reply_parameters: { allow_sending_without_reply: true, message_id: message(raw).message_id },
      rich_message: {
        blocks: [{ blocks: [{ text: telegramVoiceTranscriptText(TRANSCRIPT), type: "paragraph" }], type: "blockquote" }],
        skip_entity_detection: true
      }
    });
    expect(h.aiqsa.sent).toHaveLength(1);
    expect(sentBlocks(h)).toEqual([{ text: `Summarize this\n${TRANSCRIPT}`, type: "text" }]);
    // The quote comes before the answer's draft.
    const order = h.fake.calls().map((call) => call.method);
    expect(order.indexOf("sendRichMessage")).toBeLessThan(order.indexOf("sendMessageDraft"));
  });

  it("refuses an over-long or oversized voice message before downloading it", async () => {
    const h = harness();
    await h.deliver(h.fake.inject.voice(h.user, { duration: 601 }));
    await h.deliver(h.fake.inject.voice(h.user, { declaredSize: 10 * 1024 * 1024 + 1, duration: 30 }));
    await h.settle();

    expect(texts(h, h.user)).toEqual([telegramReasonText("telegram_voice_too_long"), TELEGRAM_MEDIA_COPY.voiceTooLarge]);
    expect(h.fake.calls("getFile")).toHaveLength(0);
    expect(h.media.transcriptions).toHaveLength(0);
    expect(h.aiqsa.sent).toHaveLength(0);
  });

  it("says voice messages are not set up when no Speech to text role is assigned, without downloading", async () => {
    const h = harness({ role: { ok: false, reason: "not_configured" } });
    await h.deliver(h.fake.inject.voice(h.user));
    await h.settle();

    expect(texts(h, h.user)).toEqual(["Voice messages are not set up on this AIQSA."]);
    expect(h.fake.calls("getFile")).toHaveLength(0);
    expect(h.aiqsa.sent).toHaveLength(0);
  });

  it("transcribes an audio file of a dictation type like a voice message and says when nothing was recognized", async () => {
    const h = harness({ transcript: "   " });
    const raw = h.fake.inject.voice(h.user);
    const voice = message(raw).voice as Record<string, unknown>;
    delete message(raw).voice;
    message(raw).audio = { ...voice, file_name: "memo.ogg", mime_type: "audio/ogg" };
    await h.deliver(raw);
    await h.settle();

    expect(h.media.transcriptions).toHaveLength(1);
    expect(texts(h, h.user)).toEqual([TELEGRAM_MEDIA_COPY.voiceEmpty]);
    expect(h.aiqsa.sent).toHaveLength(0);
  });
});

describe("Telegram media: photos, documents and albums", () => {
  it("uploads the largest photo as photo-<file_unique_id>.jpg, waits until it is processed and sends the caption with the image", async () => {
    const h = harness({ processing: ["processing", "processing"] });
    const raw = h.fake.inject.photo(h.user, { caption: "What is on the diagram?" });
    const sizes = message(raw).photo as Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
    await h.deliver(raw);
    await h.settle();

    const largest = sizes.reduce((best, size) => size.width * size.height >= best.width * best.height ? size : best);
    expect(h.fake.calls("getFile").map((call) => call.params.file_id)).toEqual([largest.file_id]);
    expect(h.media.uploads).toEqual([{ fileName: `photo-${largest.file_unique_id}.jpg`, scope: null, type: "image/jpeg" }]);
    expect(h.media.attachments.get("attachment-1")).toMatchObject({ kind: "image", status: "ready", userId: "user-1" });
    expect(sentBlocks(h)).toEqual([
      { text: "What is on the diagram?", type: "text" },
      { alt: `photo-${largest.file_unique_id}.jpg`, attachmentId: "attachment-1", type: "image" }
    ]);
  });

  it("turns an album of three photos into one request with three images", async () => {
    const h = harness();
    const album = h.fake.inject.album(h.user, 3, { caption: "Compare these" });
    for (const raw of album) await h.deliver(raw);
    await h.settle();

    expect(h.aiqsa.sent).toHaveLength(1);
    const [caption, ...images] = sentBlocks(h);
    expect(caption).toEqual({ text: "Compare these", type: "text" });
    // In the album's order, whichever upload finished first.
    const names = album.map((raw) => {
      const sizes = message(raw).photo as Array<{ file_unique_id: string; width: number; height: number }>;
      return `photo-${sizes.reduce((best, size) => size.width * size.height >= best.width * best.height ? size : best).file_unique_id}.jpg`;
    });
    expect(images.map((block) => block.type === "image" ? h.media.attachments.get(block.attachmentId)?.fileName : block.type)).toEqual(names);
  });

  it("answers a photo Telegram kept while the bot was off with the stale notice, without downloading it", async () => {
    const h = harness();
    const raw = h.fake.inject.photo(h.user, { caption: "old" });
    message(raw).date = Math.floor(Date.now() / 1_000) - 3_600;
    await h.deliver(raw);
    await h.settle();

    expect(texts(h, h.user)).toEqual([TELEGRAM_BRIDGE_COPY.staleMessage]);
    expect(h.fake.calls("getFile")).toHaveLength(0);
  });

  it("sends a PDF document under its own cleaned name as a file block", async () => {
    const h = harness();
    await h.deliver(h.fake.inject.document(h.user, {
      bytes: await samplePdf(), caption: "Check the totals", fileName: "Q3\u0007 report/final.pdf", mimeType: "application/pdf"
    }));
    await h.settle();

    expect(h.media.uploads).toEqual([{ fileName: "Q3_ report_final.pdf", scope: null, type: "application/pdf" }]);
    expect(h.media.attachments.get("attachment-1")).toMatchObject({ kind: "pdf", status: "ready" });
    expect(sentBlocks(h)).toEqual([
      { text: "Check the totals", type: "text" },
      { attachmentId: "attachment-1", fileName: "Q3_ report_final.pdf", type: "file" }
    ]);
  });

  it("refuses a forbidden type before downloading, naming the accepted types and offering Workspace in /settings", async () => {
    const h = harness();
    await h.deliver(h.fake.inject.document(h.user, { bytes: Buffer.from("MZ binary"), fileName: "setup.exe", mimeType: "application/x-msdownload" }));
    await h.settle();

    const [refusal] = h.fake.botMessages(h.user.id);
    expect(refusal!.text).toBe(telegramUnsupportedFileText(telegramAttachmentTypeNames(), true));
    expect(refusal!.text).toContain("PDF, DOC, DOCX");
    expect((refusal!.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]![0]!.text)
      .toBe(TELEGRAM_COPY.openSettings);
    expect(h.fake.calls("getFile")).toHaveLength(0);
    expect(h.aiqsa.sent).toHaveLength(0);
  });

  it("refuses a 25 MB file before downloading, with the upload hint and Open in AIQSA", async () => {
    const h = harness();
    const raw = h.fake.inject.document(h.user, { bytes: Buffer.from("%PDF-1.4"), fileName: "big.pdf", mimeType: "application/pdf" });
    (message(raw).document as Record<string, unknown>).file_size = 25_000_000;
    await h.deliver(raw);
    await h.settle();

    const [refusal] = h.fake.botMessages(h.user.id);
    expect(refusal!.text).toBe("Files over 20 MB can't come through Telegram. Upload it in AIQSA.");
    expect(refusal!.reply_markup).toEqual({ inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: "https://aiqsa.example/" }]] });
    expect(h.fake.calls("getFile")).toHaveLength(0);
  });

  it("leaves content checks to the product's upload: a renamed binary is refused after the upload looked at it", async () => {
    const h = harness();
    await h.deliver(h.fake.inject.document(h.user, { bytes: Buffer.from([0, 1, 2, 3, 4, 5]), fileName: "report.pdf", mimeType: "application/pdf" }));
    await h.deliver(h.fake.inject.document(h.user, { bytes: telegramPhotoFixture(), fileName: "notes.txt", mimeType: "text/plain" }));
    await h.settle();

    expect(h.media.uploads.map((upload) => upload.fileName)).toEqual(["report.pdf", "notes.txt"]);
    expect(h.media.attachments.size).toBe(0);
    expect(texts(h, h.user)).toEqual(Array.from({ length: 2 }, () => telegramUnsupportedFileText(telegramAttachmentTypeNames(), true)));
    expect(h.aiqsa.sent).toHaveLength(0);
  });

  it("uploads any file into Workspace when Workspace is on", async () => {
    const h = harness({ workspaceEnabled: true });
    await h.deliver(h.fake.inject.document(h.user, { bytes: Buffer.from("PK\u0003\u0004zip"), fileName: "data.zip", mimeType: "application/zip" }));
    await h.settle();

    expect(h.media.uploads).toEqual([{ fileName: "data.zip", scope: "workspace", type: "application/zip" }]);
    expect(sentBlocks(h)).toEqual([{ attachmentId: "attachment-1", fileName: "data.zip", type: "file" }]);
  });

  it("drops a file that does not finish processing in time or fails, saying so, and still sends the rest", async () => {
    const h = harness({ processing: ["failed"], readyTimeoutMs: 5_000 });
    await h.deliver(h.fake.inject.photo(h.user, { caption: "first" }));
    await h.deliver(h.fake.inject.text(h.user, "and this text"));
    await h.settle();

    expect(texts(h, h.user)).toContain(TELEGRAM_MEDIA_COPY.fileProcessingFailed);
    expect(sentBlocks(h)).toEqual([{ text: "and this text", type: "text" }]);

    const slow = harness({ processing: Array.from({ length: 100 }, () => "processing"), readyTimeoutMs: 5_000 });
    await slow.deliver(slow.fake.inject.photo(slow.user));
    await slow.settle();
    expect(texts(slow, slow.user)).toEqual([TELEGRAM_MEDIA_COPY.fileStillProcessing]);
    expect(slow.aiqsa.sent).toHaveLength(0);
  });

  it("asks a busy upload again a few times before giving up", async () => {
    const h = harness();
    const busy = () => async () => Response.json({ error: "upload_busy" }, { headers: { "retry-after": "1" }, status: 429 });
    h.media.replaceUpload(busy);
    await h.deliver(h.fake.inject.photo(h.user));
    await h.settle();

    expect(h.media.uploads).toHaveLength(4);
    expect(texts(h, h.user)).toEqual([TELEGRAM_MEDIA_COPY.uploadBusy]);
  });
});

describe("Telegram media: other message kinds", () => {
  it("answers video, video notes, stickers, animations, locations and contacts as unsupported", async () => {
    const h = harness();
    const kinds: Record<string, unknown> = {
      animation: { duration: 1, file_id: "A", file_unique_id: "UA", height: 1, width: 1 },
      contact: { first_name: "Sam", phone_number: "+10000000000" },
      location: { latitude: 0, longitude: 0 },
      video: { duration: 1, file_id: "V", file_unique_id: "UV", height: 1, width: 1 },
      video_note: { duration: 1, file_id: "N", file_unique_id: "UN", length: 1 }
    };
    for (const [key, value] of Object.entries(kinds)) {
      const raw = h.fake.inject.text(h.user, "x");
      delete message(raw).text;
      message(raw)[key] = value;
      // Telegram sends a GIF as an animation and, for old clients, a document too.
      if (key === "animation") message(raw).document = { file_id: "A", file_name: "a.gif.mp4", file_unique_id: "UA", mime_type: "video/mp4" };
      await h.deliver(raw);
    }
    await h.deliver(h.fake.inject.sticker(h.user));
    await h.settle();

    expect(texts(h, h.user)).toEqual(Array.from({ length: 6 }, () => telegramReasonText("telegram_unsupported_message")));
    expect(h.fake.calls("getFile")).toHaveLength(0);
    expect(h.aiqsa.sent).toHaveLength(0);
  });

  it("keeps the merge window's order while content is prepared, and a part that failed adds nothing", async () => {
    const h = harness();
    const link = h.links.records.get("user-1")!;
    let release!: (blocks: ContentBlock[]) => void;
    const slow = new Promise<ContentBlock[]>((resolve) => { release = resolve; });
    const source = (raw: Record<string, unknown>) => ({ bot: h.session, link, message: message(raw) as never, updateId: raw.update_id as number });
    h.bridge.conversation.queue(source(h.fake.inject.text(h.user, "one")), slow);
    h.bridge.conversation.queue(source(h.fake.inject.text(h.user, "two")), Promise.reject(new Error("prepare failed")));
    h.bridge.conversation.queue(source(h.fake.inject.text(h.user, "three")), [{ text: "three", type: "text" }]);
    h.bridge.conversation.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.aiqsa.sent).toHaveLength(0);
    release([{ text: "one", type: "text" }]);
    await h.settle();

    expect(h.aiqsa.sent).toHaveLength(1);
    expect(sentBlocks(h)).toEqual([{ text: "one\nthree", type: "text" }]);
  });

  it("registers its log codes among their sorted neighbours", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_MEDIA_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

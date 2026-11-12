import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import type { ThreadArtifactSummary } from "../../contracts/chats";
import type { ContentBlock } from "../../domain/content";
import failureCodes from "../observability/failureCodes.json";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo } from "./access";
import type { DiscordEffectiveControl } from "./control/state";
import {
  createFakeDiscordRunGateway, createMemoryDiscordConversationStore, createMemoryDiscordLimitStore, createMemoryDiscordReplyStore,
  createMemoryDiscordRunFacts
} from "./bridge/bridge.testFixtures";
import { createDiscordBridge } from "./bridge/index";
import { decodeDiscordContextMessage, type DiscordContextMessage, type DiscordMentionNames } from "./bridge/messages";
import type { DiscordUploads } from "./bridge/uploads";
import {
  createDiscordAnswerFiles, createDiscordAttachments, DISCORD_FILE_LOG_CODES, planDiscordAttachments, type DiscordAttachmentLimits,
  type DiscordFileReader
} from "./files";
import { createDiscordHandlerRegistry, createDiscordIntake } from "./intake";
import { createDiscordRest, type DiscordRest } from "./rest";
import type { DiscordTransport } from "./transport";

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

afterEach(() => {
  logs.length = 0;
});

const MiB = 1024 * 1024;
const LIMITS: DiscordAttachmentLimits = { runMaxBytes: 64 * MiB, runMaxCount: 20, uploadMaxBytes: 50 * MiB };

type Uploaded = { fileName: string; mimeType: string; size: number; userId: string };

function fakeUploads(refuse: ReadonlyMap<string, string> = new Map()): DiscordUploads & { uploaded: Uploaded[] } {
  const uploaded: Uploaded[] = [];
  return {
    uploaded,
    async uploadFile(input) {
      const code = refuse.get(input.fileName);
      if (code) return { code, ok: false };
      uploaded.push({ fileName: input.fileName, mimeType: input.mimeType, size: input.data.length, userId: input.userId });
      const attachmentId = `att_${uploaded.length}`;
      const block: ContentBlock = input.mimeType.startsWith("image/")
        ? { alt: input.fileName, attachmentId, type: "image" }
        : { attachmentId, fileName: input.fileName, type: "file" };
      return { block, ok: true };
    }
  };
}

function names(fake: FakeDiscord): DiscordMentionNames {
  return { botName: fake.bot.username, botRoleId: fake.botRoleId, botUserId: fake.bot.id };
}

function decoded(fake: FakeDiscord, message: FakeDiscordMessage): DiscordContextMessage {
  return decodeDiscordContextMessage(message, names(fake))!;
}

const png = (label: string) => ({ contentType: "image/png", data: Buffer.from(`png:${label}`), filename: `${label}.png` });
const pdf = (label: string) => ({ contentType: "application/pdf", data: Buffer.from(`pdf:${label}`), filename: `${label}.pdf` });

function imageNames(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "image" ? [block.alt ?? ""] : []));
}

function fileNames(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "file" ? [block.fileName] : []));
}

function hookFor(fake: FakeDiscord, uploads: DiscordUploads, limits: DiscordAttachmentLimits = LIMITS, download?: DiscordTransport["download"]) {
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  return createDiscordAttachments({
    download: download ?? fake.transport.download, limits: () => limits, now: () => Date.parse("2026-11-12T09:30:00.000Z"),
    rest: () => rest, uploads
  });
}

describe("Discord attachments in", () => {
  it("adds the question's and the reference's images and a PDF as blocks, in the text's order", async () => {
    const fake = createFakeDiscord();
    const [alice, bob] = [fake.addUser({ username: "alice" }), fake.addUser({ username: "bob" })];
    const theirs = fake.postMessage({ attachments: [png("mockup")], authorId: bob, channelId: fake.channels.text, content: "the mockup" });
    const asked = fake.postMessage({
      attachments: [png("mine"), pdf("brief")], authorId: alice, channelId: fake.channels.text, content: "make it like this", replyTo: theirs.id
    });
    const uploads = fakeUploads();
    const plan = await hookFor(fake, uploads)({ history: [], question: [decoded(fake, asked)], reference: decoded(fake, theirs), userId: "svc_1" });

    expect(imageNames(plan.blocks)).toEqual(["mockup.png", "mine.png"]);
    expect(fileNames(plan.blocks)).toEqual(["brief.pdf"]);
    expect(plan.notes).toEqual([]);
    expect(uploads.uploaded.map((entry) => `${entry.userId}:${entry.fileName}:${entry.mimeType}`).sort()).toEqual([
      "svc_1:brief.pdf:application/pdf", "svc_1:mine.png:image/png", "svc_1:mockup.png:image/png"
    ]);
  });

  it("keeps the budget of ten images for the newest history and never cuts the question or the reference", async () => {
    const fake = createFakeDiscord();
    const [alice, bob] = [fake.addUser({ username: "alice" }), fake.addUser({ username: "bob" })];
    const history: DiscordContextMessage[] = [];
    for (let index = 1; index <= 15; index += 1) {
      history.push(decoded(fake, fake.postMessage({ attachments: [png(`h${index}`)], authorId: bob, channelId: fake.channels.text, content: `shot ${index}` })));
    }
    const reference = decoded(fake, fake.postMessage({
      attachments: [png("r1"), png("r2"), png("r3"), png("r4"), png("r5"), png("r6")], authorId: bob, channelId: fake.channels.text, content: "set"
    }));
    const question = decoded(fake, fake.postMessage({
      attachments: [png("q1"), png("q2"), png("q3"), png("q4"), png("q5"), png("q6")], authorId: alice, channelId: fake.channels.text,
      content: "compare", replyTo: reference.id
    }));
    const uploads = fakeUploads();
    const hook = hookFor(fake, uploads);

    const full = await hook({ history, question: [question], reference, userId: "svc_1" });
    // 6 + 6 exceed the budget: all of them, nothing from history.
    expect(imageNames(full.blocks)).toEqual(["r1.png", "r2.png", "r3.png", "r4.png", "r5.png", "r6.png", "q1.png", "q2.png", "q3.png", "q4.png", "q5.png", "q6.png"]);
    expect(full.notes).toEqual(["15 attachments of earlier messages are only named."]);

    const small = await hook({ history, question: [question], reference: null, userId: "svc_1" });
    expect(imageNames(small.blocks)).toEqual(["h12.png", "h13.png", "h14.png", "h15.png", "q1.png", "q2.png", "q3.png", "q4.png", "q5.png", "q6.png"]);
    expect(small.notes).toEqual(["11 attachments of earlier messages are only named."]);
  });

  it("drops history images first when the run's allowance is smaller than the budget", () => {
    const fake = createFakeDiscord();
    const [alice, bob] = [fake.addUser({ username: "alice" }), fake.addUser({ username: "bob" })];
    const history = [1, 2, 3, 4].map((index) => decoded(fake, fake.postMessage({ attachments: [png(`h${index}`)], authorId: bob, channelId: fake.channels.text, content: "x" })));
    const reference = decoded(fake, fake.postMessage({ attachments: [png("r1"), pdf("r-doc")], authorId: bob, channelId: fake.channels.text, content: "ref" }));
    const question = decoded(fake, fake.postMessage({ attachments: [png("q1")], authorId: alice, channelId: fake.channels.text, content: "q", replyTo: reference.id }));
    // Four places, one kept for the history file: the question's and the reference's three stay.
    const plan = planDiscordAttachments({ history, limits: { ...LIMITS, runMaxCount: 4 }, question: [question], reference });
    expect(plan.selected.map((entry) => entry.fileName)).toEqual(["q1.png", "r1.png", "r-doc.pdf"]);
    expect(plan.skipped.map((entry) => [entry.name, entry.origin, entry.reason])).toEqual([
      ["h1.png", "history", "over_limit"], ["h2.png", "history", "over_limit"], ["h3.png", "history", "over_limit"], ["h4.png", "history", "over_limit"]
    ]);
    // Bytes count too: the reference's document goes before any image of the question or the reference.
    const bytes = planDiscordAttachments({ history: [], limits: { ...LIMITS, runMaxBytes: 10 }, question: [question], reference });
    expect(bytes.selected.map((entry) => entry.fileName)).toEqual(["q1.png"]);
  });

  it("uploads ten of twelve documents and names an oversized file, an unsupported one and refused uploads", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const first = fake.postMessage({ attachments: Array.from({ length: 8 }, (_, index) => pdf(`doc${index + 1}`)), authorId: alice, channelId: fake.channels.text, content: "a" });
    const second = fake.postMessage({
      attachments: [
        ...Array.from({ length: 4 }, (_, index) => pdf(`doc${index + 9}`)),
        { contentType: "application/zip", data: Buffer.alloc(12), filename: "logs.zip" },
        { contentType: "audio/ogg", data: Buffer.alloc(12), filename: "voice-message.ogg" }
      ],
      authorId: alice, channelId: fake.channels.text, content: "b"
    });
    const uploads = fakeUploads(new Map([["doc2.pdf", "attachment_type_unsupported"]]));
    const plan = await hookFor(fake, uploads, { ...LIMITS, uploadMaxBytes: 8 })({
      history: [], question: [decoded(fake, first), decoded(fake, second)], reference: null, userId: "svc_1"
    });
    // Eight bytes allowed: "pdf:doc1" fits, "pdf:doc10" does not.
    expect(fileNames(plan.blocks)).toEqual(["doc1.pdf", "doc3.pdf", "doc4.pdf", "doc5.pdf", "doc6.pdf", "doc7.pdf", "doc8.pdf", "doc9.pdf"]);
    expect(plan.notes).toEqual([
      "Attachments not added (too large): doc10.pdf, doc11.pdf, doc12.pdf",
      "Attachments not added (file type not supported): logs.zip, voice-message.ogg",
      "Attachments not added (upload refused: attachment_type_unsupported): doc2.pdf"
    ]);

    const many = await hookFor(fake, fakeUploads())({ history: [], question: [decoded(fake, first), decoded(fake, second)], reference: null, userId: "svc_1" });
    expect(fileNames(many.blocks)).toHaveLength(10);
    expect(many.notes).toEqual([
      "Attachments not added (file type not supported): logs.zip, voice-message.ogg",
      "Attachments not added (over this turn's attachment limit): doc11.pdf, doc12.pdf"
    ]);
    expect(logs.filter((entry) => entry.fields.code === "discord_attachment_upload_refused")).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toMatch(/doc\d|cdn\.discordapp|hm=/u);
  });

  it("renews an expired signed URL by reading the message again, never through refresh-urls", async () => {
    const fake = createFakeDiscord();
    const bob = fake.addUser({ username: "bob" });
    const old = fake.postMessage({ attachments: [png("old")], authorId: bob, channelId: fake.channels.text, content: "old" });
    const stale = decoded(fake, old);
    fake.expireAttachmentUrls(fake.channels.text, old.id);
    const uploads = fakeUploads();
    const plan = await hookFor(fake, uploads)({ history: [], question: [stale], reference: null, userId: "svc_1" });

    expect(imageNames(plan.blocks)).toEqual(["old.png"]);
    expect(fake.calls({ route: "get_channel_message" })).toHaveLength(1);
    expect(fake.calls().some((call) => call.path.includes("refresh-urls"))).toBe(false);

    // A URL whose `ex` already passed is renewed before any download.
    const downloads: string[] = [];
    const expired = { ...stale, attachments: stale.attachments.map((entry) => ({ ...entry, url: entry.url!.replace(/ex=[0-9a-f]+/u, "ex=1") })) };
    await hookFor(fake, fakeUploads(), LIMITS, async (input) => {
      downloads.push(input.url);
      return fake.transport.download(input);
    })({ history: [], question: [expired], reference: null, userId: "svc_1" });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).not.toContain("ex=1&");
  });

  it("names a file whose download fails and logs only the code", async () => {
    const fake = createFakeDiscord();
    const bob = fake.addUser({ username: "bob" });
    const message = decoded(fake, fake.postMessage({ attachments: [png("gone")], authorId: bob, channelId: fake.channels.text, content: "x" }));
    const plan = await hookFor(fake, fakeUploads(), LIMITS, async () => ({ kind: "network_before_send", ok: false }))({
      history: [], question: [message], reference: null, userId: "svc_1"
    });
    expect(plan).toEqual({ blocks: [], notes: ["Attachments not added (could not be downloaded): gone.png"] });
    expect(logs.map((entry) => entry.fields.code)).toEqual(["discord_attachment_download_failed"]);
  });

  it("registers its log codes", () => {
    const registry = failureCodes as string[];
    for (const code of DISCORD_FILE_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Answer files

function image(index: number, byteSize = 100): NonNullable<ThreadArtifactSummary["generatedImages"]>[number] {
  return { attachmentId: `img_${index}`, byteSize, fileName: `image-${index}.png`, height: 10, mimeType: "image/png", sourceAttachmentIds: [], width: 10 };
}

function file(index: number, byteSize = 100, fileName = `report-${index}.csv`): NonNullable<ThreadArtifactSummary["generatedFiles"]>[number] {
  return { attachmentId: `file_${index}`, byteSize, fileName, mimeType: "text/csv", relativePath: fileName };
}

function reader(sizes: ReadonlyMap<string, number> = new Map()): DiscordFileReader & { reads: string[] } {
  const reads: string[] = [];
  const read = async (input: Readonly<{ attachmentId: string; maxBytes: number; userId: string }>) => {
    reads.push(`${input.userId}:${input.attachmentId}`);
    const size = sizes.get(input.attachmentId);
    return size === undefined ? null : Buffer.alloc(size);
  };
  return Object.assign(read, { reads });
}

function answerWith(summary: Partial<ThreadArtifactSummary>) {
  return {
    artifactSummary: { citations: [], reasoningText: [], sources: [], ...summary }, assistantMessageId: "a1", chatId: "c1", errorMessage: null,
    status: "complete" as const, text: "Done."
  };
}

describe("Discord answer files out", () => {
  it("attaches images first, ten at most, within 20 MiB each and 25 MiB together, and counts the rest", async () => {
    const images = [image(1), image(2, 21 * MiB)];
    const files = Array.from({ length: 10 }, (_, index) => file(index + 1));
    files.push(file(11, 12 * MiB), file(12, 12 * MiB));
    const sizes = new Map<string, number>([...images, ...files].map((entry) => [entry.attachmentId, entry.byteSize]));
    sizes.delete("file_3");
    const read = reader(sizes);
    const hook = createDiscordAnswerFiles({ read });
    const result = await hook({ answer: answerWith({ generatedFiles: files, generatedImages: images }), chatId: "c1", runId: "r1", test: false, userId: "svc_1" });

    expect(result.files.map((entry) => entry.filename)).toEqual([
      "image-1.png", "report-1.csv", "report-2.csv", "report-4.csv", "report-5.csv", "report-6.csv", "report-7.csv", "report-8.csv",
      "report-9.csv", "report-10.csv"
    ]);
    // Too large (image 2), unreadable (file 3), past ten (files 11 and 12).
    expect(result.note).toBe("4 files are only in AIQSA");
    expect(result.fallbackNote).toBe("14 files are only in AIQSA");
    expect(read.reads.every((entry) => entry.startsWith("svc_1:"))).toBe(true);
    expect(read.reads).not.toContain("svc_1:img_2");
  });

  it("keeps the request within 25 MiB and cleans and redacts names", async () => {
    const files = [file(1, 15 * MiB), file(2, 15 * MiB), file(3, 100, "ghp_abcdefghijklmnopqrstuvwxyz0123456789.csv"), file(4, 100, "../../etc/\u202epasswd.csv")];
    const read = reader(new Map(files.map((entry) => [entry.attachmentId, entry.byteSize])));
    const result = await createDiscordAnswerFiles({ read })({ answer: answerWith({ generatedFiles: files }), chatId: "c1", runId: "r1", test: false, userId: "svc_1" });
    expect(result.files.map((entry) => entry.filename)).toEqual(["report-1.csv", "[redacted].csv", "passwd.csv"]);
    expect(result.note).toBe("1 file is only in AIQSA");
  });

  it("attaches nothing and says nothing for an answer without files", async () => {
    const result = await createDiscordAnswerFiles({ read: reader() })({ answer: answerWith({}), chatId: "c1", runId: "r1", test: false, userId: "svc_1" });
    expect(result).toEqual({ files: [], note: null });
  });
});

// ---------------------------------------------------------------------------
// Through the bridge, against the fake Discord

function controlFor(fake: FakeDiscord): DiscordEffectiveControl {
  return {
    assistantId: "assistant_1",
    bot: { applicationId: fake.application.id, generation: 1, roleId: fake.botRoleId, token: fake.token, userId: fake.bot.id, username: fake.bot.username },
    channelIds: new Set(), channelMode: "all_except", dmEnabled: true, enabled: true, enabledAt: new Date("2026-11-12T08:00:00.000Z"),
    guildId: fake.guild.id, limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: "svc_1", session: null, testAuthorIds: new Set(), testChannelIds: new Set(), callNames: [], tokenState: "ready", version: 3
  };
}

function harness(options: Readonly<{ generated?: Partial<ThreadArtifactSummary>; sizes?: ReadonlyMap<string, number> }> = {}) {
  const fake = createFakeDiscord();
  const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
  const now = () => clock.latest + 500;
  const rest: DiscordRest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const replies = createMemoryDiscordReplyStore();
  const runs = createFakeDiscordRunGateway({ autoFinish: () => ({ text: "Here it is." }) });
  const gateway = {
    ...runs.gateway,
    async answer(input: Readonly<{ userId: string; runId: string }>) {
      const answer = await runs.gateway.answer(input);
      return answer && options.generated ? { ...answer, artifactSummary: { ...answer.artifactSummary!, ...options.generated } } : answer;
    }
  };
  const control = controlFor(fake);
  const registry = createDiscordHandlerRegistry();
  const directory = createDiscordChannelDirectory();
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  const intake = createDiscordIntake({
    control: async () => control, directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now, rest: async () => rest }), now, registry
  });
  const uploads = fakeUploads();
  const bridge = createDiscordBridge({
    answerFiles: createDiscordAnswerFiles({ read: reader(options.sizes) }),
    attachments: createDiscordAttachments({ download: fake.transport.download, limits: () => LIMITS, now, rest: () => rest, uploads }),
    control: async () => control, conversations: createMemoryDiscordConversationStore(), facts: createMemoryDiscordRunFacts(replies), gateway,
    lanes: intake.lanes, limits: createMemoryDiscordLimitStore(replies), now, replies, rest: () => rest, setupReady: async () => true,
    shares: { create: async () => "https://aiqsa.example.com/s/synthetic" }, uploads,
    timing: { claimGraceMs: 0, followMs: 0, mergeWindowMs: 0, statusIntervalMs: 60_000, typingIntervalMs: 60_000 }
  });
  bridge.register(registry);

  async function say(input: Parameters<FakeDiscord["postMessage"]>[0]): Promise<FakeDiscordMessage> {
    const message = fake.postMessage(input);
    clock.latest = Math.max(clock.latest, Date.parse(message.timestamp));
    await intake.accept({ data: message, type: "MESSAGE_CREATE" });
    return message;
  }
  async function settle(): Promise<void> {
    await vi.waitFor(async () => {
      await intake.lanes.idle();
      await bridge.idle();
      expect([...replies.rows.values()].filter((row) => row.state === "claimed" || row.state === "admitted")).toEqual([]);
    });
  }
  const blocks = (index: number) => (runs.runs[index]!.body.content as { blocks: ContentBlock[] }).blocks;
  return { blocks, fake, runs, say, settle, uploads, user: (username: string) => fake.addUser({ username }) };
}

const mentionOf = (fake: FakeDiscord, text: string) => ({ content: `<@${fake.bot.id}> ${text}`, mentions: [fake.bot.id] });

describe("Discord files through the bridge", () => {
  it("gives the model the image of another person's message a channel mention replies to, beside the question's own", async () => {
    const h = harness();
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    const theirs = await h.say({ attachments: [png("their-photo")], authorId: bob, channelId: h.fake.channels.text, content: "look" });
    await h.say({ ...mentionOf(h.fake, "make it brighter"), attachments: [png("my-sketch")], authorId: alice, channelId: h.fake.channels.text, replyTo: theirs.id });
    await h.settle();

    expect(h.runs.runs).toHaveLength(1);
    const blocks = h.blocks(0);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(imageNames(blocks)).toEqual(["their-photo.png", "my-sketch.png"]);
    expect((blocks[0] as { text: string }).text).toContain(`Replying to bob (discord:${bob}), message ${theirs.id}:\nlook [attachments: their-photo.png]`);
  });

  it("does the same inside a thread, where the replied-to message is also in the delta", async () => {
    const h = harness();
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    const first = await h.say({ ...mentionOf(h.fake, "start"), authorId: alice, channelId: h.fake.channels.text });
    await h.settle();
    const threadId = first.id;
    // Bob's plain message in the bot's thread asks nothing: it reaches the next turn as context.
    const theirs = await h.say({ attachments: [png("diagram")], authorId: bob, channelId: threadId, content: "current diagram" });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    await h.say({ ...mentionOf(h.fake, "redo this"), attachments: [png("notes")], authorId: alice, channelId: threadId, replyTo: theirs.id });
    await h.settle();

    expect(h.runs.runs).toHaveLength(2);
    expect(imageNames(h.blocks(1))).toEqual(["diagram.png", "notes.png"]);
  });

  it("attaches a generated image to the final edit and counts what stays in AIQSA", async () => {
    const images = [image(1)];
    const files = Array.from({ length: 10 }, (_, index) => file(index + 1));
    const sizes = new Map<string, number>([...images, ...files].map((entry) => [entry.attachmentId, entry.byteSize]));
    const h = harness({ generated: { generatedFiles: files, generatedImages: images }, sizes });
    const alice = h.user("alice");
    const question = await h.say({ ...mentionOf(h.fake, "draw it"), authorId: alice, channelId: h.fake.channels.text });
    await h.settle();

    const [answer] = h.fake.messages(question.id).filter((message) => message.author.id === h.fake.bot.id);
    expect(answer!.content).toBe("Here it is.\n\n1 file is only in AIQSA");
    expect(answer!.attachments.map((entry) => entry.filename)).toEqual(["image-1.png", ...files.slice(0, 9).map((entry) => entry.fileName)]);
    const edit = h.fake.calls({ route: "edit_message" }).at(-1)!;
    expect(edit.files).toHaveLength(10);
    expect(h.fake.violations()).toEqual([]);
  });

  it("sends the answer without its files when Discord refuses them, saying they are in AIQSA", async () => {
    const h = harness({ generated: { generatedImages: [image(1)] }, sizes: new Map([["img_1", 100]]) });
    const alice = h.user("alice");
    h.fake.fail({ reply: { code: 50013, status: 403 }, route: "edit_message" });
    const question = await h.say({ ...mentionOf(h.fake, "draw it"), authorId: alice, channelId: h.fake.channels.text });
    await h.settle();

    const [answer] = h.fake.messages(question.id).filter((message) => message.author.id === h.fake.bot.id);
    expect(answer!.content).toBe("Here it is.\n\n1 file is only in AIQSA");
    expect(answer!.attachments).toEqual([]);
    expect(h.fake.reactionsBy(question.id, h.fake.bot.id)).toEqual([]);
  });
});

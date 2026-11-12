import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import type { DiscordChannelKind } from "../access";
import { decodeDiscordIntakeMessage } from "../intake";
import { DISCORD_BRIDGE_COPY, DISCORD_COPY } from "../copy";
import { createDiscordRest } from "../rest";
import {
  DISCORD_CHANNEL_WINDOW_MAX, discordAttachmentNamesOnly, readDiscordTurnContext, type DiscordAttachmentHook, type DiscordContextScope
} from "./context";
import { decodeDiscordContextMessage, type DiscordMentionNames } from "./messages";
import { discordRunFailure, discordSendRefusalFailure } from "./refusals";
import { discordTrigger } from "./triggers";
import type { DiscordUploads } from "./uploads";

function setup() {
  const fake = createFakeDiscord();
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const names: DiscordMentionNames = { botName: fake.bot.username, botRoleId: fake.botRoleId, botUserId: fake.bot.id };
  const alice = fake.addUser({ globalName: "Alice", username: "alice" });
  const bob = fake.addUser({ username: "bob" });
  return { alice, bob, fake, names, rest };
}

type Setup = ReturnType<typeof setup>;

function trigger(s: Setup, message: FakeDiscordMessage) {
  return decodeDiscordContextMessage(message, s.names)!;
}

async function read(s: Setup, message: FakeDiscordMessage, scope: DiscordContextScope, extra: Partial<Parameters<typeof readDiscordTurnContext>[0]> = {}) {
  const context = await readDiscordTurnContext({
    attachments: discordAttachmentNamesOnly, conversationId: null, facts: { aiqsaMessages: async () => new Map() }, header: "Header.",
    mergeWindowMs: 0, names: s.names, rest: s.rest, scope, trigger: trigger(s, message), uploads: null, userId: "svc_1", ...extra
  });
  if (!context.ok) throw new Error(context.code);
  return context;
}

describe("Discord turn context", () => {
  it("reads a channel window back to a gap of more than 30 minutes, with names, ids and times", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    s.fake.postMessage({ authorId: s.alice, channelId, content: "before the gap" });
    s.fake.advance(31 * 60_000);
    s.fake.postMessage({ authorId: s.bob, channelId, content: `hi <@${s.alice}>`, mentions: [s.alice] });
    const question = s.fake.postMessage({ authorId: s.alice, channelId, content: `<@${s.fake.bot.id}> help`, mentions: [s.fake.bot.id] });
    const context = await read(s, question, { channelId, kind: "channel_window" });
    expect(context.text).not.toContain("before the gap");
    expect(context.text).toMatch(new RegExp(`^Header\\.\\n\\nEarlier messages:\\n\\[2026-11-12 \\d\\d:\\d\\d UTC\\] bob \\(discord:${s.bob}\\): hi @Alice\\n\\nQuestion from Alice \\(discord:${s.alice}\\):\\n@aiqsa-test help$`, "u"));
    expect(context).toMatchObject({ historyCount: 1, includedUpTo: question.id, mergedIds: [] });
  });

  it("reads at most 50 channel messages and never older than 6 hours", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    s.fake.postMessage({ authorId: s.alice, channelId, content: "seven hours ago" });
    for (let step = 0; step < 14; step += 1) {
      s.fake.advance(29 * 60_000);
      s.fake.postMessage({ authorId: s.bob, channelId, content: `step ${step}` });
    }
    const question = s.fake.postMessage({ authorId: s.alice, channelId, content: "now", mentions: [s.fake.bot.id] });
    expect((await read(s, question, { channelId, kind: "channel_window" })).text).not.toContain("seven hours ago");
    for (let index = 0; index < 60; index += 1) s.fake.postMessage({ authorId: s.bob, channelId, content: `busy ${index}` });
    const later = s.fake.postMessage({ authorId: s.alice, channelId, content: "again", mentions: [s.fake.bot.id] });
    expect((await read(s, later, { channelId, kind: "channel_window" })).historyCount).toBe(DISCORD_CHANNEL_WINDOW_MAX);
  });

  it("reads only what came after the last included message, and leaves out this conversation's own answers", async () => {
    const s = setup();
    const channelId = s.fake.channels.voice;
    const old = s.fake.postMessage({ authorId: s.alice, channelId, content: "already in the chat" });
    const answer = s.fake.postMessage({ authorId: s.fake.bot.id, channelId, content: "our answer" });
    const other = s.fake.postMessage({ authorId: s.fake.bot.id, channelId, content: "another service's card" });
    const question = s.fake.postMessage({ authorId: s.bob, channelId, content: "next", mentions: [s.fake.bot.id] });
    const facts = { aiqsaMessages: vi.fn(async () => new Map([[answer.id, "conversation-1"]])) };
    const context = await read(s, question, { afterId: old.id, bounded: true, channelId, kind: "delta" }, { conversationId: "conversation-1", facts });
    expect(context.text).toContain("Messages since your last reply:");
    expect(context.text).not.toContain("already in the chat");
    expect(context.text).not.toContain("our answer");
    expect(context.text).toContain(`(discord:${s.fake.bot.id}) (bot): another service's card`);
    expect(facts.aiqsaMessages).toHaveBeenCalledWith([answer.id, other.id]);
  });

  it("always adds the Reply's target, read fresh, with its attachments by name, and names a deleted one", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const target = s.fake.postMessage({
      attachments: [{ contentType: "image/png", data: Buffer.from("png"), filename: "chart.png" }], authorId: s.bob, channelId, content: "the chart"
    });
    s.fake.editUserMessage(channelId, target.id, "the chart, edited");
    const question = s.fake.postMessage({ authorId: s.alice, channelId, content: "make it blue", mentions: [s.fake.bot.id], replyTo: target.id });
    const context = await read(s, question, { channelId, kind: "channel_window" });
    expect(context.text).toContain(`Replying to bob (discord:${s.bob}), message ${target.id}:\nthe chart, edited [attachments: chart.png]`);
    expect(context.text.indexOf("Replying to")).toBeLessThan(context.text.indexOf("Question from"));
    s.fake.deleteMessage(channelId, target.id);
    expect((await read(s, question, { channelId, kind: "channel_window" })).text).toContain(`Replying to message ${target.id}, which can no longer be read.`);
  });

  it("joins the same author's next messages within the window to the question", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const question = s.fake.postMessage({ authorId: s.alice, channelId, content: "first part", mentions: [s.fake.bot.id] });
    const second = s.fake.postMessage({ authorId: s.alice, channelId, content: "second part" });
    s.fake.postMessage({ authorId: s.bob, channelId, content: "someone else" });
    const context = await read(s, question, { channelId, kind: "channel_window" }, { mergeWindowMs: 1_500 });
    expect(context.text).toMatch(/Question from Alice \(discord:\d+\):\nfirst part\nsecond part$/u);
    expect(context).toMatchObject({ includedUpTo: second.id, mergedIds: [second.id] });
  });

  it("keeps the tail of a history over 60 000 characters inline and puts all of it in discord-history.md", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const thread = await s.rest.startThreadFromMessage(channelId, s.fake.postMessage({ authorId: s.alice, channelId, content: "start" }).id, { name: "long" });
    if (!thread.ok) throw new Error("thread");
    for (let index = 0; index < 80; index += 1) s.fake.postMessage({ authorId: s.bob, channelId: thread.value.id, content: `${index} ${"x".repeat(1_000)}` });
    const question = s.fake.postMessage({ authorId: s.alice, channelId: thread.value.id, content: "summary?", mentions: [s.fake.bot.id] });
    const uploadFile = vi.fn<DiscordUploads["uploadFile"]>(async () => ({ block: { attachmentId: "attachment-1", fileName: "discord-history.md", type: "file" }, ok: true }));
    const context = await read(s, question, { kind: "thread_start", starterChannelId: channelId, threadId: thread.value.id }, {
      maxChars: 20_000, uploads: { uploadFile }
    });
    expect(context.text.length).toBeLessThanOrEqual(20_000);
    expect(context.text).toMatch(/\d+ earlier messages are in the attached file/u);
    expect(context.text).toContain("Question from Alice");
    expect(context.blocks).toEqual([{ text: context.text, type: "text" }, { attachmentId: "attachment-1", fileName: "discord-history.md", type: "file" }]);
    const uploaded = new TextDecoder().decode(uploadFile.mock.calls[0]![0].data);
    expect(uploaded).toContain(": start");
    expect(uploaded).toContain(": 0 x");
    expect(uploaded).toContain(": 79 x");
    expect(uploadFile.mock.calls[0]![0]).toMatchObject({ fileName: "discord-history.md", mimeType: "text/markdown", userId: "svc_1" });
    const cut = await read(s, question, { kind: "thread_start", starterChannelId: channelId, threadId: thread.value.id }, { maxChars: 20_000 });
    expect(cut.text).toMatch(/\d+ earlier messages omitted/u);
  });

  it("hands the question, the target and the history to the attachment hook, oldest first", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const history = s.fake.postMessage({ authorId: s.bob, channelId, content: "old", attachments: [{ contentType: "image/png", data: Buffer.from("a"), filename: "a.png" }] });
    const question = s.fake.postMessage({ authorId: s.alice, channelId, content: "look", mentions: [s.fake.bot.id], replyTo: history.id });
    const hook = vi.fn<DiscordAttachmentHook>(async () => ({ blocks: [{ alt: "a.png", attachmentId: "image-1", type: "image" }], notes: ["1 file could not be added"] }));
    const context = await read(s, question, { channelId, kind: "channel_window" }, { attachments: hook });
    expect(hook.mock.calls[0]![0]).toMatchObject({
      history: [expect.objectContaining({ id: history.id })], question: [expect.objectContaining({ id: question.id })],
      reference: expect.objectContaining({ attachments: [expect.objectContaining({ filename: "a.png" })], id: history.id }), userId: "svc_1"
    });
    expect(context.blocks.at(-1)).toEqual({ alt: "a.png", attachmentId: "image-1", type: "image" });
    expect(context.text.endsWith("1 file could not be added")).toBe(true);
  });

  it("reports a history the bot cannot read", async () => {
    const s = setup();
    const question = s.fake.postMessage({ authorId: s.alice, channelId: s.fake.channels.text, content: "hi", mentions: [s.fake.bot.id] });
    s.fake.fail({ reply: { code: 50001, status: 403 }, route: "list_channel_messages" });
    const context = await readDiscordTurnContext({
      attachments: discordAttachmentNamesOnly, conversationId: null, facts: { aiqsaMessages: async () => new Map() }, header: null, mergeWindowMs: 0,
      names: s.names, rest: s.rest, scope: { channelId: s.fake.channels.text, kind: "channel_window" }, trigger: trigger(s, question), uploads: null,
      userId: "svc_1"
    });
    expect(context).toEqual({ code: "discord_context_unavailable", ok: false });
  });
});

describe("Discord context messages", () => {
  it("reads embeds (another service's cards) and writes mentions as names", () => {
    const names: DiscordMentionNames = { botName: "agent", botRoleId: "1100000000000000003", botUserId: "1100000000000000002" };
    const decoded = decodeDiscordContextMessage({
      author: { bot: true, id: "1100000000000000002", username: "agent" }, channel_id: "1100000000000000010",
      content: "<@1100000000000000002> <@&1100000000000000003> <@&1100000000000000004> <#1100000000000000010> <:party:1100000000000000005>",
      embeds: [{ description: "Item 3 is blocked", fields: [{ name: "Owner", value: "Bob" }], footer: { text: "daily" }, title: "Daily card" }],
      id: "1100000000000000100", timestamp: "2026-11-12T09:00:00.000Z", type: 0
    }, names)!;
    expect(decoded.text).toBe("@agent @agent @role #channel :party:\n[embed] Daily card\nItem 3 is blocked\nOwner: Bob\ndaily");
    expect(decoded.bot).toBe(true);
  });
});

describe("Discord triggers", () => {
  const botUserId = "1100000000000000002";
  const botRoleId = "1100000000000000003";
  function message(fields: Record<string, unknown>) {
    return decodeDiscordIntakeMessage({
      author: { id: "1100000000000000050", username: "alice" }, channel_id: "1100000000000000010", content: "x", id: "1100000000000000100",
      mention_roles: [], mentions: [], type: 0, ...fields
    })!;
  }
  const ask = (fields: Record<string, unknown>, kind: DiscordChannelKind = "text", botOpenedThread = false) =>
    discordTrigger({ botOpenedThread, botRoleId, botUserId, kind, message: message(fields) });

  it("answers a direct message, a mention of the bot or its role, and a Reply to the bot", () => {
    expect(ask({}, "dm")).toBe("dm");
    expect(ask({ mentions: [{ id: botUserId }] })).toBe("mention");
    expect(ask({ mention_roles: [botRoleId] })).toBe("role_mention");
    expect(ask({ message_reference: { message_id: "1100000000000000090" }, referenced_message: { author: { id: botUserId } }, type: 19 }))
      .toBe("reply_to_bot");
    expect(ask({ mention_everyone: true })).toBeNull();
    expect(ask({})).toBeNull();
  });

  it("answers anyone in a thread it opened, except people talking to each other", () => {
    expect(ask({}, "thread", true)).toBe("bot_thread");
    expect(ask({ mentions: [{ id: "1100000000000000051" }] }, "thread", true)).toBeNull();
    expect(ask({ mention_roles: ["1100000000000000052"] }, "thread", true)).toBeNull();
    expect(ask({ mention_everyone: true }, "thread", true)).toBeNull();
    expect(ask({ message_reference: { message_id: "1100000000000000090" }, referenced_message: { author: { id: "1100000000000000051" } }, type: 19 },
      "thread", true)).toBeNull();
    expect(ask({ mentions: [{ id: botUserId }, { id: "1100000000000000051" }] }, "thread", true)).toBe("mention");
  });
});

describe("Discord refusals and failures", () => {
  it("maps send refusals and run failures by family, the model key's limit included", () => {
    expect(discordSendRefusalFailure({ code: "usage_budget_exhausted" })).toMatchObject({ failureKind: "admission", text: "AIQSA usage limit reached. Ask your AIQSA administrator." });
    expect(discordSendRefusalFailure({ code: "unauthorized" })).toMatchObject({ failureKind: "setup" });
    expect(discordSendRefusalFailure({ code: "credential_missing" }).text).toMatch(/model/u);
    expect(discordSendRefusalFailure({ code: "something_new" })).toMatchObject({ code: "something_new", text: "Something went wrong. Ask again." });
    for (const code of ["provider_rate_limited", "provider_quota_exhausted"]) {
      expect(discordRunFailure(code)).toEqual({
        code: "discord_key_limit", failureKind: "run", limitKind: "key", text: "The Discord model key has reached its daily limit."
      });
    }
    expect(discordRunFailure("context_too_large").text).toMatch(/too long/u);
    expect(discordRunFailure(null)).toMatchObject({ code: "run_failed", text: "Something went wrong. Ask again." });
  });

  it("tells an Assistant whose tools or model cannot run apart from one that is not set up", () => {
    for (const code of ["assistant_tools_not_available", "assistant_search_option_not_available"]) {
      expect(discordSendRefusalFailure({ code })).toEqual({ code, failureKind: "admission", text: DISCORD_BRIDGE_COPY.toolsUnavailable });
    }
    for (const code of ["assistant_model_not_available", "assistant_model_invalid"]) {
      expect(discordSendRefusalFailure({ code })).toEqual({ code, failureKind: "admission", text: DISCORD_BRIDGE_COPY.modelUnavailable });
    }
    expect(discordSendRefusalFailure({ code: "assistant_instructions_expansion_too_large" }))
      .toEqual({ code: "assistant_instructions_expansion_too_large", failureKind: "admission", text: DISCORD_BRIDGE_COPY.contextTooLarge });
    for (const code of ["assistant_not_available", "assistant_archived", "assistant_configuration_unavailable"]) {
      expect(discordSendRefusalFailure({ code })).toEqual({ code, failureKind: "setup", text: DISCORD_COPY.notSetUp });
    }
  });
});

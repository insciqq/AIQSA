import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord } from "@/tests/support/fakeDiscord";
import { captureRunObservation } from "@/tests/support/runObservation";
import {
  createDiscordRest, DISCORD_INVALID_REQUEST_LIMIT, DISCORD_INVALID_REQUEST_PAUSE_MS, discordNonce, discordStableNonce,
  type DiscordRestOptions
} from "./rest";
import type { DiscordHttpResult, DiscordTransport } from "./transport";

function clock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    advance: (ms: number) => { time += ms; },
    sleeps
  };
}

function restWith(transport: DiscordTransport, overrides: Partial<DiscordRestOptions> = {}) {
  const time = clock();
  const rest = createDiscordRest({ transport, token: () => createFakeDiscord().token, now: time.now, sleep: time.sleep, ...overrides });
  return { rest, time };
}

function stubTransport(answers: (() => DiscordHttpResult)[] | (() => DiscordHttpResult)) {
  const requests: Parameters<DiscordTransport["request"]>[0][] = [];
  const transport: DiscordTransport = {
    request: vi.fn(async (input: Parameters<DiscordTransport["request"]>[0]) => {
      requests.push(input);
      return typeof answers === "function" ? answers() : answers.shift()!();
    }),
    download: vi.fn(async () => ({ ok: false as const, kind: "forbidden_host" as const }))
  };
  return { requests, transport };
}

const ok = (json: unknown, rateLimit = {}): DiscordHttpResult => ({ ok: true, status: 200, rateLimit, json });

describe("Discord REST client against the fake", () => {
  it("creates messages with mentions off, embeds suppressed, link buttons, a nonce and enforce_nonce", async () => {
    const fake = createFakeDiscord();
    const { rest } = restWith(fake.transport);
    const author = fake.addUser({ username: "alice" });
    const question = fake.postMessage({ channelId: fake.channels.text, authorId: author, content: "@bot hi" });
    const created = await rest.createMessage(fake.channels.text, {
      content: "@everyone <@1> hello", replyTo: question.id, buttons: [[{ label: "Open in AIQSA", url: "https://example.com/s/abc" }]]
    }, { nonce: discordStableNonce(question.id, "a") });
    expect(created.ok).toBe(true);
    const [call] = fake.calls({ route: "create_message" });
    expect(call!.json).toEqual({
      content: "@everyone <@1> hello", allowed_mentions: { parse: [], replied_user: false }, flags: 4,
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open in AIQSA", url: "https://example.com/s/abc" }] }],
      message_reference: { message_id: question.id, fail_if_not_exists: false },
      nonce: discordStableNonce(question.id, "a"), enforce_nonce: true
    });
    expect(fake.violations()).toEqual([]);
  });

  it("refuses, unsent, what Discord or the policy would reject", async () => {
    const fake = createFakeDiscord();
    const { rest } = restWith(fake.transport);
    const cases = await Promise.all([
      rest.createMessage(fake.channels.text, { content: "x".repeat(2_001) }),
      rest.createMessage(fake.channels.text, { content: "" }),
      rest.createMessage(fake.channels.text, { content: "x", buttons: [[{ label: "x", url: "javascript:alert(1)" }]] }),
      rest.createMessage(fake.channels.text, { content: "x" }, { nonce: "not-ours" }),
      rest.startThreadFromMessage(fake.channels.text, "1", { name: "x".repeat(101) }),
      rest.listChannelMessages(fake.channels.text, { limit: 101 }),
      rest.addOwnReaction(fake.channels.text, "1", "a/b"),
      rest.getGuildMember("../x", "1"),
      rest.archiveThread("../x")
    ]);
    for (const outcome of cases) expect(outcome).toEqual({ ok: false, code: "discord_request_invalid", delivery: "not_sent" });
    expect(fake.calls()).toEqual([]);
  });

  it("repeats a create after an ambiguous drop and Discord's nonce check returns the first message", async () => {
    const fake = createFakeDiscord();
    // The first attempt reaches Discord, then the connection drops before the answer.
    const original = fake.transport;
    let dropped = false;
    const transport: DiscordTransport = {
      ...original,
      request: async (input) => {
        const result = await original.request(input);
        if (!dropped && input.method === "POST") { dropped = true; return { ok: false, kind: "network_after_send", category: "reset" }; }
        return result;
      }
    };
    const { rest } = restWith(transport);
    const nonce = discordNonce();
    expect(nonce).toMatch(/^aiqsa[a-z0-9]{1,20}$/u);
    expect(nonce.length).toBeLessThanOrEqual(25);
    const created = await rest.createMessage(fake.channels.text, { content: "answer" }, { nonce });
    expect(created.ok).toBe(true);
    expect(fake.calls({ route: "create_message" })).toHaveLength(2);
    expect(fake.messages(fake.channels.text)).toHaveLength(1);
    expect(fake.messages(fake.channels.text)[0]).toMatchObject({ nonce });
  });

  it("archives a thread with archived: true only", async () => {
    const fake = createFakeDiscord();
    const { rest } = restWith(fake.transport);
    const author = fake.addUser({ username: "alice" });
    const question = fake.postMessage({ channelId: fake.channels.text, authorId: author, content: "@bot hi" });
    expect((await rest.startThreadFromMessage(fake.channels.text, question.id, { name: "Question" })).ok).toBe(true);
    expect(await rest.archiveThread(question.id)).toMatchObject({ ok: true, value: { id: question.id } });
    expect(fake.calls({ route: "archive_thread" }).map((call) => [call.method, call.path, call.json]))
      .toEqual([["PATCH", `/channels/${question.id}`, { archived: true }]]);
    expect(fake.channel(question.id)?.thread_metadata).toEqual({ archived: true });
    // A text channel is no thread: Discord refuses.
    expect(await rest.archiveThread(fake.channels.text)).toMatchObject({ ok: false, delivery: "refused", status: 400 });
    expect(fake.violations()).toEqual([]);
  });

  it("never repeats a thread start after an ambiguous failure", async () => {
    const { rest } = restWith(stubTransport([() => ({ ok: false, kind: "timeout" })]).transport);
    expect(await rest.startThreadFromMessage("1", "2", { name: "Question" }))
      .toEqual({ ok: false, code: "discord_request_timeout", delivery: "unknown" });
  });

  it("waits retry_after on a 429 and repeats once, logging scope and wait", async () => {
    const observation = await captureRunObservation();
    const fake = createFakeDiscord();
    const { rest, time } = restWith(fake.transport);
    fake.fail({ route: "trigger_typing", reply: { status: 429, retryAfter: 2.5 } });
    expect(await rest.triggerTyping(fake.channels.text)).toEqual({ ok: true, value: null });
    expect(time.sleeps).toContain(2_500);
    expect(fake.calls({ route: "trigger_typing" }).map((call) => call.status)).toEqual([429, 204]);
    expect(observation.records().filter((record) => record.event === "discord_rest")).toEqual([
      expect.objectContaining({ route: "trigger_typing", outcome: "rate_limited", scope: "user", retry_after_ms: 2_500, code: "discord_rate_limited" })
    ]);

    fake.fail({ route: "trigger_typing", times: 2, reply: { status: 429, retryAfter: 1 } });
    expect(await rest.triggerTyping(fake.channels.text)).toMatchObject({ ok: false, code: "discord_rate_limited", delivery: "refused", retryAfterMs: 1_000 });
  });

  it("pauses every route on a global 429", async () => {
    const fake = createFakeDiscord();
    const { rest, time } = restWith(fake.transport);
    fake.fail({ route: "get_current_user", times: 2, reply: { status: 429, retryAfter: 3, global: true } });
    expect(await rest.getCurrentUser()).toMatchObject({ ok: false, code: "discord_rate_limited" });
    expect(rest.state().globalPausedUntil).toBe(time.now() + 3_000);
    const sleeps = time.sleeps.length;
    expect((await rest.listCurrentUserGuilds()).ok).toBe(true);
    expect(time.sleeps.slice(sleeps)).toEqual([3_000]);
  });

  it("caps retry_after at 60 s", async () => {
    const fake = createFakeDiscord();
    const { rest, time } = restWith(fake.transport);
    fake.fail({ route: "get_gateway_bot", reply: { status: 429, retryAfter: 3_600 } });
    expect((await rest.getGatewayBot()).ok).toBe(true);
    expect(time.sleeps).toEqual([60_000]);
  });

  it("encodes the reaction emoji and edits keep mentions off", async () => {
    const fake = createFakeDiscord();
    const { rest } = restWith(fake.transport);
    const author = fake.addUser({ username: "bob" });
    const question = fake.postMessage({ channelId: fake.channels.text, authorId: author, content: "q" });
    expect((await rest.addOwnReaction(fake.channels.text, question.id, "👀")).ok).toBe(true);
    expect(fake.calls({ route: "add_own_reaction" })[0]!.path).toContain(encodeURIComponent("👀"));
    expect(fake.reactions(question.id, "👀")).toEqual([fake.bot.id]);
    const status = await rest.createMessage(fake.channels.text, { content: "Working · 0:01" });
    expect(status.ok).toBe(true);
    const id = status.ok ? status.value.id : "";
    expect((await rest.editMessage(fake.channels.text, id, { content: "Done", buttons: [] })).ok).toBe(true);
    expect(fake.calls({ route: "edit_message" })[0]!.json).toMatchObject({ allowed_mentions: { parse: [] }, flags: 4 });
    expect((await rest.deleteMessage(fake.channels.text, id)).ok).toBe(true);
    expect(fake.violations()).toEqual([]);
  });

  it("uploads files as multipart with payload_json and attachments", async () => {
    const fake = createFakeDiscord();
    const { rest } = restWith(fake.transport);
    const created = await rest.createMessage(fake.channels.text, {
      content: "files", files: [{ filename: "a.txt", contentType: "text/plain", data: Buffer.from("A") },
        { filename: "b.bin", contentType: "application/octet-stream", stream: Readable.from([Buffer.from("BB")]), size: 2 }]
    });
    expect(created.ok).toBe(true);
    const [call] = fake.calls({ route: "create_message" });
    expect(call!.files).toEqual([{ filename: "a.txt", size: 1, contentType: "text/plain" }, { filename: "b.bin", size: 2, contentType: "application/octet-stream" }]);
    expect(call!.json).toMatchObject({ attachments: [{ id: 0, filename: "a.txt" }, { id: 1, filename: "b.bin" }], allowed_mentions: { parse: [] } });
  });
});

describe("Discord REST limiter", () => {
  it("waits for a bucket whose remaining reached zero, keyed by the route's major parameter", async () => {
    const limited = { bucket: "abc", remaining: 0, resetAfterMs: 4_000 };
    const { transport } = stubTransport(() => ok([], limited));
    const { rest, time } = restWith(transport);
    await rest.listChannelMessages("11");
    expect(time.sleeps).toEqual([]);
    await rest.listChannelMessages("22");
    expect(time.sleeps).toEqual([]);
    await rest.listChannelMessages("11");
    expect(time.sleeps).toEqual([4_000]);
  });

  it("spaces requests to 50 a second", async () => {
    const { transport } = stubTransport(() => ok(null));
    const { rest, time } = restWith(transport);
    for (let index = 0; index < 50; index += 1) await rest.triggerTyping(String(index + 1));
    expect(time.sleeps).toEqual([]);
    await rest.triggerTyping("99");
    expect(time.sleeps).toEqual([1_000]);
  });

  it("pauses all sends for 10 minutes after more than 1000 invalid requests in 10 minutes", async () => {
    const observation = await captureRunObservation();
    const { transport } = stubTransport(() => ({ ok: true, status: 403, rateLimit: {}, json: { code: 50013, message: "Missing Permissions" } }));
    const { rest, time } = restWith(transport);
    for (let index = 0; index <= DISCORD_INVALID_REQUEST_LIMIT; index += 1) {
      const outcome = await rest.getChannelMessage("1", "2");
      expect(outcome).toMatchObject({ ok: false, code: "discord_api_error", delivery: "refused", status: 403, discordCode: 50013 });
      time.advance(100);
    }
    const calls = vi.mocked(transport.request).mock.calls.length;
    expect(rest.state().invalidPausedUntil).not.toBeNull();
    expect(await rest.getCurrentUser()).toMatchObject({ ok: false, code: "discord_invalid_requests", delivery: "not_sent" });
    expect(vi.mocked(transport.request).mock.calls.length).toBe(calls);
    expect(observation.records().filter((record) => record.event === "discord_rest" && record.outcome === "paused")).toHaveLength(1);
    time.advance(DISCORD_INVALID_REQUEST_PAUSE_MS);
    expect((await rest.getChannelMessage("1", "2")).ok).toBe(false);
    expect(vi.mocked(transport.request).mock.calls.length).toBe(calls + 1);
  });

  it("does not count a shared-scope 429 as invalid", async () => {
    const { transport } = stubTransport(() => ({ ok: true, status: 429, rateLimit: { scope: "shared" }, json: { retry_after: 0.1, global: false } }));
    const { rest } = restWith(transport);
    await rest.triggerTyping("1");
    expect(rest.state().invalidCount).toBe(0);
  });

  it("asks the kill switch before sending and again after a wait", async () => {
    const { transport } = stubTransport(() => ok(null, { bucket: "b", remaining: 0, resetAfterMs: 1_000 }));
    let allowed = true;
    // The switch turns off while the second call waits for its bucket.
    const { rest } = restWith(transport, { authorize: () => allowed, sleep: async () => { allowed = false; } });
    await rest.triggerTyping("1");
    expect(await rest.triggerTyping("1")).toEqual({ ok: false, code: "discord_disabled", delivery: "not_sent" });
    expect(await rest.getCurrentUser()).toEqual({ ok: false, code: "discord_disabled", delivery: "not_sent" });
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it("repeats an idempotent read once after a 5xx or a failure before sending, a create only before sending", async () => {
    const { transport, requests } = stubTransport([
      () => ({ ok: true, status: 502, rateLimit: {}, json: undefined }), () => ok({ id: "1", username: "bot" }),
      () => ({ ok: false, kind: "network_before_send", category: "connect" }), () => ok({ id: "5", type: 11, parent_id: "1" }),
      () => ({ ok: true, status: 500, rateLimit: {}, json: undefined })
    ]);
    const { rest } = restWith(transport);
    expect((await rest.getCurrentUser()).ok).toBe(true);
    expect((await rest.startThreadFromMessage("1", "2", { name: "T" })).ok).toBe(true);
    expect(requests).toHaveLength(4);
    expect(await rest.startThreadFromMessage("1", "2", { name: "T" })).toMatchObject({ ok: false, code: "discord_http_error", delivery: "unknown" });
  });

  it("refuses a call without a token and never reaches command or interaction endpoints", async () => {
    const { transport } = stubTransport(() => ok(null));
    const { rest } = restWith(transport, { token: () => null });
    expect(await rest.getCurrentUser()).toEqual({ ok: false, code: "discord_token_missing", delivery: "not_sent" });
    expect(Object.keys(rest).filter((name) => /command|interaction/iu.test(name))).toEqual([]);
    const fake = createFakeDiscord();
    for (const path of ["/applications/1/commands", "/applications/1/guilds/2/commands/3", "/interactions/1/token/callback"]) {
      await expect(fake.transport.request({ token: fake.token, method: "PUT", path })).rejects.toMatchObject({ code: "discord_request_invalid" });
    }
  });
});

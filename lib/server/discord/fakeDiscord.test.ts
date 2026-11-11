import { describe, expect, it } from "vitest";
import { createFakeDiscord } from "@/tests/support/fakeDiscord";

const API = "https://discord.com/api/v10";

function call(fake: ReturnType<typeof createFakeDiscord>, method: string, path: string, body?: unknown, auth = true) {
  return fake.fetch(`${API}${path}`, {
    method, headers: { ...(auth ? { authorization: `Bot ${fake.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

const MENTIONS_OFF = { parse: [] };

describe("fake Discord REST", () => {
  it("refuses a wrong token and serves the bot, application, guild and channels", async () => {
    const fake = createFakeDiscord();
    expect((await call(fake, "GET", "/users/@me", undefined, false)).status).toBe(401);
    expect(await (await call(fake, "GET", "/users/@me")).json()).toMatchObject({ id: fake.bot.id, bot: true });
    expect(await (await call(fake, "GET", "/oauth2/applications/@me")).json()).toMatchObject({ id: fake.application.id, bot: { id: fake.bot.id } });
    expect(await (await call(fake, "GET", "/users/@me/guilds")).json()).toEqual([fake.guild]);
    const channels = await (await call(fake, "GET", `/guilds/${fake.guild.id}/channels`)).json() as { type: number }[];
    expect(channels.map((channel) => channel.type).sort()).toEqual([0, 15, 2, 5].sort());
    const member = fake.addUser({ username: "dana", nick: "Dana" });
    const outsider = fake.addUser({ username: "eve", member: false });
    expect((await call(fake, "GET", `/guilds/${fake.guild.id}/members/${member}`)).status).toBe(200);
    expect(await (await call(fake, "GET", `/guilds/${fake.guild.id}/members/${outsider}`)).json()).toMatchObject({ code: 10007 });
  });

  it("enforces 2000 characters, empty allowed_mentions.parse and link-only buttons", async () => {
    const fake = createFakeDiscord();
    const channel = fake.channels.text;
    expect((await call(fake, "POST", `/channels/${channel}/messages`, { content: "x".repeat(2_001), allowed_mentions: MENTIONS_OFF })).status).toBe(400);
    expect((await call(fake, "POST", `/channels/${channel}/messages`, { content: "hi" })).status).toBe(400);
    expect((await call(fake, "POST", `/channels/${channel}/messages`, { content: "hi", allowed_mentions: { parse: ["everyone"] } })).status).toBe(400);
    const custom = { content: "hi", allowed_mentions: MENTIONS_OFF, components: [{ type: 1, components: [{ type: 2, style: 1, label: "x", custom_id: "y" }] }] };
    expect((await call(fake, "POST", `/channels/${channel}/messages`, custom)).status).toBe(400);
    expect(fake.violations()).toEqual(["rest:allowed_mentions", "rest:allowed_mentions", "rest:component"]);
    const link = { content: "hi", allowed_mentions: MENTIONS_OFF, components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open", url: "https://example.com" }] }] };
    expect((await call(fake, "POST", `/channels/${channel}/messages`, link)).status).toBe(200);
  });

  it("refuses files over 20 MiB and requests over 25 MiB", async () => {
    const fake = createFakeDiscord();
    const upload = (sizes: number[]) => {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ allowed_mentions: MENTIONS_OFF, attachments: sizes.map((_, id) => ({ id, filename: `f${id}` })) }));
      sizes.forEach((size, index) => form.set(`files[${index}]`, new Blob([new Uint8Array(size)]), `f${index}`));
      return fake.fetch(`${API}/channels/${fake.channels.text}/messages`, { method: "POST", headers: { authorization: `Bot ${fake.token}` }, body: form });
    };
    expect((await upload([20 * 1024 * 1024 + 1])).status).toBe(413);
    expect((await upload([15 * 1024 * 1024, 11 * 1024 * 1024])).status).toBe(413);
    expect((await upload([1024])).status).toBe(200);
  });

  it("returns the original message for a repeated nonce with enforce_nonce and echoes the nonce", async () => {
    const fake = createFakeDiscord();
    const body = { content: "once", allowed_mentions: MENTIONS_OFF, nonce: "aiqsa1abc", enforce_nonce: true };
    const first = await (await call(fake, "POST", `/channels/${fake.channels.text}/messages`, body)).json() as { id: string; nonce: string };
    const second = await (await call(fake, "POST", `/channels/${fake.channels.text}/messages`, body)).json() as { id: string };
    expect(second.id).toBe(first.id);
    expect(first.nonce).toBe("aiqsa1abc");
    fake.advance(6 * 60_000);
    const third = await (await call(fake, "POST", `/channels/${fake.channels.text}/messages`, body)).json() as { id: string };
    expect(third.id).not.toBe(first.id);
  });

  it("starts threads from messages with names of 1–100 characters, once, and never in voice channels", async () => {
    const fake = createFakeDiscord();
    const author = fake.addUser({ username: "frank" });
    const message = fake.postMessage({ channelId: fake.channels.text, authorId: author, content: "q" });
    const path = `/channels/${fake.channels.text}/messages/${message.id}/threads`;
    expect((await call(fake, "POST", path, { name: "" })).status).toBe(400);
    expect((await call(fake, "POST", path, { name: "x".repeat(101) })).status).toBe(400);
    const thread = await (await call(fake, "POST", path, { name: "q", auto_archive_duration: 1440 })).json() as { id: string; parent_id: string; type: number };
    expect(thread).toMatchObject({ id: message.id, parent_id: fake.channels.text, type: 11 });
    expect(await (await call(fake, "POST", path, { name: "again" })).json()).toMatchObject({ code: 160004 });
    const voiceMessage = fake.postMessage({ channelId: fake.channels.voice, authorId: author, content: "q" });
    expect((await call(fake, "POST", `/channels/${fake.channels.voice}/messages/${voiceMessage.id}/threads`, { name: "q" })).status).toBe(400);
  });

  it("pages history newest first with before and after", async () => {
    const fake = createFakeDiscord();
    const author = fake.addUser({ username: "gina" });
    const posted = Array.from({ length: 5 }, (_, index) => fake.postMessage({ channelId: fake.channels.text, authorId: author, content: `m${index}` }));
    const page = await (await call(fake, "GET", `/channels/${fake.channels.text}/messages?limit=2`)).json() as { content: string }[];
    expect(page.map((entry) => entry.content)).toEqual(["m4", "m3"]);
    const before = await (await call(fake, "GET", `/channels/${fake.channels.text}/messages?limit=2&before=${posted[3]!.id}`)).json() as { content: string }[];
    expect(before.map((entry) => entry.content)).toEqual(["m2", "m1"]);
    const after = await (await call(fake, "GET", `/channels/${fake.channels.text}/messages?limit=2&after=${posted[1]!.id}`)).json() as { content: string }[];
    expect(after.map((entry) => entry.content)).toEqual(["m3", "m2"]);
    const forum = fake.createForumPost({ forumId: fake.channels.forum, authorId: author, name: "Post", content: "first" });
    expect(forum.message.id).toBe(forum.threadId);
  });

  it("injects 429s, error statuses and drops, records calls without the token and flags command routes", async () => {
    const fake = createFakeDiscord();
    fake.fail({ route: "get_current_user", reply: { status: 429, retryAfter: 1.5, global: true } });
    const limited = await call(fake, "GET", "/users/@me");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-ratelimit-scope")).toBe("global");
    expect(await limited.json()).toMatchObject({ retry_after: 1.5, global: true });
    fake.fail({ route: "get_current_user", reply: { status: 403, code: 50013 } });
    expect((await call(fake, "GET", "/users/@me")).status).toBe(403);
    fake.fail({ method: "GET", reply: { drop: "after_send" } });
    await expect(call(fake, "GET", "/users/@me")).rejects.toThrow(TypeError);
    expect((await call(fake, "PUT", "/applications/1/commands", [])).status).toBe(404);
    expect(fake.violations()).toEqual(["rest:PUT forbidden route"]);
    expect(fake.calls({ route: "get_current_user" }).map((entry) => entry.status)).toEqual([429, 403, 0]);
    expect(JSON.stringify(fake.calls())).not.toContain(fake.token);
    fake.setSessionStartLimit({ remaining: 150 });
    expect(await (await call(fake, "GET", "/gateway/bot")).json()).toMatchObject({ session_start_limit: { remaining: 150, total: 1000 } });
  });

  it("dispatches gateway events for messages, edits, deletions, reactions and threads", async () => {
    const fake = createFakeDiscord();
    const socket = fake.gateway.openSocket(new URL("wss://gateway.discord.gg/?v=10&encoding=json"));
    const received: { t?: string; op: number; d?: { nonce?: string; ids?: string[] } }[] = [];
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data)) as never));
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.send(JSON.stringify({ op: 2, d: { token: fake.token, intents: 46593, properties: {} } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const author = fake.addUser({ username: "hank" });
    const message = fake.postMessage({ channelId: fake.channels.text, authorId: author, content: "hi" });
    fake.editUserMessage(fake.channels.text, message.id, "hi!");
    fake.react(author, fake.channels.text, message.id, "👍");
    fake.unreact(author, fake.channels.text, message.id, "👍");
    await call(fake, "POST", `/channels/${fake.channels.text}/messages`, { content: "a", allowed_mentions: MENTIONS_OFF, nonce: "aiqsa2", enforce_nonce: true });
    fake.deleteMessage(fake.channels.text, message.id);
    fake.bulkDelete(fake.channels.text, ["1", "2"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received.map((entry) => entry.t ?? `op${entry.op}`)).toEqual([
      "op10", "READY", "GUILD_CREATE", "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE",
      "MESSAGE_CREATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"
    ]);
    expect(received.find((entry) => entry.d?.nonce)?.d?.nonce).toBe("aiqsa2");
    socket.send(JSON.stringify({ op: 3, d: { status: "online" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.violations()).toEqual(["gateway:op_3"]);
  });
});

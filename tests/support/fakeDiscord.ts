import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DISCORD_BOT_TOKEN_PATTERN } from "@/lib/contracts/discord";
import {
  DISCORD_CDN_HOSTS, DISCORD_DOWNLOAD_MAX_BYTES, DISCORD_FILE_MAX_BYTES, DISCORD_JSON_RESPONSE_MAX_BYTES,
  DISCORD_UPLOAD_FILES_MAX, DISCORD_UPLOAD_MAX_BYTES, discordRateLimitHeaders, isDiscordRestPathAllowed,
  DiscordTransportConfigError, type DiscordHttpResult, type DiscordTransport, type DiscordWebSocketLike
} from "@/lib/server/discord/transport";

/**
 * An in-memory Discord for tests: one guild with text, announcement, forum
 * and voice channels, threads, members, messages with ordered synthetic
 * snowflakes, reactions and CDN files. REST is served two ways — `fetch` and
 * the matching `transport` for vitest, and `start()`, a loopback `node:http`
 * server for the real pinned transport (`AIQSA_DISCORD_API_ORIGIN`). The
 * gateway is served in memory (`gateway.openSocket`, for fake timers) and
 * over loopback WebSockets from `start()`: the main URL on `127.0.0.1` and the
 * session's `resume_gateway_url` on `localhost` at another port.
 *
 * Stricter than Discord where AIQSA must never do something: every message
 * needs `allowed_mentions.parse` empty, buttons are link buttons only,
 * presence and application-command endpoints are recorded as violations.
 */

export const FAKE_DISCORD_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.FAKE00.fake-discord-bot-token-for-tests-0000";
const SNOWFLAKE_START = 1_100_000_000_000_000_000n;
const NONCE_WINDOW_MS = 5 * 60_000;
const CDN_ORIGIN = "https://cdn.discordapp.com";
const MEDIA_ORIGIN = "https://media.discordapp.net";
/** APPLICATION flags: GATEWAY_MESSAGE_CONTENT and its limited variant. */
export const FAKE_DISCORD_MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

export const FAKE_DISCORD_CHANNEL_TYPES = Object.freeze({
  text: 0, dm: 1, voice: 2, announcement: 5, announcementThread: 10, publicThread: 11, privateThread: 12, forum: 15
});

export type FakeDiscordUser = { id: string; username: string; global_name: string | null; bot?: boolean };
export type FakeDiscordChannel = {
  id: string; type: number; name: string | null; guild_id?: string; parent_id?: string | null;
  recipients?: FakeDiscordUser[];
};
export type FakeDiscordAttachment = {
  id: string; filename: string; size: number; content_type: string; url: string; proxy_url: string;
};
export type FakeDiscordMessage = {
  id: string; channel_id: string; guild_id?: string; author: FakeDiscordUser; content: string; timestamp: string;
  edited_timestamp: string | null; type: number; mentions: FakeDiscordUser[]; mention_roles: string[];
  mention_everyone: boolean; attachments: FakeDiscordAttachment[]; components: unknown[]; flags: number;
  message_reference?: { message_id: string; channel_id: string; guild_id?: string };
  referenced_message?: FakeDiscordMessage | null;
  nonce?: string; webhook_id?: string;
};
export type FakeDiscordCall = Readonly<{
  method: string; route: string; path: string; query: Readonly<Record<string, string>>; status: number;
  json?: unknown; files?: readonly Readonly<{ filename: string; size: number; contentType: string }>[];
}>;
export type FakeDiscordReply =
  | Readonly<{ status: 429; retryAfter: number; global?: boolean; scope?: "user" | "global" | "shared" }>
  | Readonly<{ status: 400 | 401 | 403 | 404 | 500 | 502; code?: number }>
  | Readonly<{ drop: "before_send" | "after_send" }>
  | Readonly<{ delayMs: number }>;
export type FakeDiscordFailureRule = Readonly<{ route?: string; method?: string; times?: number; reply: FakeDiscordReply }>;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: number) { super("fake discord refusal"); }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }
  });
}

const ROUTES: readonly (readonly [string, string, RegExp])[] = [
  ["GET", "get_current_user", /^\/users\/@me$/u],
  ["GET", "get_current_application", /^\/oauth2\/applications\/@me$/u],
  ["GET", "list_current_user_guilds", /^\/users\/@me\/guilds$/u],
  ["GET", "list_guild_channels", /^\/guilds\/(\d+)\/channels$/u],
  ["GET", "get_channel", /^\/channels\/(\d+)$/u],
  ["GET", "get_guild_member", /^\/guilds\/(\d+)\/members\/(\d+)$/u],
  ["GET", "get_gateway_bot", /^\/gateway\/bot$/u],
  ["GET", "list_channel_messages", /^\/channels\/(\d+)\/messages$/u],
  ["GET", "get_channel_message", /^\/channels\/(\d+)\/messages\/(\d+)$/u],
  ["POST", "create_message", /^\/channels\/(\d+)\/messages$/u],
  ["PATCH", "edit_message", /^\/channels\/(\d+)\/messages\/(\d+)$/u],
  ["DELETE", "delete_message", /^\/channels\/(\d+)\/messages\/(\d+)$/u],
  ["POST", "start_thread_from_message", /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/u],
  ["POST", "trigger_typing", /^\/channels\/(\d+)\/typing$/u],
  ["PUT", "add_own_reaction", /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/u],
  ["DELETE", "remove_own_reaction", /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/u]
];

function routeOf(method: string, path: string): Readonly<{ name: string; params: string[] }> | null {
  for (const [routeMethod, name, pattern] of ROUTES) {
    const match = routeMethod === method ? pattern.exec(path) : null;
    if (match) return { name, params: match.slice(1) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 server side, enough for the gateway fake.

type WireConnection = Readonly<{ send(text: string): void; close(code: number): void; drop(): void }>;

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([head, payload]);
}

function acceptUpgrade(request: IncomingMessage, socket: Duplex, onText: (text: string) => void, onClose: (code: number) => void): WireConnection | null {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return null; }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let closed = false;
  const finish = (code: number) => { if (!closed) { closed = true; onClose(code); } };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index]! ^= buffer[maskOffset + (index % 4)]!;
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!socket.destroyed) socket.end(frame(0x8, payload.subarray(0, 2)));
        finish(code);
        return;
      }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        onText(text);
      }
    }
  });
  socket.on("close", () => finish(1006));
  socket.on("error", () => undefined);
  return {
    send: (text) => { if (!closed && !socket.destroyed) socket.write(frame(0x1, Buffer.from(text, "utf8"))); },
    close: (code) => {
      if (closed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      socket.end(frame(0x8, payload));
      finish(code);
    },
    drop: () => { socket.destroy(); finish(1006); }
  };
}

// ---------------------------------------------------------------------------
// In-memory WebSocket for fake-timer tests.

class MemorySocket implements DiscordWebSocketLike {
  readyState = 0;
  private listeners: { [key: string]: ((event: never) => void)[] } = {};
  constructor(private readonly server: Readonly<{ onText(text: string): void; onClientClose(code: number): void }>) {}
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event as never);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    queueMicrotask(() => this.server.onText(data));
  }
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => { this.server.onClientClose(code); this.emit("close", { code }); });
  }
  serverClose(code: number): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code }));
  }
}

// ---------------------------------------------------------------------------

export type FakeDiscordOptions = Readonly<{
  token?: string;
  guildName?: string;
  heartbeatIntervalMs?: number;
  messageContentEnabled?: boolean;
}>;

type GatewayConnection = {
  id: number; via: "main" | "resume" | "memory"; host: string; sessionId: string | null; ready: boolean;
  wire: WireConnection; commands: number[];
};
type GatewaySession = { id: string; seq: number; events: { s: number; t: string; d: unknown }[]; invalid: boolean };

export function createFakeDiscord(options: FakeDiscordOptions = {}) {
  const token = options.token ?? FAKE_DISCORD_TOKEN;
  let nextId = SNOWFLAKE_START;
  const id = () => String(nextId++);
  let clock = Date.parse("2026-11-12T09:00:00.000Z");
  const timestamp = () => new Date(clock += 1_000).toISOString();

  const application = { id: id(), flags: options.messageContentEnabled === false ? 0 : FAKE_DISCORD_MESSAGE_CONTENT_FLAGS };
  const bot: FakeDiscordUser = { id: id(), username: "aiqsa-test", global_name: "AIQSA Test", bot: true };
  const guild = { id: id(), name: options.guildName ?? "Example server" };
  const botRoleId = id();
  const users = new Map<string, FakeDiscordUser>([[bot.id, bot]]);
  const members = new Map<string, { nick: string | null; roles: string[] }>([[bot.id, { nick: null, roles: [botRoleId] }]]);
  const channels = new Map<string, FakeDiscordChannel>();
  const messages = new Map<string, FakeDiscordMessage[]>();
  const files = new Map<string, { bytes: Buffer; contentType: string; filename: string; signature: string }>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  const nonces = new Map<string, { messageId: string; at: number }>();
  const calls: FakeDiscordCall[] = [];
  const violations: string[] = [];
  const failures: { route?: string; method?: string; remaining: number; reply: FakeDiscordReply }[] = [];
  let sessionStartLimit = { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 };
  let gatewayUrls = { main: "wss://gateway.discord.gg", resume: "wss://gateway-test.discord.gg" };

  function addChannel(input: Readonly<{ type: number; name: string | null; parentId?: string; guild?: boolean }>): string {
    const channelId = id();
    channels.set(channelId, {
      id: channelId, type: input.type, name: input.name,
      ...(input.guild === false ? {} : { guild_id: guild.id, parent_id: input.parentId ?? null })
    });
    messages.set(channelId, []);
    return channelId;
  }
  const defaults = {
    text: addChannel({ type: FAKE_DISCORD_CHANNEL_TYPES.text, name: "agent-test" }),
    announcement: addChannel({ type: FAKE_DISCORD_CHANNEL_TYPES.announcement, name: "announcements" }),
    forum: addChannel({ type: FAKE_DISCORD_CHANNEL_TYPES.forum, name: "questions" }),
    voice: addChannel({ type: FAKE_DISCORD_CHANNEL_TYPES.voice, name: "voice-room" })
  };

  function addUser(input: Readonly<{ username: string; globalName?: string | null; bot?: boolean; member?: boolean; nick?: string | null }>): string {
    const userId = id();
    users.set(userId, { id: userId, username: input.username, global_name: input.globalName ?? null, ...(input.bot ? { bot: true } : {}) });
    if (input.member !== false) members.set(userId, { nick: input.nick ?? null, roles: [] });
    return userId;
  }

  function channel(channelId: string): FakeDiscordChannel {
    const found = channels.get(channelId);
    if (!found) throw new HttpError(404, 10003);
    return found;
  }

  function findMessage(channelId: string, messageId: string): FakeDiscordMessage {
    const found = (messages.get(channelId) ?? []).find((entry) => entry.id === messageId);
    if (!found) throw new HttpError(404, 10008);
    return found;
  }

  function attach(channelId: string, input: Readonly<{ filename: string; data: Buffer; contentType: string }>): FakeDiscordAttachment {
    const attachmentId = id();
    const signature = randomBytes(16).toString("hex");
    files.set(attachmentId, { bytes: input.data, contentType: input.contentType, filename: input.filename, signature });
    const path = `/attachments/${channelId}/${attachmentId}/${encodeURIComponent(input.filename)}?ex=${(Math.floor(clock / 1000) + 86_400).toString(16)}&is=${Math.floor(clock / 1000).toString(16)}&hm=${signature}&`;
    return {
      id: attachmentId, filename: input.filename, size: input.data.length, content_type: input.contentType,
      url: `${CDN_ORIGIN}${path}`, proxy_url: `${MEDIA_ORIGIN}${path}`
    };
  }

  function memberPayload(userId: string): unknown {
    const member = members.get(userId);
    return member ? { nick: member.nick, roles: member.roles } : undefined;
  }

  function messageEvent(message: FakeDiscordMessage): unknown {
    const member = message.guild_id ? memberPayload(message.author.id) : undefined;
    return { ...message, ...(member ? { member } : {}) };
  }

  // -------------------------------------------------------------------------
  // Gateway model

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 41_250;
  const sessions = new Map<string, GatewaySession>();
  const connections: GatewayConnection[] = [];
  const received: { connection: number; op: number; d: unknown }[] = [];
  let withholdAcks = false;
  let connectionCounter = 0;
  let currentSession: GatewaySession | null = null;

  function sendTo(connection: GatewayConnection, payload: unknown): void {
    connection.wire.send(JSON.stringify(payload));
  }

  function activeConnection(): GatewayConnection | undefined {
    return [...connections].reverse().find((entry) => entry.ready && entry.sessionId === currentSession?.id);
  }

  function dispatch(type: string, data: unknown): number | null {
    if (!currentSession) return null;
    const s = ++currentSession.seq;
    currentSession.events.push({ s, t: type, d: data });
    const connection = activeConnection();
    if (connection) sendTo(connection, { op: 0, t: type, s, d: data });
    return s;
  }

  function gatewayCommand(connection: GatewayConnection, text: string): void {
    if (Buffer.byteLength(text, "utf8") > 4096) { connection.wire.close(4002); return; }
    const now = Date.now();
    connection.commands = connection.commands.filter((time) => time > now - 60_000);
    connection.commands.push(now);
    if (connection.commands.length > 120) { connection.wire.close(4008); return; }
    let payload: { op?: unknown; d?: unknown };
    try { payload = JSON.parse(text) as { op?: unknown; d?: unknown }; } catch { connection.wire.close(4002); return; }
    const data = payload.d && typeof payload.d === "object" ? payload.d as Record<string, unknown> : {};
    const { token: sentToken, ...rest } = data;
    received.push({ connection: connection.id, op: Number(payload.op), d: payload.op === 1 ? payload.d : { ...rest, tokenMatched: sentToken === token } });
    if (payload.op === 1) {
      if (!withholdAcks) sendTo(connection, { op: 11 });
      return;
    }
    if (payload.op === 2) {
      if (sentToken !== token) { connection.wire.close(4004); return; }
      if ("presence" in data) violations.push("gateway:presence");
      const intents = Number(data.intents);
      if (!Number.isSafeInteger(intents)) { connection.wire.close(4013); return; }
      if ((intents & (1 << 15)) !== 0 && application.flags === 0) { connection.wire.close(4014); return; }
      sessionStartLimit = { ...sessionStartLimit, remaining: Math.max(0, sessionStartLimit.remaining - 1) };
      const session: GatewaySession = { id: randomBytes(16).toString("hex"), seq: 0, events: [], invalid: false };
      sessions.set(session.id, session);
      currentSession = session;
      connection.sessionId = session.id;
      connection.ready = true;
      dispatch("READY", {
        v: 10, user: bot, guilds: [{ id: guild.id, unavailable: true }], session_id: session.id,
        resume_gateway_url: gatewayUrls.resume, shard: [0, 1], application: { id: application.id, flags: application.flags }
      });
      dispatch("GUILD_CREATE", { id: guild.id, name: guild.name, channels: [...channels.values()].filter((entry) => entry.guild_id && entry.type !== 11 && entry.type !== 10 && entry.type !== 12) });
      return;
    }
    if (payload.op === 6) {
      const session = typeof data.session_id === "string" ? sessions.get(data.session_id) : undefined;
      if (sentToken !== token) { connection.wire.close(4004); return; }
      if (!session || session.invalid || typeof data.seq !== "number" || data.seq > session.seq) {
        sendTo(connection, { op: 9, d: false });
        return;
      }
      currentSession = session;
      connection.sessionId = session.id;
      connection.ready = true;
      for (const event of session.events.filter((entry) => entry.s > (data.seq as number))) {
        sendTo(connection, { op: 0, t: event.t, s: event.s, d: event.d });
      }
      dispatch("RESUMED", {});
      return;
    }
    violations.push(`gateway:op_${String(payload.op)}`);
  }

  function attachGateway(via: GatewayConnection["via"], host: string, makeWire: (onText: (text: string) => void, onClose: (code: number) => void) => WireConnection | null): GatewayConnection | null {
    const connection = { id: ++connectionCounter, via, host, sessionId: null, ready: false, commands: [] } as unknown as GatewayConnection;
    const wire = makeWire((text) => gatewayCommand(connection, text), () => { connection.ready = false; });
    if (!wire) return null;
    connection.wire = wire;
    connections.push(connection);
    sendTo(connection, { op: 10, d: { heartbeat_interval: heartbeatIntervalMs } });
    return connection;
  }

  const gateway = {
    /** An in-memory gateway socket for `createDiscordGatewayClient({ openSocket })`. */
    openSocket(url: URL): DiscordWebSocketLike {
      let connection: GatewayConnection | null = null;
      const socket = new MemorySocket({
        onText: (text) => { if (connection) gatewayCommand(connection, text); },
        onClientClose: () => { if (connection) connection.ready = false; }
      });
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open", {});
        connection = attachGateway("memory", url.host, () => ({
          send: (text) => { if (socket.readyState === 1) queueMicrotask(() => socket.emit("message", { data: text })); },
          close: (code) => { if (connection) connection.ready = false; socket.serverClose(code); },
          drop: () => { if (connection) connection.ready = false; socket.serverClose(1006); }
        }));
      });
      return socket;
    },
    dispatch,
    /** Op 7: asks the client to reconnect and resume. */
    reconnect(): void { const connection = activeConnection(); if (connection) sendTo(connection, { op: 7, d: null }); },
    /** Op 9; `resumable: false` also forgets the session. */
    invalidateSession(resumable: boolean): void {
      const connection = [...connections].reverse().find((entry) => entry.ready);
      if (!resumable && currentSession) currentSession.invalid = true;
      if (connection) sendTo(connection, { op: 9, d: resumable });
    },
    close(code: number): void { const connection = [...connections].reverse().find((entry) => entry.ready || entry.sessionId === null); connection?.wire.close(code); },
    drop(): void { const connection = [...connections].reverse().find((entry) => entry.ready); connection?.wire.drop(); },
    /** While true, heartbeats get no ACK (a zombie connection). */
    withholdAcks(value: boolean): void { withholdAcks = value; },
    /** Received commands; IDENTIFY and RESUME carry `tokenMatched` instead of the token. */
    received: () => received.map((entry) => ({ ...entry })),
    connections: () => connections.map((entry) => ({ id: entry.id, via: entry.via, host: entry.host, sessionId: entry.sessionId, ready: entry.ready })),
    sessionId: () => currentSession?.id ?? null,
    identifyCount: () => received.filter((entry) => entry.op === 2).length,
    heartbeatIntervalMs
  };

  // -------------------------------------------------------------------------
  // REST

  function record(call: FakeDiscordCall): void { calls.push(call); }

  function takeFailure(method: string, route: string): FakeDiscordReply | null {
    const rule = failures.find((entry) => entry.remaining > 0 && (!entry.route || entry.route === route) && (!entry.method || entry.method === method));
    if (!rule) return null;
    rule.remaining -= 1;
    return rule.reply;
  }

  function validateMessagePayload(payload: Record<string, unknown>, create: boolean): void {
    const mentions = payload.allowed_mentions as { parse?: unknown } | undefined;
    if (!mentions || !Array.isArray(mentions.parse) || mentions.parse.length > 0 || "users" in mentions || "roles" in mentions) {
      violations.push("rest:allowed_mentions");
      throw new HttpError(400, 50035);
    }
    if (payload.content !== undefined && (typeof payload.content !== "string" || payload.content.length > 2000)) throw new HttpError(400, 50035);
    for (const row of (payload.components ?? []) as { type?: unknown; components?: unknown }[]) {
      if (row.type !== 1 || !Array.isArray(row.components)) throw new HttpError(400, 50035);
      for (const button of row.components as Record<string, unknown>[]) {
        if (button.type !== 2 || button.style !== 5 || "custom_id" in button || typeof button.url !== "string" || !button.url.startsWith("https://")) {
          violations.push("rest:component");
          throw new HttpError(400, 50035);
        }
      }
    }
    if (create && !payload.content && !(payload.attachments as unknown[] | undefined)?.length) throw new HttpError(400, 50006);
  }

  async function readBody(request: Request): Promise<{ payload: Record<string, unknown>; uploads: { filename: string; data: Buffer; contentType: string }[] }> {
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const payload = JSON.parse(String(form.get("payload_json") ?? "{}")) as Record<string, unknown>;
      const uploads: { filename: string; data: Buffer; contentType: string }[] = [];
      for (const [field, value] of form.entries()) {
        if (!/^files\[\d+\]$/u.test(field) || typeof value === "string") continue;
        const data = Buffer.from(await value.arrayBuffer());
        if (data.length > DISCORD_FILE_MAX_BYTES) throw new HttpError(413, 40005);
        uploads.push({ filename: value.name, data, contentType: value.type || "application/octet-stream" });
      }
      if (uploads.reduce((sum, file) => sum + file.data.length, 0) > DISCORD_UPLOAD_MAX_BYTES || uploads.length > 10) throw new HttpError(413, 40005);
      return { payload, uploads };
    }
    const text = await request.text();
    return { payload: text ? JSON.parse(text) as Record<string, unknown> : {}, uploads: [] };
  }

  function rateHeaders(route: string): Record<string, string> {
    return {
      "x-ratelimit-bucket": createHash("sha1").update(route).digest("hex").slice(0, 16),
      "x-ratelimit-limit": "50", "x-ratelimit-remaining": "49", "x-ratelimit-reset-after": "1.000"
    };
  }

  async function api(request: Request, method: string, path: string, query: URLSearchParams): Promise<Response> {
    const matched = routeOf(method, path);
    const route = matched?.name ?? "unknown";
    if (!isDiscordRestPathAllowed(path) || /commands|interactions/u.test(path)) violations.push(`rest:${method} forbidden route`);
    if (request.headers.get("authorization") !== `Bot ${token}`) return json(401, { message: "401: Unauthorized", code: 0 });
    if (!matched) return json(404, { message: "404: Not Found", code: 0 });
    const params = matched.params;
    const headers = rateHeaders(route);
    switch (route) {
      case "get_current_user": return json(200, bot, headers);
      case "get_current_application": return json(200, { id: application.id, flags: application.flags, bot: { id: bot.id } }, headers);
      case "list_current_user_guilds": return json(200, [guild], headers);
      case "list_guild_channels": {
        if (params[0] !== guild.id) throw new HttpError(404, 10004);
        return json(200, [...channels.values()].filter((entry) => entry.guild_id && ![10, 11, 12].includes(entry.type)), headers);
      }
      case "get_channel": return json(200, channel(params[0]!), headers);
      case "get_guild_member": {
        const member = members.get(params[1]!);
        if (params[0] !== guild.id || !member) throw new HttpError(404, 10007);
        return json(200, { user: users.get(params[1]!), nick: member.nick, roles: member.roles }, headers);
      }
      case "get_gateway_bot": return json(200, { url: gatewayUrls.main, shards: 1, session_start_limit: sessionStartLimit }, headers);
      case "list_channel_messages": {
        channel(params[0]!);
        const limit = Math.min(Number(query.get("limit") ?? 50), 100);
        const before = query.get("before");
        const after = query.get("after");
        let list = [...messages.get(params[0]!)!];
        if (before) list = list.filter((entry) => BigInt(entry.id) < BigInt(before));
        if (after) list = list.filter((entry) => BigInt(entry.id) > BigInt(after));
        list.sort((left, right) => (BigInt(right.id) > BigInt(left.id) ? 1 : -1));
        return json(200, after ? list.slice(-limit) : list.slice(0, limit), headers);
      }
      case "get_channel_message": return json(200, findMessage(params[0]!, params[1]!), headers);
      case "create_message": {
        const target = channel(params[0]!);
        const { payload, uploads } = await readBody(request);
        validateMessagePayload(payload, true);
        const nonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
        if (nonce !== undefined && payload.enforce_nonce === true) {
          const seen = nonces.get(`${target.id}|${nonce}`);
          if (seen && clock - seen.at <= NONCE_WINDOW_MS) return json(200, findMessage(target.id, seen.messageId), headers);
        }
        const reference = payload.message_reference as { message_id?: string } | undefined;
        const referenced = reference?.message_id ? (messages.get(target.id) ?? []).find((entry) => entry.id === reference.message_id) ?? null : undefined;
        const message: FakeDiscordMessage = {
          id: id(), channel_id: target.id, ...(target.guild_id ? { guild_id: target.guild_id } : {}), author: bot,
          content: typeof payload.content === "string" ? payload.content : "", timestamp: timestamp(), edited_timestamp: null,
          type: reference ? 19 : 0, mentions: [], mention_roles: [], mention_everyone: false,
          attachments: uploads.map((upload) => attach(target.id, upload)), components: (payload.components ?? []) as unknown[],
          flags: Number(payload.flags ?? 0),
          ...(reference?.message_id ? { message_reference: { message_id: reference.message_id, channel_id: target.id, ...(target.guild_id ? { guild_id: target.guild_id } : {}) }, referenced_message: referenced ?? null } : {}),
          ...(nonce !== undefined ? { nonce } : {})
        };
        messages.get(target.id)!.push(message);
        if (nonce !== undefined && payload.enforce_nonce === true) nonces.set(`${target.id}|${nonce}`, { messageId: message.id, at: clock });
        dispatch("MESSAGE_CREATE", messageEvent(message));
        return json(200, message, headers);
      }
      case "edit_message": {
        const message = findMessage(params[0]!, params[1]!);
        if (message.author.id !== bot.id) throw new HttpError(403, 50005);
        const { payload, uploads } = await readBody(request);
        validateMessagePayload(payload, false);
        if (typeof payload.content === "string") message.content = payload.content;
        if (payload.components) message.components = payload.components as unknown[];
        if (Array.isArray(payload.attachments)) {
          const keep = new Set((payload.attachments as { id: unknown }[]).map((entry) => String(entry.id)));
          message.attachments = [...message.attachments.filter((entry) => keep.has(entry.id)), ...uploads.map((upload) => attach(message.channel_id, upload))];
        }
        message.edited_timestamp = timestamp();
        dispatch("MESSAGE_UPDATE", messageEvent(message));
        return json(200, message, headers);
      }
      case "delete_message": {
        findMessage(params[0]!, params[1]!);
        removeMessage(params[0]!, params[1]!);
        return json(204, undefined, headers);
      }
      case "start_thread_from_message": {
        const parent = channel(params[0]!);
        const message = findMessage(parent.id, params[1]!);
        const { payload } = await readBody(request);
        const name = payload.name;
        if (typeof name !== "string" || name.length < 1 || name.length > 100) throw new HttpError(400, 50035);
        if (![FAKE_DISCORD_CHANNEL_TYPES.text, FAKE_DISCORD_CHANNEL_TYPES.announcement].includes(parent.type as 0 | 5)) throw new HttpError(400, 50024);
        if (channels.has(message.id)) throw new HttpError(400, 160004);
        const thread: FakeDiscordChannel = {
          id: message.id, type: parent.type === FAKE_DISCORD_CHANNEL_TYPES.announcement ? 10 : 11, name,
          guild_id: guild.id, parent_id: parent.id
        };
        channels.set(thread.id, thread);
        messages.set(thread.id, []);
        dispatch("THREAD_CREATE", { ...thread, newly_created: true });
        return json(201, thread, headers);
      }
      case "trigger_typing": channel(params[0]!); return json(204, undefined, headers);
      case "add_own_reaction":
      case "remove_own_reaction": {
        findMessage(params[0]!, params[1]!);
        const emoji = decodeURIComponent(params[2]!);
        react(bot.id, params[0]!, params[1]!, emoji, route === "add_own_reaction");
        return json(204, undefined, headers);
      }
      default: return json(404, { message: "404: Not Found", code: 0 });
    }
  }

  function cdn(path: string, query: URLSearchParams): Response {
    const match = /^\/attachments\/(\d+)\/(\d+)\/[^/]+$/u.exec(path);
    const file = match ? files.get(match[2]!) : undefined;
    if (!file || query.get("hm") !== file.signature) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.bytes), { status: 200, headers: { "content-type": file.contentType } });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (url.pathname.startsWith("/attachments/")) return cdn(url.pathname, url.searchParams);
    if (!url.pathname.startsWith("/api/v10/")) return new Response("Not Found", { status: 404 });
    const path = url.pathname.slice("/api/v10".length);
    const route = routeOf(method, path)?.name ?? "unknown";
    const recorded = { method, route, path, query: Object.fromEntries(url.searchParams) };
    let jsonBody: unknown;
    let fileList: { filename: string; size: number; contentType: string }[] | undefined;
    try {
      const copy = request.clone();
      const type = copy.headers.get("content-type") ?? "";
      if (type.startsWith("multipart/form-data")) {
        const form = await copy.formData();
        jsonBody = JSON.parse(String(form.get("payload_json") ?? "{}"));
        fileList = [...form.entries()].filter(([, value]) => typeof value !== "string")
          .map(([, value]) => ({ filename: (value as File).name, size: (value as File).size, contentType: (value as File).type }));
      } else if (type.startsWith("application/json")) {
        jsonBody = JSON.parse(await copy.text());
      }
    } catch { jsonBody = undefined; }
    const injected = takeFailure(method, route);
    if (injected && "delayMs" in injected) await new Promise((resolve) => setTimeout(resolve, injected.delayMs));
    if (injected && "drop" in injected) {
      record({ ...recorded, status: 0, ...(jsonBody !== undefined ? { json: jsonBody } : {}) });
      throw Object.assign(new TypeError("fetch failed"), { drop: injected.drop });
    }
    let response: Response;
    if (injected && "status" in injected) {
      if (injected.status === 429) {
        const scope = injected.scope ?? (injected.global ? "global" : "user");
        response = json(429, { message: "You are being rate limited.", retry_after: injected.retryAfter, global: injected.global === true }, {
          "retry-after": String(Math.ceil(injected.retryAfter)), "x-ratelimit-scope": scope,
          ...(injected.global ? { "x-ratelimit-global": "true" } : rateHeaders(route))
        });
      } else {
        response = json(injected.status, { message: "Injected failure", code: "code" in injected ? injected.code ?? 0 : 0 });
      }
    } else {
      try {
        response = await api(request, method, path, url.searchParams);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        response = json(error.status, { message: "Refused", code: error.code });
      }
    }
    record({ ...recorded, status: response.status, ...(jsonBody !== undefined ? { json: jsonBody } : {}), ...(fileList ? { files: fileList } : {}) });
    return response;
  }

  function removeMessage(channelId: string, messageId: string): void {
    const list = messages.get(channelId) ?? [];
    const index = list.findIndex((entry) => entry.id === messageId);
    if (index === -1) return;
    list.splice(index, 1);
    dispatch("MESSAGE_DELETE", { id: messageId, channel_id: channelId, ...(channels.get(channelId)?.guild_id ? { guild_id: guild.id } : {}) });
  }

  function react(userId: string, channelId: string, messageId: string, emoji: string, add: boolean): void {
    const byEmoji = reactions.get(messageId) ?? new Map<string, Set<string>>();
    reactions.set(messageId, byEmoji);
    const usersOf = byEmoji.get(emoji) ?? new Set<string>();
    byEmoji.set(emoji, usersOf);
    const target = findMessage(channelId, messageId);
    const guildId = channels.get(channelId)?.guild_id;
    if (add) {
      if (usersOf.has(userId)) return;
      usersOf.add(userId);
      dispatch("MESSAGE_REACTION_ADD", {
        user_id: userId, channel_id: channelId, message_id: messageId, emoji: { id: null, name: emoji },
        message_author_id: target.author.id, ...(guildId ? { guild_id: guildId, member: memberPayload(userId) } : {})
      });
    } else {
      if (!usersOf.delete(userId)) return;
      dispatch("MESSAGE_REACTION_REMOVE", {
        user_id: userId, channel_id: channelId, message_id: messageId, emoji: { id: null, name: emoji }, ...(guildId ? { guild_id: guildId } : {})
      });
    }
  }

  // -------------------------------------------------------------------------
  // Fetch mode

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return handle(input instanceof Request ? input : new Request(input, init));
  }

  function multipartForm(payload: unknown, uploads: readonly { filename: string; contentType: string; data: Buffer }[]): FormData {
    const form = new FormData();
    form.set("payload_json", JSON.stringify(payload ?? {}));
    uploads.forEach((upload, index) => form.set(`files[${index}]`, new Blob([new Uint8Array(upload.data)], { type: upload.contentType }), upload.filename));
    return form;
  }

  /** The production transport contract over `fetch`, with the same path guard and bounds. */
  const transport: DiscordTransport = Object.freeze({
    request: async ({ token: sentToken, method, path, query, json: body, files: uploads }) => {
      if (!DISCORD_BOT_TOKEN_PATTERN.test(sentToken) || !isDiscordRestPathAllowed(path)) {
        throw new DiscordTransportConfigError("discord_request_invalid");
      }
      const url = new URL(`https://discord.com/api/v10${path}`);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
      const headers: Record<string, string> = { authorization: `Bot ${sentToken}` };
      let requestBody: BodyInit | undefined;
      if (uploads && uploads.length > 0) {
        if (uploads.length > DISCORD_UPLOAD_FILES_MAX) throw new DiscordTransportConfigError("discord_request_invalid");
        const buffers: { filename: string; contentType: string; data: Buffer }[] = [];
        for (const upload of uploads) {
          if ("data" in upload) buffers.push({ filename: upload.filename, contentType: upload.contentType, data: upload.data });
          else {
            const chunks: Buffer[] = [];
            for await (const chunk of upload.stream) chunks.push(Buffer.from(chunk as Uint8Array));
            buffers.push({ filename: upload.filename, contentType: upload.contentType, data: Buffer.concat(chunks) });
          }
        }
        if (buffers.some((upload) => upload.data.length > DISCORD_FILE_MAX_BYTES)
          || buffers.reduce((sum, upload) => sum + upload.data.length, 0) > DISCORD_UPLOAD_MAX_BYTES) return { ok: false, kind: "too_large" };
        requestBody = multipartForm(body, buffers);
      } else if (body !== undefined) {
        requestBody = JSON.stringify(body);
        headers["content-type"] = "application/json";
      }
      let response: Response;
      try {
        response = await handle(new Request(url, { method, headers, ...(requestBody !== undefined ? { body: requestBody } : {}) }));
      } catch (error) {
        const drop = (error as { drop?: string }).drop;
        return drop === "before_send" ? { ok: false, kind: "network_before_send", category: "connect" } : { ok: false, kind: "network_after_send", category: "reset" };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > DISCORD_JSON_RESPONSE_MAX_BYTES) return { ok: false, kind: "too_large", status: response.status };
      if (response.status >= 300 && response.status < 400) return { ok: false, kind: "redirect", status: response.status };
      let parsed: unknown;
      try { parsed = bytes.length > 0 ? JSON.parse(bytes.toString("utf8")) : undefined; } catch { parsed = undefined; }
      const result: DiscordHttpResult = {
        ok: true, status: response.status, rateLimit: discordRateLimitHeaders(Object.fromEntries(response.headers)), json: parsed
      };
      return result;
    },
    download: async ({ url, maxBytes }) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return { ok: false, kind: "forbidden_host" }; }
      if (parsed.protocol !== "https:" || !DISCORD_CDN_HOSTS.includes(parsed.hostname)) return { ok: false, kind: "forbidden_host" };
      const response = await handle(new Request(parsed));
      if (response.status !== 200) return { ok: false, kind: "http", status: response.status };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > Math.min(maxBytes ?? DISCORD_DOWNLOAD_MAX_BYTES, DISCORD_DOWNLOAD_MAX_BYTES)) return { ok: false, kind: "too_large", status: 200 };
      return { ok: true, body: bytes, contentType: response.headers.get("content-type") ?? undefined };
    }
  });

  // -------------------------------------------------------------------------
  // Loopback servers

  async function start(): Promise<Readonly<{ origin: string; gatewayUrl: string; resumeGatewayUrl: string; stop(): Promise<void> }>> {
    const sockets = new Set<Socket>();
    async function onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const body = chunks.length > 0 && request.method !== "GET" && request.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      let answer: Response;
      try {
        answer = await handle(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method, headers, ...(body ? { body: new Uint8Array(body) } : {}) }));
      } catch {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    }
    function listen(server: Server): Promise<number> {
      server.on("connection", (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
    }
    const main = createServer((request, response) => { void onRequest(request, response); });
    const resume = createServer((_request, response) => { response.writeHead(404); response.end(); });
    main.on("upgrade", (request, socket) => { attachGateway("main", String(request.headers.host), (onText, onClose) => acceptUpgrade(request, socket, onText, onClose)); });
    resume.on("upgrade", (request, socket) => { attachGateway("resume", String(request.headers.host), (onText, onClose) => acceptUpgrade(request, socket, onText, onClose)); });
    const [mainPort, resumePort] = await Promise.all([listen(main), listen(resume)]);
    const previous = gatewayUrls;
    gatewayUrls = { main: `ws://127.0.0.1:${mainPort}`, resume: `ws://localhost:${resumePort}` };
    return {
      origin: `http://127.0.0.1:${mainPort}`,
      gatewayUrl: gatewayUrls.main,
      resumeGatewayUrl: gatewayUrls.resume,
      stop: async () => {
        gatewayUrls = previous;
        for (const socket of sockets) socket.destroy();
        await Promise.all([main, resume].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      }
    };
  }

  // -------------------------------------------------------------------------
  // Scenario helpers

  function postMessage(input: Readonly<{
    channelId: string; authorId: string; content: string; mentions?: readonly string[]; mentionRoles?: readonly string[];
    replyTo?: string; type?: number; webhookId?: string;
    attachments?: readonly Readonly<{ filename: string; data: Buffer; contentType: string }>[];
  }>): FakeDiscordMessage {
    const target = channel(input.channelId);
    const author = users.get(input.authorId);
    if (!author) throw new Error("unknown author");
    const referenced = input.replyTo ? findMessage(target.id, input.replyTo) : undefined;
    const message: FakeDiscordMessage = {
      id: id(), channel_id: target.id, ...(target.guild_id ? { guild_id: target.guild_id } : {}), author,
      content: input.content, timestamp: timestamp(), edited_timestamp: null, type: input.type ?? (referenced ? 19 : 0),
      mentions: (input.mentions ?? []).map((userId) => users.get(userId)!).filter(Boolean),
      mention_roles: [...(input.mentionRoles ?? [])], mention_everyone: false,
      attachments: (input.attachments ?? []).map((attachment) => attach(target.id, attachment)), components: [], flags: 0,
      ...(referenced ? { message_reference: { message_id: referenced.id, channel_id: target.id, ...(target.guild_id ? { guild_id: target.guild_id } : {}) }, referenced_message: referenced } : {}),
      ...(input.webhookId ? { webhook_id: input.webhookId } : {})
    };
    messages.get(target.id)!.push(message);
    dispatch("MESSAGE_CREATE", messageEvent(message));
    return message;
  }

  return {
    token, application, bot, botRoleId, guild, channels: defaults,
    addChannel, addUser, postMessage,
    /** A forum post: a thread whose starter message has the thread's id. */
    createForumPost(input: Readonly<{ forumId: string; authorId: string; name: string; content: string }>): Readonly<{ threadId: string; message: FakeDiscordMessage }> {
      const threadId = id();
      channels.set(threadId, { id: threadId, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread, name: input.name, guild_id: guild.id, parent_id: input.forumId });
      messages.set(threadId, []);
      dispatch("THREAD_CREATE", { ...channels.get(threadId), newly_created: true });
      const author = users.get(input.authorId)!;
      const message: FakeDiscordMessage = {
        id: threadId, channel_id: threadId, guild_id: guild.id, author, content: input.content, timestamp: timestamp(),
        edited_timestamp: null, type: 0, mentions: [], mention_roles: [], mention_everyone: false, attachments: [], components: [], flags: 0
      };
      messages.get(threadId)!.push(message);
      dispatch("MESSAGE_CREATE", messageEvent(message));
      return { threadId, message };
    },
    /** A direct-message channel between the bot and a user. */
    openDm(userId: string): string {
      const channelId = addChannel({ type: FAKE_DISCORD_CHANNEL_TYPES.dm, name: null, guild: false });
      channels.get(channelId)!.recipients = [users.get(userId)!];
      return channelId;
    },
    editUserMessage(channelId: string, messageId: string, content: string): void {
      const message = findMessage(channelId, messageId);
      message.content = content;
      message.edited_timestamp = timestamp();
      dispatch("MESSAGE_UPDATE", messageEvent(message));
    },
    deleteMessage: removeMessage,
    bulkDelete(channelId: string, messageIds: readonly string[]): void {
      const list = messages.get(channelId) ?? [];
      messages.set(channelId, list.filter((entry) => !messageIds.includes(entry.id)));
      dispatch("MESSAGE_DELETE_BULK", { ids: [...messageIds], channel_id: channelId, guild_id: guild.id });
    },
    react: (userId: string, channelId: string, messageId: string, emoji: string) => react(userId, channelId, messageId, emoji, true),
    unreact: (userId: string, channelId: string, messageId: string, emoji: string) => react(userId, channelId, messageId, emoji, false),
    messages: (channelId: string) => [...(messages.get(channelId) ?? [])],
    channel: (channelId: string) => channels.get(channelId),
    reactions: (messageId: string, emoji: string) => [...(reactions.get(messageId)?.get(emoji) ?? [])],
    fail(rule: FakeDiscordFailureRule): void { failures.push({ ...rule, remaining: rule.times ?? 1, reply: rule.reply }); },
    calls(filter: Readonly<{ route?: string; method?: string }> = {}): FakeDiscordCall[] {
      return calls.filter((call) => (!filter.route || call.route === filter.route) && (!filter.method || call.method === filter.method));
    },
    violations: () => [...violations],
    setSessionStartLimit(limit: Partial<typeof sessionStartLimit>): void { sessionStartLimit = { ...sessionStartLimit, ...limit }; },
    setMessageContentEnabled(enabled: boolean): void { application.flags = enabled ? FAKE_DISCORD_MESSAGE_CONTENT_FLAGS : 0; },
    /** Moves the fake's clock (message timestamps and the nonce window). */
    advance(ms: number): void { clock += ms; },
    gateway, transport, fetch: fakeFetch, handle, start
  };
}

export type FakeDiscord = ReturnType<typeof createFakeDiscord>;

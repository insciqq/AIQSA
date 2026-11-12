import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DISCORD_SNOWFLAKE_PATTERN } from "../../contracts/discord";
import { logEvent } from "../observability";
import {
  DISCORD_API_ERROR_CODE, DISCORD_DISABLED_CODE, DISCORD_HTTP_ERROR_CODE, DISCORD_INVALID_REQUESTS_CODE,
  DISCORD_INVALID_RESPONSE_CODE, DISCORD_RATE_LIMITED_CODE, DISCORD_REQUEST_INVALID_CODE, DISCORD_TOKEN_MISSING_CODE,
  discordTransportFailureCode
} from "./codes";
import {
  DiscordTransportConfigError, type DiscordHttpResult, type DiscordRateLimitHeaders, type DiscordRestMethod,
  type DiscordTransport, type DiscordUploadFile
} from "./transport";

/**
 * The minimal Discord REST client of Discord Connect. It knows only the
 * methods the PRD uses and never an application-command or interaction
 * endpoint (shared application, PRD D-06). Every send:
 *
 * - asks `authorize` first and again after any wait (the kill switch);
 * - honours per-route buckets from `X-RateLimit-*`, a 50/s global budget, a
 *   global 429 pause and the invalid-request pause (> 1000 401/403/429 in
 *   10 minutes stops sends for 10 minutes; PRD D-05);
 * - on 429 waits `retry_after` (≤ 60 s) and repeats once; on an ambiguous
 *   network failure repeats once only an idempotent call. A message create
 *   is idempotent through its `nonce` with `enforce_nonce`.
 *
 * Messages it creates or edits carry `allowed_mentions: {parse: []}`,
 * `SUPPRESS_EMBEDS` and link buttons only. Failures are closed codes.
 */

export const DISCORD_GLOBAL_REQUESTS_PER_SECOND = 50;
export const DISCORD_RETRY_AFTER_MAX_MS = 60_000;
export const DISCORD_INVALID_REQUEST_LIMIT = 1_000;
export const DISCORD_INVALID_REQUEST_WINDOW_MS = 10 * 60_000;
export const DISCORD_INVALID_REQUEST_PAUSE_MS = 10 * 60_000;
export const DISCORD_MESSAGE_MAX_LENGTH = 2_000;
export const DISCORD_THREAD_NAME_MAX_LENGTH = 100;
export const DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2;
export const DISCORD_NONCE_PATTERN = /^aiqsa[a-z0-9]{1,20}$/u;
const BUTTON_LABEL_MAX = 80;
const BUTTON_URL_MAX = 512;
const BUCKET_ENTRY_LIMIT = 4_096;

export type DiscordRestDelivery = "not_sent" | "refused" | "unknown";
/**
 * A failed call. `delivery` says what Discord did: `not_sent` (nothing left
 * AIQSA), `refused` (Discord answered without doing it) or `unknown`.
 * `discordCode` is Discord's numeric JSON error code; its message is never kept.
 */
export type DiscordRestFailure = Readonly<{
  ok: false; code: string; delivery: DiscordRestDelivery; status?: number; discordCode?: number; retryAfterMs?: number;
}>;
export type DiscordRestOutcome<T> = Readonly<{ ok: true; value: T }> | DiscordRestFailure;

const snowflake = z.string().regex(DISCORD_SNOWFLAKE_PATTERN);
const userSchema = z.looseObject({
  id: snowflake, username: z.string().max(64), global_name: z.string().max(64).nullable().optional(), bot: z.boolean().optional()
});
const applicationSchema = z.looseObject({ id: snowflake, flags: z.number().int().optional(), bot: z.looseObject({ id: snowflake }).optional() });
const guildSchema = z.looseObject({ id: snowflake, name: z.string().max(200) });
const channelSchema = z.looseObject({
  id: snowflake, type: z.number().int(), name: z.string().max(200).nullable().optional(),
  parent_id: snowflake.nullable().optional(), guild_id: snowflake.optional()
});
const memberSchema = z.looseObject({ user: userSchema.optional(), nick: z.string().max(64).nullable().optional(), roles: z.array(snowflake) });
const gatewayBotSchema = z.looseObject({
  url: z.string().max(200),
  shards: z.number().int().optional(),
  session_start_limit: z.looseObject({
    total: z.number().int().min(0), remaining: z.number().int().min(0), reset_after: z.number().int().min(0),
    max_concurrency: z.number().int().min(1)
  })
});
const messageSchema = z.looseObject({ id: snowflake, channel_id: snowflake, author: userSchema.optional() });

export type DiscordUser = z.infer<typeof userSchema>;
export type DiscordApplication = z.infer<typeof applicationSchema>;
export type DiscordGuild = z.infer<typeof guildSchema>;
export type DiscordChannel = z.infer<typeof channelSchema>;
export type DiscordGuildMember = z.infer<typeof memberSchema>;
export type DiscordGatewayBot = z.infer<typeof gatewayBotSchema>;
/** A message as Discord sent it; fields beyond ids are read by the callers' own decoders. */
export type DiscordMessage = z.infer<typeof messageSchema>;

/** A link button (style 5): a URL and a label, never a `custom_id`. */
export type DiscordLinkButton = Readonly<{ label: string; url: string }>;
export type DiscordMessageInput = Readonly<{
  content?: string;
  /** Sends as a Reply to this message without pinging its author; a deleted one is ignored. */
  replyTo?: string;
  /** Rows of link buttons (≤ 5 rows of ≤ 5). */
  buttons?: readonly (readonly DiscordLinkButton[])[];
  files?: readonly DiscordUploadFile[];
}>;
export type DiscordMessageEdit = Readonly<{
  content?: string;
  buttons?: readonly (readonly DiscordLinkButton[])[];
  /** New files; existing attachments are kept unless `keepAttachments` lists fewer. */
  files?: readonly DiscordUploadFile[];
  /** Ids of existing attachments to keep; `[]` removes them all. */
  keepAttachments?: readonly string[];
}>;

/** A fresh nonce: `aiqsa` + base36 time + random, at most 25 characters. */
export function discordNonce(): string {
  return `aiqsa${Date.now().toString(36)}${BigInt(`0x${randomBytes(5).toString("hex")}`).toString(36)}`.slice(0, 25);
}

/** A stable nonce for one purpose of one question: `aiqsa` + base36(message id) + purpose letter. */
export function discordStableNonce(messageId: string, purpose: "s" | "a" | "r" | "t"): string {
  if (!DISCORD_SNOWFLAKE_PATTERN.test(messageId)) throw new DiscordTransportConfigError(DISCORD_REQUEST_INVALID_CODE);
  return `aiqsa${BigInt(messageId).toString(36)}${purpose}`;
}

type Route = Readonly<{
  /** A content-free route name for logs. */
  name: DiscordRouteName;
  method: DiscordRestMethod;
  path: string;
  /** The template that shares one bucket, with the major parameter kept. */
  bucketKey: string;
  query?: Readonly<Record<string, string | number>>;
  json?: unknown;
  files?: readonly DiscordUploadFile[];
  /** Repeating it after an ambiguous failure cannot do it twice. */
  idempotent: boolean;
}>;

export const DISCORD_ROUTE_NAMES = [
  "get_current_user", "get_current_application", "list_current_user_guilds", "list_guild_channels", "get_guild_member",
  "get_gateway_bot", "list_channel_messages", "get_channel_message", "create_message", "edit_message", "delete_message",
  "start_thread_from_message", "trigger_typing", "add_own_reaction", "remove_own_reaction", "get_channel"
] as const;
export type DiscordRouteName = (typeof DISCORD_ROUTE_NAMES)[number];

export type DiscordRest = Readonly<{
  getCurrentUser(): Promise<DiscordRestOutcome<DiscordUser>>;
  getCurrentApplication(): Promise<DiscordRestOutcome<DiscordApplication>>;
  listCurrentUserGuilds(): Promise<DiscordRestOutcome<DiscordGuild[]>>;
  listGuildChannels(guildId: string): Promise<DiscordRestOutcome<DiscordChannel[]>>;
  /** One channel or thread: its type, server and parent, when no gateway event named them in this process. */
  getChannel(channelId: string): Promise<DiscordRestOutcome<DiscordChannel>>;
  getGuildMember(guildId: string, userId: string): Promise<DiscordRestOutcome<DiscordGuildMember>>;
  getGatewayBot(): Promise<DiscordRestOutcome<DiscordGatewayBot>>;
  /** History newest first, at most 100 per page. */
  listChannelMessages(channelId: string, page?: Readonly<{ before?: string; after?: string; limit?: number }>): Promise<DiscordRestOutcome<DiscordMessage[]>>;
  getChannelMessage(channelId: string, messageId: string): Promise<DiscordRestOutcome<DiscordMessage>>;
  /** `nonce` defaults to a fresh one; pass a stable one so a repeat after a crash is deduplicated too. */
  createMessage(channelId: string, input: DiscordMessageInput, options?: Readonly<{ nonce?: string }>): Promise<DiscordRestOutcome<DiscordMessage>>;
  editMessage(channelId: string, messageId: string, input: DiscordMessageEdit): Promise<DiscordRestOutcome<DiscordMessage>>;
  deleteMessage(channelId: string, messageId: string): Promise<DiscordRestOutcome<null>>;
  startThreadFromMessage(channelId: string, messageId: string, input: Readonly<{
    name: string; autoArchiveMinutes?: 60 | 1440 | 4320 | 10080;
  }>): Promise<DiscordRestOutcome<DiscordChannel>>;
  triggerTyping(channelId: string): Promise<DiscordRestOutcome<null>>;
  /** `emoji` is a Unicode emoji or `name:id`; it is URL-encoded here. */
  addOwnReaction(channelId: string, messageId: string, emoji: string): Promise<DiscordRestOutcome<null>>;
  removeOwnReaction(channelId: string, messageId: string, emoji: string): Promise<DiscordRestOutcome<null>>;
  /** Content-free limiter state for health and tests. */
  state(): Readonly<{ globalPausedUntil: number | null; invalidPausedUntil: number | null; invalidCount: number }>;
}>;

export type DiscordRestOptions = Readonly<{
  transport: DiscordTransport;
  /** The current bot token; `null` refuses every call unsent. */
  token: () => string | null | Promise<string | null>;
  /** The kill switch: false refuses the call unsent with `discord_disabled`. */
  authorize?: () => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

function failure(code: string, delivery: DiscordRestDelivery, extra: Partial<DiscordRestFailure> = {}): DiscordRestFailure {
  return { ok: false, code, delivery, ...extra };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function retryAfterMs(response: Readonly<{ json: unknown; rateLimit: DiscordRateLimitHeaders }>): number {
  const body = record(response.json)?.retry_after;
  const fromBody = typeof body === "number" && Number.isFinite(body) && body >= 0 ? Math.ceil(body * 1_000) : undefined;
  return Math.min(fromBody ?? response.rateLimit.retryAfterMs ?? response.rateLimit.resetAfterMs ?? 1_000, DISCORD_RETRY_AFTER_MAX_MS);
}

function validId(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}

/** Unicode emoji (no ASCII letters, digits, slashes or colons) or a custom `name:id`. */
function validEmoji(value: string): boolean {
  return value.length > 0 && value.length <= 64 && (/^[A-Za-z0-9_]{2,32}:[0-9]{1,20}$/u.test(value)
    || !/[\u0000-\u007f]/u.test(value));
}

function validButtons(rows: readonly (readonly DiscordLinkButton[])[]): boolean {
  return rows.length <= 5 && rows.every((row) => row.length >= 1 && row.length <= 5 && row.every((button) => {
    if (button.label.length < 1 || button.label.length > BUTTON_LABEL_MAX || button.url.length > BUTTON_URL_MAX) return false;
    try { return new URL(button.url).protocol === "https:"; } catch { return false; }
  }));
}

function components(rows: readonly (readonly DiscordLinkButton[])[]): unknown[] {
  return rows.map((row) => ({ type: 1, components: row.map((button) => ({ type: 2, style: 5, label: button.label, url: button.url })) }));
}

const MENTIONS_OFF = Object.freeze({ parse: [] as string[], replied_user: false });

export function createDiscordRest(options: DiscordRestOptions): DiscordRest {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Route template → Discord's bucket hash, learned from responses. */
  const routeBuckets = new Map<string, string>();
  const buckets = new Map<string, { remaining: number; resetAt: number }>();
  let globalSlots: number[] = [];
  let globalPausedUntil = 0;
  let invalidTimes: number[] = [];
  let invalidPausedUntil = 0;

  function bucketId(route: Route): string {
    const template = route.bucketKey.split("|")[0]!;
    const hash = routeBuckets.get(template);
    return hash ? `${hash}|${route.bucketKey.split("|")[1] ?? ""}` : route.bucketKey;
  }

  /** Reserves a send slot synchronously and returns how long to wait for it. */
  function reserve(route: Route): number {
    const current = now();
    let at = Math.max(current, globalPausedUntil);
    const bucket = buckets.get(bucketId(route));
    if (bucket) {
      if (bucket.resetAt <= current) buckets.delete(bucketId(route));
      else if (bucket.remaining <= 0) at = Math.max(at, bucket.resetAt);
      else bucket.remaining -= 1;
    }
    globalSlots = globalSlots.filter((slot) => slot > current - 1_000);
    const inWindow = globalSlots.filter((slot) => slot > at - 1_000);
    if (inWindow.length >= DISCORD_GLOBAL_REQUESTS_PER_SECOND) {
      at = Math.max(at, inWindow[inWindow.length - DISCORD_GLOBAL_REQUESTS_PER_SECOND]! + 1_000);
    }
    globalSlots.push(at);
    globalSlots.sort((left, right) => left - right);
    return at - current;
  }

  function learn(route: Route, rateLimit: DiscordRateLimitHeaders): void {
    if (!rateLimit.bucket) return;
    const [template, major = ""] = route.bucketKey.split("|");
    routeBuckets.set(template!, rateLimit.bucket);
    if (rateLimit.remaining !== undefined && rateLimit.resetAfterMs !== undefined) {
      if (buckets.size > BUCKET_ENTRY_LIMIT) {
        const current = now();
        for (const [key, value] of buckets) if (value.resetAt <= current) buckets.delete(key);
      }
      buckets.set(`${rateLimit.bucket}|${major}`, { remaining: rateLimit.remaining, resetAt: now() + rateLimit.resetAfterMs });
    }
  }

  function countInvalid(): void {
    const current = now();
    invalidTimes = invalidTimes.filter((time) => time > current - DISCORD_INVALID_REQUEST_WINDOW_MS);
    invalidTimes.push(current);
    if (invalidTimes.length > DISCORD_INVALID_REQUEST_LIMIT && invalidPausedUntil <= current) {
      invalidPausedUntil = current + DISCORD_INVALID_REQUEST_PAUSE_MS;
      logEvent("discord_rest", {
        outcome: "paused", code: DISCORD_INVALID_REQUESTS_CODE, count: invalidTimes.length, delay_ms: DISCORD_INVALID_REQUEST_PAUSE_MS
      });
    }
  }

  async function allowed(): Promise<boolean> {
    try { return options.authorize ? await options.authorize() : true; } catch { return false; }
  }

  async function call(route: Route): Promise<DiscordRestOutcome<unknown>> {
    let token: string | null;
    try { token = await options.token(); } catch { token = null; }
    if (!token) return failure(DISCORD_TOKEN_MISSING_CODE, "not_sent");
    for (let attempt = 0; ; attempt += 1) {
      if (!await allowed()) return failure(DISCORD_DISABLED_CODE, "not_sent");
      if (invalidPausedUntil > now()) return failure(DISCORD_INVALID_REQUESTS_CODE, "not_sent", { retryAfterMs: invalidPausedUntil - now() });
      const wait = reserve(route);
      if (wait > DISCORD_RETRY_AFTER_MAX_MS) return failure(DISCORD_RATE_LIMITED_CODE, "not_sent", { retryAfterMs: wait });
      if (wait > 0) {
        await sleep(wait);
        if (!await allowed()) return failure(DISCORD_DISABLED_CODE, "not_sent");
      }
      let result: DiscordHttpResult;
      try {
        result = await options.transport.request({
          token, method: route.method, path: route.path,
          ...(route.query ? { query: route.query } : {}), ...(route.json !== undefined ? { json: route.json } : {}),
          ...(route.files && route.files.length > 0 ? { files: route.files } : {})
        });
      } catch (error) {
        if (error instanceof DiscordTransportConfigError) return failure(error.code, "not_sent");
        return failure(DISCORD_REQUEST_INVALID_CODE, "unknown");
      }
      const canRepeat = attempt === 0 && !route.files?.some((file) => "stream" in file);
      if (!result.ok) {
        if (result.kind === "network_before_send" || (result.kind === "too_large" && result.status === undefined)) {
          if (canRepeat && result.kind === "network_before_send") continue;
          return failure(discordTransportFailureCode(result.kind === "too_large" ? "too_large" : "network_before_send"), "not_sent");
        }
        if (canRepeat && route.idempotent && (result.kind === "network_after_send" || result.kind === "timeout")) continue;
        const kind = result.kind === "http" ? "network_after_send" : result.kind;
        return failure(discordTransportFailureCode(kind), "unknown", result.status ? { status: result.status } : {});
      }
      learn(route, result.rateLimit);
      const status = result.status;
      if (status === 401 || status === 403 || (status === 429 && result.rateLimit.scope !== "shared")) countInvalid();
      if (status === 429) {
        const retryAfter = retryAfterMs(result);
        const global = record(result.json)?.global === true || result.rateLimit.global === true || result.rateLimit.scope === "global";
        if (global) globalPausedUntil = Math.max(globalPausedUntil, now() + retryAfter);
        else {
          const hash = result.rateLimit.bucket;
          const major = route.bucketKey.split("|")[1] ?? "";
          buckets.set(hash ? `${hash}|${major}` : route.bucketKey, { remaining: 0, resetAt: now() + retryAfter });
        }
        logEvent("discord_rest", {
          route: route.name, outcome: "rate_limited", httpStatus: 429, code: DISCORD_RATE_LIMITED_CODE,
          scope: global ? "global" : result.rateLimit.scope ?? "user", retry_after_ms: retryAfter, attempt: attempt + 1
        });
        // Discord did not run a refused call, so one repeat is safe for every call.
        if (attempt === 0 && canRepeat) continue;
        return failure(DISCORD_RATE_LIMITED_CODE, "refused", { status, retryAfterMs: retryAfter });
      }
      if (status >= 200 && status < 300) return { ok: true, value: result.json ?? null };
      const discordCode = record(result.json)?.code;
      const extra = { status, ...(Number.isSafeInteger(discordCode) ? { discordCode: discordCode as number } : {}) };
      if (status >= 500) {
        if (canRepeat && route.idempotent) continue;
        return failure(DISCORD_HTTP_ERROR_CODE, "unknown", extra);
      }
      return failure(status >= 400 ? DISCORD_API_ERROR_CODE : DISCORD_HTTP_ERROR_CODE, "refused", extra);
    }
  }

  async function typed<T>(route: Route, schema: z.ZodType<T>): Promise<DiscordRestOutcome<T>> {
    const outcome = await call(route);
    if (!outcome.ok) return outcome;
    const parsed = schema.safeParse(outcome.value);
    return parsed.success ? { ok: true, value: parsed.data } : failure(DISCORD_INVALID_RESPONSE_CODE, "unknown");
  }

  async function empty(route: Route): Promise<DiscordRestOutcome<null>> {
    const outcome = await call(route);
    return outcome.ok ? { ok: true, value: null } : outcome;
  }

  function invalid(files?: readonly DiscordUploadFile[]): Promise<DiscordRestFailure> {
    files?.forEach((file) => { if ("stream" in file) file.stream.destroy(); });
    return Promise.resolve(failure(DISCORD_REQUEST_INVALID_CODE, "not_sent"));
  }

  const route = (
    name: DiscordRouteName, method: DiscordRestMethod, path: string, template: string, major: string,
    extra: Partial<Pick<Route, "query" | "json" | "files">> & { idempotent?: boolean } = {}
  ): Route => ({
    name, method, path, bucketKey: `${method} ${template}|${major}`, idempotent: extra.idempotent ?? method !== "POST",
    ...(extra.query ? { query: extra.query } : {}), ...(extra.json !== undefined ? { json: extra.json } : {}),
    ...(extra.files ? { files: extra.files } : {})
  });

  function messageBody(input: DiscordMessageInput | DiscordMessageEdit, create: boolean): Record<string, unknown> | null {
    if (input.content !== undefined && input.content.length > DISCORD_MESSAGE_MAX_LENGTH) return null;
    if (input.buttons && !validButtons(input.buttons)) return null;
    const body: Record<string, unknown> = { allowed_mentions: MENTIONS_OFF, flags: DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS };
    if (input.content !== undefined) body.content = input.content;
    if (input.buttons) body.components = components(input.buttons);
    const keep = "keepAttachments" in input ? input.keepAttachments : undefined;
    if (keep && !keep.every(validId)) return null;
    if (input.files?.length || keep) {
      body.attachments = [
        ...(keep ?? []).map((id) => ({ id })),
        ...(input.files ?? []).map((file, index) => ({ id: index, filename: file.filename.slice(0, 200) }))
      ];
    }
    if (create) {
      const replyTo = "replyTo" in input ? input.replyTo : undefined;
      if (replyTo !== undefined) {
        if (!validId(replyTo)) return null;
        body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
      }
      if (!input.content && !input.files?.length) return null;
    }
    return body;
  }

  return Object.freeze({
    getCurrentUser: () => typed(route("get_current_user", "GET", "/users/@me", "/users/@me", ""), userSchema),
    getCurrentApplication: () => typed(route("get_current_application", "GET", "/oauth2/applications/@me", "/oauth2/applications/@me", ""), applicationSchema),
    listCurrentUserGuilds: () => typed(route("list_current_user_guilds", "GET", "/users/@me/guilds", "/users/@me/guilds", "",
      { query: { limit: 200 } }), z.array(guildSchema).max(200)),
    listGuildChannels: (guildId) => validId(guildId)
      ? typed(route("list_guild_channels", "GET", `/guilds/${guildId}/channels`, "/guilds/:g/channels", guildId), z.array(channelSchema).max(1_000))
      : invalid(),
    getChannel: (channelId) => validId(channelId)
      ? typed(route("get_channel", "GET", `/channels/${channelId}`, "/channels/:c", channelId), channelSchema)
      : invalid(),
    getGuildMember: (guildId, userId) => validId(guildId) && validId(userId)
      ? typed(route("get_guild_member", "GET", `/guilds/${guildId}/members/${userId}`, "/guilds/:g/members/:u", guildId), memberSchema)
      : invalid(),
    getGatewayBot: () => typed(route("get_gateway_bot", "GET", "/gateway/bot", "/gateway/bot", ""), gatewayBotSchema),
    listChannelMessages: (channelId, page = {}) => {
      const limit = page.limit ?? 100;
      if (!validId(channelId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || (page.before !== undefined && !validId(page.before)) || (page.after !== undefined && !validId(page.after))
        || (page.before !== undefined && page.after !== undefined)) return invalid();
      return typed(route("list_channel_messages", "GET", `/channels/${channelId}/messages`, "/channels/:c/messages", channelId, {
        query: { limit, ...(page.before ? { before: page.before } : {}), ...(page.after ? { after: page.after } : {}) }
      }), z.array(messageSchema).max(100));
    },
    getChannelMessage: (channelId, messageId) => validId(channelId) && validId(messageId)
      ? typed(route("get_channel_message", "GET", `/channels/${channelId}/messages/${messageId}`, "/channels/:c/messages/:m", channelId), messageSchema)
      : invalid(),
    createMessage: (channelId, input, createOptions = {}) => {
      const nonce = createOptions.nonce ?? discordNonce();
      const body = messageBody(input, true);
      if (!validId(channelId) || !body || !DISCORD_NONCE_PATTERN.test(nonce) || nonce.length > 25) return invalid(input.files);
      return typed(route("create_message", "POST", `/channels/${channelId}/messages`, "/channels/:c/messages", channelId, {
        json: { ...body, nonce, enforce_nonce: true }, files: input.files, idempotent: true
      }), messageSchema);
    },
    editMessage: (channelId, messageId, input) => {
      const body = messageBody(input, false);
      if (!validId(channelId) || !validId(messageId) || !body) return invalid(input.files);
      return typed(route("edit_message", "PATCH", `/channels/${channelId}/messages/${messageId}`, "/channels/:c/messages/:m", channelId, {
        json: body, files: input.files
      }), messageSchema);
    },
    deleteMessage: (channelId, messageId) => validId(channelId) && validId(messageId)
      ? empty(route("delete_message", "DELETE", `/channels/${channelId}/messages/${messageId}`, "/channels/:c/messages/:m", channelId))
      : invalid(),
    startThreadFromMessage: (channelId, messageId, input) => {
      const minutes = input.autoArchiveMinutes ?? 1440;
      if (!validId(channelId) || !validId(messageId) || input.name.trim().length < 1
        || input.name.length > DISCORD_THREAD_NAME_MAX_LENGTH || ![60, 1440, 4320, 10080].includes(minutes)) return invalid();
      return typed(route("start_thread_from_message", "POST", `/channels/${channelId}/messages/${messageId}/threads`,
        "/channels/:c/messages/:m/threads", channelId, { json: { name: input.name, auto_archive_duration: minutes } }), channelSchema);
    },
    triggerTyping: (channelId) => validId(channelId)
      ? empty(route("trigger_typing", "POST", `/channels/${channelId}/typing`, "/channels/:c/typing", channelId, { idempotent: true }))
      : invalid(),
    addOwnReaction: (channelId, messageId, emoji) => validId(channelId) && validId(messageId) && validEmoji(emoji)
      ? empty(route("add_own_reaction", "PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        "/channels/:c/messages/:m/reactions/:e/@me", channelId))
      : invalid(),
    removeOwnReaction: (channelId, messageId, emoji) => validId(channelId) && validId(messageId) && validEmoji(emoji)
      ? empty(route("remove_own_reaction", "DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        "/channels/:c/messages/:m/reactions/:e/@me", channelId))
      : invalid(),
    state: () => {
      const current = now();
      return {
        globalPausedUntil: globalPausedUntil > current ? globalPausedUntil : null,
        invalidPausedUntil: invalidPausedUntil > current ? invalidPausedUntil : null,
        invalidCount: invalidTimes.filter((time) => time > current - DISCORD_INVALID_REQUEST_WINDOW_MS).length
      };
    }
  });
}

import { DISCORD_SNOWFLAKE_PATTERN } from "../../contracts/discord";
import { logEvent, runInBackground } from "../observability";
import type { DiscordEventIds } from "../observability/events";
import {
  discordChannelAllowed, discordChannelKind, isDiscordTestAuthor, type DiscordChannelDirectory, type DiscordChannelInfo,
  type DiscordChannelKind, type DiscordMembership
} from "./access";
import { isDiscordBotActive, type DiscordActiveControl, type DiscordEffectiveControl } from "./control/state";

/**
 * Gateway events in, typed handler calls out (PRD D-11, D-18, D-25, D-26,
 * D-36). Intake drops what Discord Connect never acts on, each with a
 * content-free log record: other servers, channels outside the rule (threads
 * and forum posts follow their parent), direct messages while they are off or
 * from someone outside the server, bot and webhook authors (except test
 * authors in test channels, whose messages carry `test`), system message
 * types, edits, questions older than ten minutes or sent while the bot was
 * off, and repeats of an event already handed on. What remains runs in a lane
 * per Discord channel: strictly in order inside it, at most `parallelThreads`
 * lanes at a time (a handler keeps its lane's slot while the answer it
 * admitted runs, with `hold`, so follow-ups still get through), at most 20
 * waiting in one (more go to the overflow handlers, outside the lane). Whether
 * a message is a question, and claiming it, is the handlers' (the bridge);
 * intake never posts to Discord.
 */

export const DISCORD_LANE_QUEUE_LIMIT = 20;
/** Questions older than this (after downtime, a replay or a backfill) are never answered. */
export const DISCORD_STALE_MESSAGE_MS = 10 * 60_000;
/** The backfill after a new session reads conversations active within this window, and every direct-message one. */
export const DISCORD_BACKFILL_WINDOW_MS = 24 * 3_600_000;
export const DISCORD_BACKFILL_CONVERSATIONS_MAX = 200;
const DEDUPE_MAX_KEYS = 8_192;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
/** DEFAULT and REPLY: every other message type is a system message. */
const PERSON_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19]);
const RATING_EMOJI: Readonly<Record<string, 1 | -1>> = { "👍": 1, "👎": -1 };

/** When Discord created the object with this snowflake. */
export function discordSnowflakeTime(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake created at `ms` (for `after=` reads). */
export function discordSnowflakeAt(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH_MS) << 22n).toString();
}

export type DiscordIntakeAuthor = Readonly<{
  id: string;
  username: string;
  globalName: string | null;
  /** The server nickname, when the event carried the member. */
  nick: string | null;
  bot: boolean;
}>;

/** A message as intake read it; `raw` keeps the event's other fields (attachments, embeds) for the bridge's own decoders. */
export type DiscordIntakeMessage = Readonly<{
  id: string;
  channelId: string;
  guildId: string | null;
  type: number;
  content: string;
  author: DiscordIntakeAuthor;
  webhookId: string | null;
  mentionUserIds: readonly string[];
  mentionRoleIds: readonly string[];
  mentionEveryone: boolean;
  /** The message this one replies to (`message_reference`). */
  reference: Readonly<{ messageId: string; channelId: string | null }> | null;
  /** The replied-to message's author, when Discord still had the message. */
  referencedAuthorId: string | null;
  createdAt: Date;
  raw: Readonly<Record<string, unknown>>;
}>;

export type DiscordMessageContext = Readonly<{
  message: DiscordIntakeMessage;
  channel: DiscordChannelInfo;
  /** For a thread, its parent channel as this process knows it. */
  parent: DiscordChannelInfo | null;
  kind: DiscordChannelKind;
  /** A test author's message in a test channel (PRD D-36): handled as a person's, marked `test` in records. */
  test: boolean;
  /** `backfill`: read through REST after a new session, not received from the gateway. */
  source: "live" | "backfill";
  receivedAt: Date;
  /** The control snapshot the message passed under (bot identity with its role, limits, service account, Assistant). */
  control: DiscordActiveControl;
  /**
   * Keeps this channel's Parallel threads slot taken until `until` settles (an
   * admitted run), after the handler returned: the channel's next messages
   * (follow-ups) still run at once, new conversations wait for a free slot.
   */
  hold(until: Promise<unknown>): void;
}>;
/** Returns true when it handled the message; the next registered handler runs otherwise. */
export type DiscordMessageHandler = (context: DiscordMessageContext) => Promise<boolean>;
/** A message that found its lane's queue full; it runs outside the lane. */
export type DiscordOverflowHandler = (context: DiscordMessageContext) => Promise<void>;

export type DiscordDeleteContext = Readonly<{
  messageIds: readonly string[];
  channelId: string;
  guildId: string | null;
  receivedAt: Date;
  control: DiscordActiveControl;
}>;
export type DiscordDeleteHandler = (context: DiscordDeleteContext) => Promise<void>;

export type DiscordReactionContext = Readonly<{
  action: "add" | "remove";
  userId: string;
  messageId: string;
  channelId: string;
  guildId: string | null;
  /** 👍 is 1, 👎 is -1; other emoji never reach handlers. */
  value: 1 | -1;
  /** The reacting member's server nickname or name, when the event carried it. */
  displayName: string | null;
  test: boolean;
  receivedAt: Date;
  control: DiscordActiveControl;
}>;
export type DiscordReactionHandler = (context: DiscordReactionContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Handler registry (process-wide, shared across route bundles)

export type DiscordHandlerRegistry = Readonly<{
  registerMessage(handler: DiscordMessageHandler): () => void;
  registerOverflow(handler: DiscordOverflowHandler): () => void;
  registerDelete(handler: DiscordDeleteHandler): () => void;
  registerReaction(handler: DiscordReactionHandler): () => void;
  messageHandlers(): readonly DiscordMessageHandler[];
  overflowHandlers(): readonly DiscordOverflowHandler[];
  deleteHandlers(): readonly DiscordDeleteHandler[];
  reactionHandlers(): readonly DiscordReactionHandler[];
}>;

export function createDiscordHandlerRegistry(): DiscordHandlerRegistry {
  const lists = { delete: [] as DiscordDeleteHandler[], message: [] as DiscordMessageHandler[],
    overflow: [] as DiscordOverflowHandler[], reaction: [] as DiscordReactionHandler[] };
  function add<T>(list: T[], handler: T): () => void {
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }
  return Object.freeze({
    registerMessage: (handler: DiscordMessageHandler) => add(lists.message, handler),
    registerOverflow: (handler: DiscordOverflowHandler) => add(lists.overflow, handler),
    registerDelete: (handler: DiscordDeleteHandler) => add(lists.delete, handler),
    registerReaction: (handler: DiscordReactionHandler) => add(lists.reaction, handler),
    messageHandlers: () => [...lists.message],
    overflowHandlers: () => [...lists.overflow],
    deleteHandlers: () => [...lists.delete],
    reactionHandlers: () => [...lists.reaction]
  });
}

const globalForDiscord = globalThis as unknown as { __aiqsaDiscordHandlers?: DiscordHandlerRegistry };

/** The application's one handler registry. */
export function discordHandlerRegistry(): DiscordHandlerRegistry {
  globalForDiscord.__aiqsaDiscordHandlers ??= createDiscordHandlerRegistry();
  return globalForDiscord.__aiqsaDiscordHandlers;
}

/** Handles messages that passed intake, in order of registration until one returns true. */
export function registerDiscordMessageHandler(handler: DiscordMessageHandler): () => void {
  return discordHandlerRegistry().registerMessage(handler);
}

/** Handles a message whose lane already has 20 waiting (the bridge answers "busy" to a question). */
export function registerDiscordOverflowHandler(handler: DiscordOverflowHandler): () => void {
  return discordHandlerRegistry().registerOverflow(handler);
}

/** Handles deleted messages (`MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`) in the channel's lane. */
export function registerDiscordDeleteHandler(handler: DiscordDeleteHandler): () => void {
  return discordHandlerRegistry().registerDelete(handler);
}

/** Handles 👍 and 👎 added or removed by a person (or a test author in a test channel). */
export function registerDiscordReactionHandler(handler: DiscordReactionHandler): () => void {
  return discordHandlerRegistry().registerReaction(handler);
}

// ---------------------------------------------------------------------------
// Lanes

export type DiscordLanes = Readonly<{
  /** Queues `job` in lane `key`; `overflow` when the lane already holds `queueLimit` waiting jobs. */
  enqueue(key: string, job: () => Promise<void>): "queued" | "overflow";
  /**
   * Keeps lane `key`'s slot taken until `until` settles, without blocking the
   * lane: its later jobs (a follow-up to a running answer) run in that slot at
   * once, while lanes without a slot wait for a free one.
   */
  hold(key: string, until: Promise<unknown>): void;
  /** Resolves once no job runs or waits (held slots do not count). */
  idle(): Promise<void>;
  /** `active`: slots in use (lanes running a job or holding one); `held`: lanes holding one. */
  stats(): Readonly<{ active: number; held: number; lanes: number; waiting: number }>;
}>;

/**
 * Ordered lanes: one job at a time per key, keys in parallel up to
 * `concurrency()` slots (read whenever a slot frees, so a new Parallel threads
 * setting applies to the next lane). A lane occupies a slot while a job runs
 * and while it holds one (`hold`, for a conversation whose answer is still
 * running). A job's failure never stops its lane.
 */
export function createDiscordLanes(input: Readonly<{ concurrency: () => number; queueLimit?: number }>): DiscordLanes {
  const queueLimit = input.queueLimit ?? DISCORD_LANE_QUEUE_LIMIT;
  type Lane = { jobs: (() => Promise<void>)[]; running: boolean; holds: number };
  const lanes = new Map<string, Lane>();
  const ready: string[] = [];
  let slots = 0;
  let running = 0;
  let waiters: (() => void)[] = [];

  const occupied = (lane: Lane) => lane.running || lane.holds > 0;

  function settle(): void {
    if (running > 0 || ready.length > 0) return;
    const resolved = waiters;
    waiters = [];
    for (const resolve of resolved) resolve();
  }

  function release(key: string, lane: Lane): void {
    if (occupied(lane)) return;
    slots -= 1;
    if (lane.jobs.length > 0) {
      if (!ready.includes(key)) ready.push(key);
    } else if (lanes.get(key) === lane) {
      lanes.delete(key);
    }
  }

  function start(key: string, lane: Lane): void {
    if (!occupied(lane)) slots += 1;
    const job = lane.jobs.shift()!;
    lane.running = true;
    running += 1;
    void runInBackground(job).catch(() => undefined).finally(() => {
      running -= 1;
      lane.running = false;
      if (occupied(lane)) {
        // A held lane goes on in its own slot.
        if (lane.jobs.length > 0 && !ready.includes(key)) ready.push(key);
      } else {
        release(key, lane);
      }
      pump();
      settle();
    });
  }

  function pump(): void {
    let index = 0;
    while (index < ready.length) {
      const key = ready[index]!;
      const lane = lanes.get(key);
      if (!lane || lane.running || lane.jobs.length === 0) {
        ready.splice(index, 1);
        continue;
      }
      if (lane.holds === 0 && slots >= Math.max(1, input.concurrency())) {
        index += 1;
        continue;
      }
      ready.splice(index, 1);
      start(key, lane);
    }
  }

  function laneOf(key: string): Lane {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { holds: 0, jobs: [], running: false };
      lanes.set(key, lane);
    }
    return lane;
  }

  return Object.freeze({
    enqueue(key: string, job: () => Promise<void>) {
      const lane = laneOf(key);
      if (lane.jobs.length >= queueLimit) return "overflow" as const;
      lane.jobs.push(job);
      if (!lane.running && !ready.includes(key)) ready.push(key);
      pump();
      return "queued" as const;
    },
    hold(key: string, until: Promise<unknown>) {
      const lane = laneOf(key);
      if (!occupied(lane)) slots += 1;
      lane.holds += 1;
      void Promise.resolve(until).catch(() => undefined).finally(() => {
        lane.holds -= 1;
        release(key, lane);
        pump();
        settle();
      });
    },
    idle() {
      if (running === 0 && ready.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    stats: () => {
      let held = 0;
      let waiting = 0;
      for (const lane of lanes.values()) {
        if (lane.holds > 0) held += 1;
        waiting += lane.jobs.length;
      }
      return { active: slots, held, lanes: lanes.size, waiting };
    }
  });
}

// ---------------------------------------------------------------------------
// Intake

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snowflake(value: unknown): string | null {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value) ? value : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function snowflakes(value: unknown, key?: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const found = snowflake(key ? record(entry)?.[key] : entry);
    return found ? [found] : [];
  }).slice(0, 100);
}

/** Reads a `MESSAGE_CREATE` payload or a REST message; null when it is not a usable message. */
export function decodeDiscordIntakeMessage(value: unknown): DiscordIntakeMessage | null {
  const payload = record(value);
  const messageId = snowflake(payload?.id);
  const channelId = snowflake(payload?.channel_id);
  const author = record(payload?.author);
  const authorId = snowflake(author?.id);
  if (!payload || !messageId || !channelId || !author || !authorId) return null;
  const member = record(payload.member);
  const reference = record(payload.message_reference);
  const referenced = record(payload.referenced_message);
  const referenceId = snowflake(reference?.message_id);
  // Discord's own send time; the snowflake's embedded time when the field is missing.
  const sentAt = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
  return {
    author: {
      bot: author.bot === true,
      globalName: text(author.global_name, 64),
      id: authorId,
      nick: text(member?.nick, 64),
      username: text(author.username, 64) ?? ""
    },
    channelId,
    content: typeof payload.content === "string" ? payload.content : "",
    createdAt: new Date(Number.isFinite(sentAt) ? sentAt : discordSnowflakeTime(messageId)),
    guildId: snowflake(payload.guild_id),
    id: messageId,
    mentionEveryone: payload.mention_everyone === true,
    mentionRoleIds: snowflakes(payload.mention_roles),
    mentionUserIds: snowflakes(payload.mentions, "id"),
    raw: payload,
    reference: referenceId ? { channelId: snowflake(reference?.channel_id), messageId: referenceId } : null,
    referencedAuthorId: snowflake(record(referenced?.author)?.id),
    type: typeof payload.type === "number" && Number.isSafeInteger(payload.type) ? payload.type : -1,
    webhookId: snowflake(payload.webhook_id)
  };
}

type IntakeReason = "bot_author" | "webhook" | "system_type" | "edit" | "other_guild" | "channel_rule" | "dm_disabled"
  | "not_member" | "stale" | "disabled" | "duplicate";

export type DiscordIntakeDispatch = Readonly<{ type: string; seq?: number; data: unknown; sessionId?: string | null }>;

export type DiscordBackfillSource = Readonly<{
  /** Conversations active since `since` and every direct-message one. */
  conversations(since: Date): Promise<readonly Readonly<{ channelId: string; guildId: string | null }>[]>;
  /** Up to 100 messages after `afterId`, any order; null when the channel cannot be read. */
  messagesAfter(channelId: string, afterId: string): Promise<readonly unknown[] | null>;
}>;

export type DiscordIntake = Readonly<{
  /** One gateway dispatch; resolves once it is dropped, queued or handed to the overflow handlers. */
  accept(dispatch: DiscordIntakeDispatch): Promise<void>;
  /** After a new session (not a resume): reads what was posted in known conversations within the stale window. */
  backfill(): Promise<void>;
  lanes: DiscordLanes;
}>;

export type DiscordIntakeDeps = Readonly<{
  control(): Promise<DiscordEffectiveControl>;
  registry: DiscordHandlerRegistry;
  directory: DiscordChannelDirectory;
  /** A channel this process has not heard of: the conversation store, then Discord. Null when it cannot be named. */
  lookupChannel(channelId: string): Promise<DiscordChannelInfo | null>;
  membership: DiscordMembership;
  backfillSource?: DiscordBackfillSource;
  /** The bot's managed role in a server, read from `GUILD_CREATE`. */
  onBotRole?(input: Readonly<{ guildId: string; roleId: string | null }>): void;
  lanes?: DiscordLanes;
  now?: () => number;
}>;

export function createDiscordIntake(deps: DiscordIntakeDeps): DiscordIntake {
  const now = deps.now ?? Date.now;
  let parallelThreads = 16;
  const lanes = deps.lanes ?? createDiscordLanes({ concurrency: () => parallelThreads });
  const seen = new Map<string, true>();
  /** Filtering may wait on Discord (a channel or membership lookup); events of one channel still reach their lane in order. */
  const filtering = new Map<string, Promise<void>>();

  function ordered(channelId: string | null, work: () => Promise<void>): Promise<void> {
    if (!channelId) return work();
    const previous = filtering.get(channelId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    filtering.set(channelId, settled);
    void settled.then(() => { if (filtering.get(channelId) === settled) filtering.delete(channelId); });
    return next;
  }

  function channelIdOf(data: unknown): string | null {
    return snowflake(record(data)?.channel_id);
  }

  /** True the first time a key is seen within the remembered window. */
  function first(key: string): boolean {
    if (seen.has(key)) return false;
    seen.set(key, true);
    while (seen.size > DEDUPE_MAX_KEYS) seen.delete(seen.keys().next().value as string);
    return true;
  }

  function log(outcome: "ignored" | "refused" | "duplicate", reason: IntakeReason, ids: DiscordEventIds, code?: string): void {
    logEvent("discord_intake", { ...ids, outcome, reason, ...(code ? { code } : {}) });
  }

  async function activeControl(): Promise<DiscordActiveControl | null> {
    const control = await deps.control();
    if (!isDiscordBotActive(control)) return null;
    parallelThreads = control.limits.parallelThreads;
    return control;
  }

  async function channelOf(channelId: string, guildId: string | null): Promise<DiscordChannelInfo | null> {
    if (guildId === null) return { guildId: null, id: channelId, parentId: null, type: 1 };
    const known = deps.directory.get(channelId);
    if (known && known.type !== null) return known;
    const looked = await deps.lookupChannel(channelId).catch(() => null);
    if (looked) deps.directory.remember(looked);
    return looked;
  }

  async function parentOf(channel: DiscordChannelInfo): Promise<DiscordChannelInfo | null> {
    if (!channel.parentId) return null;
    return deps.directory.get(channel.parentId) ?? await channelOf(channel.parentId, channel.guildId);
  }

  async function runMessageHandlers(context: DiscordMessageContext): Promise<void> {
    for (const handler of deps.registry.messageHandlers()) {
      try {
        if (await handler(context)) return;
      } catch (error) {
        logEvent("service_operation", { code: "discord_handler_failed", error, outcome: "failed", stage: "dispatch", subsystem: "discord" });
        return;
      }
    }
  }

  async function message(data: unknown, source: "live" | "backfill", guildHint: string | null = null): Promise<void> {
    const decoded = decodeDiscordIntakeMessage(data);
    if (!decoded) return;
    const control = await activeControl();
    const guildId = decoded.guildId ?? guildHint;
    const ids: DiscordEventIds = {
      author_id: decoded.author.id, channel_id: decoded.channelId, ...(guildId ? { guild_id: guildId } : {}), message_id: decoded.id
    };
    // The bot's own posts (answers, statuses) are never news.
    if (control && decoded.author.id === control.bot.userId) return;
    if (!first(`m:${decoded.id}`)) return log("duplicate", "duplicate", ids);
    if (!control) return log("ignored", "disabled", ids);
    const receivedAt = new Date(now());
    if (control.enabledAt && decoded.createdAt.getTime() < control.enabledAt.getTime()) return log("ignored", "disabled", ids);
    if (receivedAt.getTime() - decoded.createdAt.getTime() > DISCORD_STALE_MESSAGE_MS) return log("ignored", "stale", ids);
    if (guildId !== null && guildId !== control.guildId) return log("ignored", "other_guild", ids);
    const channel = await channelOf(decoded.channelId, guildId);
    if (!channel) return log("ignored", "channel_rule", ids, "discord_channel_unknown");
    let test = false;
    if (decoded.author.bot || decoded.webhookId) {
      if (!isDiscordTestAuthor(control, decoded.author.id, channel)) return log("ignored", decoded.webhookId ? "webhook" : "bot_author", ids);
      test = true;
    }
    if (!PERSON_MESSAGE_TYPES.has(decoded.type)) return log("ignored", "system_type", ids);
    if (guildId === null) {
      if (!control.dmEnabled) return log("ignored", "dm_disabled", ids);
      if (!control.guildId) return log("ignored", "not_member", ids);
      const membership = await deps.membership.check(control.guildId, decoded.author.id);
      if (membership.member === null) return log("refused", "not_member", ids, membership.code);
      if (!membership.member) return log("ignored", "not_member", ids);
    } else if (!discordChannelAllowed(control, channel)) {
      // A thread is judged by its parent channel; one whose parent cannot be named is refused.
      return log("ignored", "channel_rule", ids, channel.type === null ? "discord_channel_unknown" : undefined);
    }
    // Only to tell a forum post from a thread; the rule above needed just the parent's id.
    const parent = await parentOf(channel);
    const context: DiscordMessageContext = {
      channel, control, hold: (until) => lanes.hold(decoded.channelId, until), kind: discordChannelKind(channel, parent ?? undefined),
      message: { ...decoded, guildId }, parent, receivedAt, source, test
    };
    if (lanes.enqueue(decoded.channelId, () => runMessageHandlers(context)) === "overflow") {
      for (const handler of deps.registry.overflowHandlers()) {
        await handler(context).catch((error: unknown) => {
          logEvent("service_operation", { code: "discord_handler_failed", error, outcome: "failed", stage: "dispatch", subsystem: "discord" });
        });
      }
    }
  }

  async function deletion(data: unknown, bulk: boolean): Promise<void> {
    const payload = record(data);
    const channelId = snowflake(payload?.channel_id);
    const messageIds = bulk ? snowflakes(payload?.ids) : [snowflake(payload?.id)].filter((value): value is string => value !== null);
    if (!payload || !channelId || messageIds.length === 0) return;
    const control = await activeControl();
    if (!control) return;
    const guildId = snowflake(payload.guild_id);
    if (guildId !== null && guildId !== control.guildId) return;
    const context: DiscordDeleteContext = { channelId, control, guildId, messageIds, receivedAt: new Date(now()) };
    lanes.enqueue(channelId, async () => {
      for (const handler of deps.registry.deleteHandlers()) {
        await handler(context).catch((error: unknown) => {
          logEvent("service_operation", { code: "discord_handler_failed", error, outcome: "failed", stage: "dispatch", subsystem: "discord" });
        });
      }
    });
  }

  async function reaction(data: unknown, action: "add" | "remove"): Promise<void> {
    const payload = record(data);
    const userId = snowflake(payload?.user_id);
    const messageId = snowflake(payload?.message_id);
    const channelId = snowflake(payload?.channel_id);
    const value = RATING_EMOJI[text(record(payload?.emoji)?.name, 16) ?? ""];
    if (!payload || !userId || !messageId || !channelId || value === undefined) return;
    const control = await activeControl();
    if (!control || userId === control.bot.userId) return;
    const guildId = snowflake(payload.guild_id);
    if (guildId !== null && guildId !== control.guildId) return;
    const member = record(payload.member);
    const memberUser = record(member?.user);
    let test = false;
    if (memberUser?.bot === true) {
      const channel = await channelOf(channelId, guildId);
      if (!channel || !isDiscordTestAuthor(control, userId, channel)) {
        return log("ignored", "bot_author", { channel_id: channelId, ...(guildId ? { guild_id: guildId } : {}), message_id: messageId, author_id: userId });
      }
      test = true;
    } else if (control.testAuthorIds.has(userId)) {
      // A removal names no member; a test author's removal counts only in a test channel.
      const channel = await channelOf(channelId, guildId);
      test = channel !== null && isDiscordTestAuthor(control, userId, channel);
    }
    const context: DiscordReactionContext = {
      action, channelId, control, displayName: text(member?.nick, 64) ?? text(memberUser?.global_name, 64) ?? text(memberUser?.username, 64),
      guildId, messageId, receivedAt: new Date(now()), test, userId, value
    };
    lanes.enqueue(channelId, async () => {
      for (const handler of deps.registry.reactionHandlers()) {
        await handler(context).catch((error: unknown) => {
          logEvent("service_operation", { code: "discord_handler_failed", error, outcome: "failed", stage: "dispatch", subsystem: "discord" });
        });
      }
    });
  }

  function botRole(data: unknown, control: DiscordEffectiveControl): void {
    const payload = record(data);
    const guildId = snowflake(payload?.id);
    if (!payload || !guildId || guildId !== control.guildId || !control.bot || !Array.isArray(payload.roles)) return;
    const botUserId = control.bot.userId;
    const role = payload.roles.map(record).find((entry) => snowflake(record(entry?.tags)?.bot_id) === botUserId);
    deps.onBotRole?.({ guildId, roleId: snowflake(role?.id) });
  }

  return Object.freeze({
    lanes,

    async accept(dispatch) {
      if (dispatch.sessionId && typeof dispatch.seq === "number" && !first(`s:${dispatch.sessionId}:${dispatch.seq}`)) {
        const payload = record(dispatch.data);
        const messageId = snowflake(payload?.id) ?? snowflake(payload?.message_id);
        const channelId = snowflake(payload?.channel_id);
        log("duplicate", "duplicate", { ...(messageId ? { message_id: messageId } : {}), ...(channelId ? { channel_id: channelId } : {}) });
        return;
      }
      switch (dispatch.type) {
        case "MESSAGE_CREATE": return ordered(channelIdOf(dispatch.data), () => message(dispatch.data, "live"));
        case "MESSAGE_UPDATE": {
          const payload = record(dispatch.data);
          const messageId = snowflake(payload?.id);
          const authorId = snowflake(record(payload?.author)?.id);
          const control = await activeControl();
          if (!messageId || !authorId || !control || authorId === control.bot.userId) return;
          const guildId = snowflake(payload?.guild_id);
          if (guildId !== null && guildId !== control.guildId) return;
          return log("ignored", "edit", {
            author_id: authorId, channel_id: snowflake(payload?.channel_id) ?? undefined, ...(guildId ? { guild_id: guildId } : {}), message_id: messageId
          });
        }
        case "MESSAGE_DELETE": return ordered(channelIdOf(dispatch.data), () => deletion(dispatch.data, false));
        case "MESSAGE_DELETE_BULK": return ordered(channelIdOf(dispatch.data), () => deletion(dispatch.data, true));
        case "MESSAGE_REACTION_ADD": return ordered(channelIdOf(dispatch.data), () => reaction(dispatch.data, "add"));
        case "MESSAGE_REACTION_REMOVE": return ordered(channelIdOf(dispatch.data), () => reaction(dispatch.data, "remove"));
        case "GUILD_CREATE": {
          deps.directory.ingest(dispatch.type, dispatch.data);
          botRole(dispatch.data, await deps.control());
          return;
        }
        default:
          deps.directory.ingest(dispatch.type, dispatch.data);
      }
    },

    async backfill() {
      const source = deps.backfillSource;
      const control = await activeControl();
      if (!source || !control) return;
      const at = now();
      const after = discordSnowflakeAt(Math.max(at - DISCORD_STALE_MESSAGE_MS, control.enabledAt?.getTime() ?? 0));
      const conversations = (await source.conversations(new Date(at - DISCORD_BACKFILL_WINDOW_MS))).slice(0, DISCORD_BACKFILL_CONVERSATIONS_MAX);
      for (const conversation of conversations) {
        const messages = await source.messagesAfter(conversation.channelId, after).catch(() => null);
        if (!messages) continue;
        const sorted = messages
          .map((entry) => ({ entry, id: snowflake(record(entry)?.id) }))
          .filter((entry): entry is { entry: unknown; id: string } => entry.id !== null)
          .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
        for (const { entry } of sorted) await ordered(conversation.channelId, () => message(entry, "backfill", conversation.guildId));
      }
    }
  });
}

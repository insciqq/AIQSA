import { DISCORD_SNOWFLAKE_PATTERN } from "../../contracts/discord";
import type { DiscordEffectiveControl } from "./control/state";
import type { DiscordRest } from "./rest";

/**
 * Who and where Discord Connect listens (PRD D-08, D-11, D-36): the channel
 * rule of the chosen server, with threads and forum posts following their
 * parent channel; direct messages only while they are on and only from members
 * of that server (checked through Discord and remembered ten minutes); bot
 * authors only when they are test authors in a test channel or its threads.
 * A channel whose parent cannot be named fails closed.
 */

export const DISCORD_THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);
export const DISCORD_FORUM_TYPES: ReadonlySet<number> = new Set([15, 16]);
export const DISCORD_VOICE_TYPES: ReadonlySet<number> = new Set([2, 13]);
export const DISCORD_DM_CHANNEL_TYPE = 1;
export const DISCORD_MEMBERSHIP_CACHE_MS = 10 * 60_000;
const DIRECTORY_MAX_ENTRIES = 20_000;
const MEMBERSHIP_MAX_ENTRIES = 10_000;

/** A channel or thread as far as the rule needs it; `type` is Discord's channel type, null when unknown. */
export type DiscordChannelInfo = Readonly<{
  id: string;
  type: number | null;
  guildId: string | null;
  parentId: string | null;
}>;

export type DiscordChannelKind = "dm" | "thread" | "forum_post" | "voice" | "text" | "announcement" | "other";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value) ? value : null;
}

/** Reads a channel object of a gateway event or a REST answer. */
export function discordChannelInfo(value: unknown, guildId: string | null = null): DiscordChannelInfo | null {
  const channel = record(value);
  const channelId = id(channel?.id);
  if (!channel || !channelId) return null;
  return {
    guildId: id(channel.guild_id) ?? guildId,
    id: channelId,
    parentId: id(channel.parent_id),
    type: typeof channel.type === "number" && Number.isSafeInteger(channel.type) ? channel.type : null
  };
}

/**
 * The channels and threads this process has heard of from the gateway
 * (`GUILD_CREATE`, channel and thread events), bounded; a resumed session
 * hears no `GUILD_CREATE`, so misses go to a lookup.
 */
export type DiscordChannelDirectory = Readonly<{
  get(channelId: string): DiscordChannelInfo | undefined;
  remember(channel: DiscordChannelInfo): void;
  forget(channelId: string): void;
  /** Learns from one gateway dispatch; other types are ignored. */
  ingest(type: string, data: unknown): void;
}>;

export function createDiscordChannelDirectory(maxEntries = DIRECTORY_MAX_ENTRIES): DiscordChannelDirectory {
  const channels = new Map<string, DiscordChannelInfo>();

  function remember(channel: DiscordChannelInfo): void {
    channels.delete(channel.id);
    channels.set(channel.id, channel);
    while (channels.size > maxEntries) channels.delete(channels.keys().next().value as string);
  }

  return Object.freeze({
    get: (channelId: string) => channels.get(channelId),
    remember,
    forget: (channelId: string) => { channels.delete(channelId); },
    ingest(type: string, data: unknown) {
      const payload = record(data);
      if (!payload) return;
      switch (type) {
        case "GUILD_CREATE": {
          const guildId = id(payload.id);
          for (const list of [payload.channels, payload.threads]) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
              const channel = discordChannelInfo(entry, guildId);
              if (channel) remember(channel);
            }
          }
          return;
        }
        case "CHANNEL_CREATE":
        case "CHANNEL_UPDATE":
        case "THREAD_CREATE":
        case "THREAD_UPDATE": {
          const channel = discordChannelInfo(payload);
          if (channel) remember(channel);
          return;
        }
        case "CHANNEL_DELETE":
        case "THREAD_DELETE": {
          const channelId = id(payload.id);
          if (channelId) channels.delete(channelId);
          return;
        }
        case "THREAD_LIST_SYNC": {
          const guildId = id(payload.guild_id);
          if (!Array.isArray(payload.threads)) return;
          for (const entry of payload.threads) {
            const channel = discordChannelInfo(entry, guildId);
            if (channel) remember(channel);
          }
          return;
        }
        default:
      }
    }
  });
}

/** The conversation key's kind of channel, for the bridge. */
export function discordChannelKind(channel: DiscordChannelInfo, parent: DiscordChannelInfo | undefined): DiscordChannelKind {
  if (channel.guildId === null || channel.type === DISCORD_DM_CHANNEL_TYPE) return "dm";
  if (channel.type !== null && DISCORD_THREAD_TYPES.has(channel.type)) {
    const parentType = parent?.type ?? null;
    return parentType !== null && DISCORD_FORUM_TYPES.has(parentType) ? "forum_post" : "thread";
  }
  if (channel.type !== null && DISCORD_VOICE_TYPES.has(channel.type)) return "voice";
  if (channel.type === 0) return "text";
  if (channel.type === 5) return "announcement";
  return "other";
}

/** The channel and, for a thread, its parent: the ids the channel rule and the test channels are checked against. */
function ruleIds(channel: DiscordChannelInfo): string[] {
  return channel.parentId && channel.type !== null && DISCORD_THREAD_TYPES.has(channel.type) ? [channel.id, channel.parentId] : [channel.id];
}

/**
 * Whether the channel rule lets the bot listen here. A thread whose parent is
 * unknown is refused in every mode, so a thread of an excluded channel never
 * slips through.
 */
export function discordChannelAllowed(
  control: Pick<DiscordEffectiveControl, "channelIds" | "channelMode">,
  channel: DiscordChannelInfo
): boolean {
  if (channel.type === null) return false;
  if (DISCORD_THREAD_TYPES.has(channel.type) && !channel.parentId) return false;
  const listed = ruleIds(channel).some((candidate) => control.channelIds.has(candidate));
  return control.channelMode === "only_listed" ? listed : !listed;
}

/** A test channel or one of its threads (PRD D-36). */
export function isDiscordTestChannel(control: Pick<DiscordEffectiveControl, "testChannelIds">, channel: DiscordChannelInfo): boolean {
  return ruleIds(channel).some((candidate) => control.testChannelIds.has(candidate));
}

/** A bot author's message counts as a person's only from a test author in a test channel. */
export function isDiscordTestAuthor(
  control: Pick<DiscordEffectiveControl, "testAuthorIds" | "testChannelIds">,
  authorId: string,
  channel: DiscordChannelInfo
): boolean {
  return control.testAuthorIds.has(authorId) && isDiscordTestChannel(control, channel);
}

export type DiscordMembershipAnswer =
  | Readonly<{ member: boolean }>
  | Readonly<{ member: null; code: string }>;

export type DiscordMembership = Readonly<{
  /** Whether the user is a member of the server; a failed check is not remembered and answers `member: null`. */
  check(guildId: string, userId: string): Promise<DiscordMembershipAnswer>;
}>;

/**
 * Server membership through `GET /guilds/{guild}/members/{user}` (no
 * privileged intent needed), each answer remembered ten minutes. Discord's
 * 404 (unknown member) is a definite no.
 */
export function createDiscordMembership(input: Readonly<{
  rest: () => Promise<DiscordRest | null>;
  now?: () => number;
  ttlMs?: number;
}>): DiscordMembership {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DISCORD_MEMBERSHIP_CACHE_MS;
  const cache = new Map<string, { member: boolean; expiresAt: number }>();
  return Object.freeze({
    async check(guildId: string, userId: string) {
      const key = `${guildId}:${userId}`;
      const at = now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > at) return { member: cached.member };
      const rest = await input.rest();
      if (!rest) return { code: "discord_token_missing", member: null };
      const answer = await rest.getGuildMember(guildId, userId);
      let member: boolean;
      if (answer.ok) member = true;
      else if (answer.status === 404) member = false;
      else return { code: answer.code, member: null };
      cache.delete(key);
      cache.set(key, { expiresAt: at + ttlMs, member });
      while (cache.size > MEMBERSHIP_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      return { member };
    }
  });
}

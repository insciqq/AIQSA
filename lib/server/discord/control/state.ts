import type { DiscordChannelMode, DiscordLimits } from "../../../contracts/discord";
import type { DiscordControlRecord, DiscordPersistedSession } from "./repository";
import { decryptDiscordBotToken } from "./tokenEnvelope";

/**
 * The control row as the running application uses it: switch, choices and the
 * opened token of the current generation. A short process-local snapshot
 * serves the gateway, intake and every REST call (the kill switch reads it);
 * every administrator write drops it (one replica), and the TTL bounds
 * anything else.
 */

export const DISCORD_CONTROL_CACHE_TTL_MS = 30_000;

export type DiscordBotIdentity = Readonly<{
  applicationId: string;
  userId: string;
  username: string;
  /** The managed role in the chosen server, once the gateway named it. */
  roleId: string | null;
  generation: number;
  token: string;
}>;

export type DiscordEffectiveControl = Readonly<{
  version: number;
  enabled: boolean;
  enabledAt: Date | null;
  /** `missing` before a token was saved; `unreadable` when the envelope no longer opens. */
  tokenState: "missing" | "ready" | "unreadable";
  /** The bot and its opened token, only while the token is readable. */
  bot: DiscordBotIdentity | null;
  guildId: string | null;
  channelMode: DiscordChannelMode;
  channelIds: ReadonlySet<string>;
  dmEnabled: boolean;
  testAuthorIds: ReadonlySet<string>;
  testChannelIds: ReadonlySet<string>;
  /** Names that address the bot in channels and threads (`bridge/triggers.ts`). */
  callNames: readonly string[];
  serviceUserId: string | null;
  assistantId: string | null;
  limits: DiscordLimits;
  /** The persisted gateway session of the current token generation, if any. */
  session: Omit<DiscordPersistedSession, "generation"> | null;
}>;

export type DiscordActiveControl = DiscordEffectiveControl & Readonly<{ enabled: true; bot: DiscordBotIdentity }>;

/** Whether the bot operates at all: switched on with a readable token. */
export function isDiscordBotActive(control: DiscordEffectiveControl): control is DiscordActiveControl {
  return control.enabled && control.bot !== null;
}

export function effectiveDiscordControl(record: DiscordControlRecord, key: () => Buffer): DiscordEffectiveControl {
  const base = {
    assistantId: record.assistantId,
    callNames: record.callNames,
    channelIds: new Set(record.channelIds),
    channelMode: record.channelMode,
    dmEnabled: record.dmEnabled,
    enabled: record.enabled,
    enabledAt: record.enabledAt,
    guildId: record.guildId,
    limits: record.limits,
    serviceUserId: record.serviceUserId,
    testAuthorIds: new Set(record.testAuthorIds),
    testChannelIds: new Set(record.testChannelIds),
    version: record.version
  };
  if (record.tokenEnvelope === null || record.botUserId === null || record.applicationId === null || record.botUsername === null) {
    return { ...base, bot: null, session: null, tokenState: "missing" };
  }
  try {
    const token = decryptDiscordBotToken({ envelope: record.tokenEnvelope, generation: record.tokenGeneration, key: key() });
    const session = record.session && record.session.generation === record.tokenGeneration
      ? { resumeGatewayUrl: record.session.resumeGatewayUrl, seq: record.session.seq, sessionId: record.session.sessionId }
      : null;
    return {
      ...base,
      bot: {
        applicationId: record.applicationId, generation: record.tokenGeneration, roleId: record.botRoleId, token,
        userId: record.botUserId, username: record.botUsername
      },
      session,
      tokenState: "ready"
    };
  } catch {
    return { ...base, bot: null, session: null, tokenState: "unreadable" };
  }
}

export type DiscordControlCache = Readonly<{
  get(): Promise<DiscordEffectiveControl>;
  /** Drops the snapshot; every control write calls it after its commit. */
  invalidate(): void;
}>;

export function createDiscordControlCache(input: Readonly<{
  load(): Promise<DiscordEffectiveControl>;
  now?: () => number;
  ttlMs?: number;
}>): DiscordControlCache {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DISCORD_CONTROL_CACHE_TTL_MS;
  let generation = 0;
  let cached: { expiresAt: number; generation: number; value: Promise<DiscordEffectiveControl> } | null = null;
  return Object.freeze({
    get() {
      const at = now();
      if (cached && cached.generation === generation && cached.expiresAt > at) return cached.value;
      const value = input.load();
      const entry = { expiresAt: at + ttlMs, generation, value };
      cached = entry;
      // A failed load is never served from the cache.
      value.catch(() => {
        if (cached === entry) cached = null;
      });
      return value;
    },
    invalidate() {
      generation += 1;
      cached = null;
    }
  });
}

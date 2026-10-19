import type { TelegramControlRecord } from "./repository";
import { decryptTelegramBotToken } from "./tokenEnvelope";

/**
 * The control row as the running application uses it: switch, access and the
 * opened token of the current generation. A short process-local snapshot
 * serves every update and delivery; every administrator write drops it (one
 * replica), and the TTL bounds anything else.
 */

export const TELEGRAM_CONTROL_CACHE_TTL_MS = 30_000;

export type TelegramBotIdentity = Readonly<{
  id: number;
  username: string;
  generation: number;
  token: string;
}>;

export type TelegramEffectiveControl = Readonly<{
  version: number;
  enabled: boolean;
  restricted: boolean;
  groupIds: ReadonlySet<string>;
  /** `missing` before a token was saved; `unreadable` when the envelope no longer opens. */
  tokenState: "missing" | "ready" | "unreadable";
  /** The bot and its opened token, only while the token is readable. */
  bot: TelegramBotIdentity | null;
}>;

export type TelegramActiveControl = TelegramEffectiveControl & Readonly<{ enabled: true; bot: TelegramBotIdentity }>;

/** Whether the bot operates at all: switched on with a readable token. */
export function isTelegramBotActive(control: TelegramEffectiveControl): control is TelegramActiveControl {
  return control.enabled && control.bot !== null;
}

export function effectiveTelegramControl(record: TelegramControlRecord, key: () => Buffer): TelegramEffectiveControl {
  const base = {
    enabled: record.enabled,
    groupIds: new Set(record.groupIds),
    restricted: record.restricted,
    version: record.version
  };
  if (record.tokenEnvelope === null || record.botId === null || record.botUsername === null) {
    return { ...base, bot: null, tokenState: "missing" };
  }
  try {
    const token = decryptTelegramBotToken({ envelope: record.tokenEnvelope, generation: record.tokenGeneration, key: key() });
    return {
      ...base,
      bot: { generation: record.tokenGeneration, id: record.botId, token, username: record.botUsername },
      tokenState: "ready"
    };
  } catch {
    return { ...base, bot: null, tokenState: "unreadable" };
  }
}

export type TelegramControlCache = Readonly<{
  get(): Promise<TelegramEffectiveControl>;
  /** Drops the snapshot; every control write calls it after its commit. */
  invalidate(): void;
}>;

export function createTelegramControlCache(input: Readonly<{
  load(): Promise<TelegramEffectiveControl>;
  now?: () => number;
  ttlMs?: number;
}>): TelegramControlCache {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? TELEGRAM_CONTROL_CACHE_TTL_MS;
  let generation = 0;
  let cached: { expiresAt: number; generation: number; value: Promise<TelegramEffectiveControl> } | null = null;
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

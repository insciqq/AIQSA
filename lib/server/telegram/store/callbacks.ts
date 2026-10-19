import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TELEGRAM_CALLBACK_DATA_PATTERN, type TelegramCallbackKind } from "../../../contracts/telegram";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * Inline buttons as server rows. A button's callback data is `c:` and a
 * 128-bit random row id, so nothing a button carries can be forged or
 * guessed; the row names its link, kind and an identifiers-only payload. A
 * press counts only from the link's own Telegram account in its own chat,
 * before expiry; single-use kinds are consumed once.
 */

export const TELEGRAM_CALLBACK_DEFAULT_TTL_MS = 24 * 3_600_000;
export const TELEGRAM_CALLBACK_MAX_TTL_MS = 7 * 24 * 3_600_000;
const PAYLOAD_MAX_BYTES = 1_024;
const PAYLOAD_MAX_KEYS = 16;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;

export type TelegramCallbackPayloadValue = string | number | boolean | null;
export type TelegramCallbackPayload = Readonly<Record<string, TelegramCallbackPayloadValue>>;

export type TelegramCallbackRecord = Readonly<{
  id: string;
  linkId: string;
  userId: string;
  kind: TelegramCallbackKind;
  payload: TelegramCallbackPayload;
  expiresAt: Date;
}>;

export type TelegramCallbackRefusal = "invalid" | "unknown" | "foreign" | "expired" | "consumed";

export type TelegramCallbackInput = Readonly<{
  kind: TelegramCallbackKind;
  payload?: TelegramCallbackPayload;
  ttlMs?: number;
}>;

export type TelegramCallbackStore = Readonly<{
  /** Stores the buttons of one keyboard and returns their callback data, in order. */
  create(input: Readonly<{ linkId: string; now: Date; buttons: readonly TelegramCallbackInput[] }>): Promise<readonly string[]>;
  /** Resolves a press: the bot, Telegram user and chat must be the link's own. */
  resolve(input: Readonly<{
    botId: number; data: string | undefined; now: Date; telegramChatId: number; telegramUserId: number;
  }>): Promise<Readonly<{ ok: true; callback: TelegramCallbackRecord }> | Readonly<{ ok: false; reason: TelegramCallbackRefusal }>>;
  /** Consumes a single-use button once; false when it was already used or expired. */
  consume(input: Readonly<{ id: string; now: Date }>): Promise<boolean>;
}>;

export class TelegramCallbackPayloadError extends Error {
  constructor() {
    super("telegram_callback_payload_invalid");
    this.name = "TelegramCallbackPayloadError";
  }
}

/** 16 random bytes in base64url: exactly 22 characters. */
export function newTelegramCallbackId(): string {
  return randomBytes(16).toString("base64url");
}

/** A flat object of identifiers and flags, bounded; never free text from a message. */
export function normalizeTelegramCallbackPayload(value: TelegramCallbackPayload | undefined): TelegramCallbackPayload {
  const payload = value ?? {};
  const entries = Object.entries(payload);
  if (entries.length > PAYLOAD_MAX_KEYS) throw new TelegramCallbackPayloadError();
  for (const [key, entry] of entries) {
    if (!PAYLOAD_KEY.test(key)) throw new TelegramCallbackPayloadError();
    const valid = entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isSafeInteger(entry))
      || (typeof entry === "string" && entry.length <= 256);
    if (!valid) throw new TelegramCallbackPayloadError();
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_MAX_BYTES) throw new TelegramCallbackPayloadError();
  return { ...payload };
}

function ttl(ms: number | undefined): number {
  const value = ms ?? TELEGRAM_CALLBACK_DEFAULT_TTL_MS;
  return Number.isSafeInteger(value) && value >= 1_000 ? Math.min(value, TELEGRAM_CALLBACK_MAX_TTL_MS) : TELEGRAM_CALLBACK_DEFAULT_TTL_MS;
}

function payloadOf(value: Prisma.JsonValue): TelegramCallbackPayload {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TelegramCallbackPayload : {};
}

export function createPrismaTelegramCallbackStore(
  prisma: Pick<PrismaClient, "telegramCallback">,
  options: Readonly<{ newId?: () => string }> = {}
): TelegramCallbackStore {
  const newId = options.newId ?? newTelegramCallbackId;
  return Object.freeze({
    async create(input) {
      if (input.buttons.length === 0) return [];
      const rows = input.buttons.map((button) => ({
        expiresAt: new Date(input.now.getTime() + ttl(button.ttlMs)),
        id: newId(),
        kind: button.kind,
        linkId: input.linkId,
        payload: normalizeTelegramCallbackPayload(button.payload) as Prisma.InputJsonObject,
        createdAt: input.now
      }));
      await prisma.telegramCallback.createMany({ data: rows }).catch(retainDatabaseFailure);
      return rows.map((row) => `c:${row.id}`);
    },

    async resolve(input) {
      if (typeof input.data !== "string" || !TELEGRAM_CALLBACK_DATA_PATTERN.test(input.data)) return { ok: false, reason: "invalid" };
      const row = await prisma.telegramCallback.findUnique({
        include: { link: { select: { botId: true, telegramChatId: true, telegramUserId: true, userId: true } } },
        where: { id: input.data.slice(2) }
      }).catch(retainDatabaseFailure);
      if (!row) return { ok: false, reason: "unknown" };
      if (Number(row.link.botId) !== input.botId || Number(row.link.telegramUserId) !== input.telegramUserId
        || Number(row.link.telegramChatId) !== input.telegramChatId) {
        return { ok: false, reason: "foreign" };
      }
      if (row.expiresAt <= input.now) return { ok: false, reason: "expired" };
      if (row.consumedAt) return { ok: false, reason: "consumed" };
      return {
        callback: {
          expiresAt: row.expiresAt, id: row.id, kind: row.kind, linkId: row.linkId, payload: payloadOf(row.payload), userId: row.link.userId
        },
        ok: true
      };
    },

    async consume(input) {
      const result = await prisma.telegramCallback.updateMany({
        data: { consumedAt: input.now }, where: { consumedAt: null, expiresAt: { gt: input.now }, id: input.id }
      }).catch(retainDatabaseFailure);
      return result.count === 1;
    }
  });
}

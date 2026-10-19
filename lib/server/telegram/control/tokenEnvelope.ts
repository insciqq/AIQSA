import { TELEGRAM_BOT_TOKEN_MAX_LENGTH, TELEGRAM_BOT_TOKEN_PATTERN } from "../../../contracts/telegram";
import { decryptSecretEnvelope, encryptSecretEnvelope, type SecretEnvelopeContext } from "../../secrets/envelope";

/**
 * The bot token at rest: one `AIQSA_ENCRYPTION_KEY` envelope bound to the
 * installation's Telegram owner, its purpose and the token's generation, so an
 * envelope never opens under another generation. Plaintext leaves only to the
 * Bot API client.
 */

export const TELEGRAM_CONTROL_OWNER_ID = "installation-telegram";
export const TELEGRAM_BOT_TOKEN_PURPOSE = "telegram_bot_token";

const MAX_GENERATION = 2_147_483_647;
const MAX_ENVELOPE_BYTES = 4 * 1_024;
const MAX_PLAINTEXT_BYTES = 1_024;

type StoredTelegramBotToken = Readonly<{ token: string; version: 1 }>;

export class TelegramTokenEnvelopeError extends Error {
  readonly code = "telegram_token_unreadable";

  constructor() {
    super("telegram_token_unreadable");
    this.name = "TelegramTokenEnvelopeError";
  }
}

export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= TELEGRAM_BOT_TOKEN_MAX_LENGTH && TELEGRAM_BOT_TOKEN_PATTERN.test(value);
}

/** The bot id a token names (the part before its colon). */
export function telegramTokenBotId(token: string): number | null {
  const id = Number(token.slice(0, token.indexOf(":")));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function context(generation: number): SecretEnvelopeContext {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) throw new TelegramTokenEnvelopeError();
  return { ownerId: TELEGRAM_CONTROL_OWNER_ID, purpose: TELEGRAM_BOT_TOKEN_PURPOSE, valueId: String(generation) };
}

export function encryptTelegramBotToken(input: Readonly<{ generation: number; key: Buffer; token: string }>): string {
  if (!isTelegramBotToken(input.token)) throw new TelegramTokenEnvelopeError();
  return encryptSecretEnvelope({ token: input.token, version: 1 } satisfies StoredTelegramBotToken, input.key,
    context(input.generation), { maxPlaintextBytes: MAX_PLAINTEXT_BYTES });
}

/** Opens a stored token; any mismatch (key, generation, shape) is `TelegramTokenEnvelopeError`. */
export function decryptTelegramBotToken(input: Readonly<{ envelope: string; generation: number; key: Buffer }>): string {
  if (!input.envelope || Buffer.byteLength(input.envelope, "utf8") > MAX_ENVELOPE_BYTES) throw new TelegramTokenEnvelopeError();
  let stored: unknown;
  try {
    stored = decryptSecretEnvelope<unknown>(input.envelope, input.key, context(input.generation), { maxPlaintextBytes: MAX_PLAINTEXT_BYTES });
  } catch {
    throw new TelegramTokenEnvelopeError();
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new TelegramTokenEnvelopeError();
  const value = stored as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.version !== 1 || !isTelegramBotToken(value.token)) throw new TelegramTokenEnvelopeError();
  return value.token;
}

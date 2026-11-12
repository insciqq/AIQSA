import { DISCORD_BOT_TOKEN_MAX_LENGTH, DISCORD_BOT_TOKEN_PATTERN } from "../../../contracts/discord";
import { decryptSecretEnvelope, encryptSecretEnvelope, type SecretEnvelopeContext } from "../../secrets/envelope";

/**
 * The bot token at rest: one `AIQSA_ENCRYPTION_KEY` envelope bound to the
 * installation's Discord owner, its purpose and the token's generation, so an
 * envelope never opens under another generation. Plaintext leaves only to the
 * Discord REST and gateway clients.
 */

export const DISCORD_CONTROL_OWNER_ID = "installation-discord";
export const DISCORD_BOT_TOKEN_PURPOSE = "discord_bot_token";

const MAX_GENERATION = 2_147_483_647;
const MAX_ENVELOPE_BYTES = 4 * 1_024;
const MAX_PLAINTEXT_BYTES = 1_024;

type StoredDiscordBotToken = Readonly<{ token: string; version: 1 }>;

export class DiscordTokenEnvelopeError extends Error {
  readonly code = "discord_token_unreadable";

  constructor() {
    super("discord_token_unreadable");
    this.name = "DiscordTokenEnvelopeError";
  }
}

export function isDiscordBotToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= DISCORD_BOT_TOKEN_MAX_LENGTH && DISCORD_BOT_TOKEN_PATTERN.test(value);
}

function context(generation: number): SecretEnvelopeContext {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) throw new DiscordTokenEnvelopeError();
  return { ownerId: DISCORD_CONTROL_OWNER_ID, purpose: DISCORD_BOT_TOKEN_PURPOSE, valueId: String(generation) };
}

export function encryptDiscordBotToken(input: Readonly<{ generation: number; key: Buffer; token: string }>): string {
  if (!isDiscordBotToken(input.token)) throw new DiscordTokenEnvelopeError();
  return encryptSecretEnvelope({ token: input.token, version: 1 } satisfies StoredDiscordBotToken, input.key,
    context(input.generation), { maxPlaintextBytes: MAX_PLAINTEXT_BYTES });
}

/** Opens a stored token; any mismatch (key, generation, shape) is `DiscordTokenEnvelopeError`. */
export function decryptDiscordBotToken(input: Readonly<{ envelope: string; generation: number; key: Buffer }>): string {
  if (!input.envelope || Buffer.byteLength(input.envelope, "utf8") > MAX_ENVELOPE_BYTES) throw new DiscordTokenEnvelopeError();
  let stored: unknown;
  try {
    stored = decryptSecretEnvelope<unknown>(input.envelope, input.key, context(input.generation), { maxPlaintextBytes: MAX_PLAINTEXT_BYTES });
  } catch {
    throw new DiscordTokenEnvelopeError();
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new DiscordTokenEnvelopeError();
  const value = stored as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.version !== 1 || !isDiscordBotToken(value.token)) throw new DiscordTokenEnvelopeError();
  return value.token;
}

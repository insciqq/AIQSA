import { z } from "zod";

/**
 * Telegram Connect wires: the administrator's bot state and commands, the
 * user's link status and link code, the administrator's view of one user's
 * link, the closed reason codes and the inline-button kinds. The bot token is
 * write-only: no wire the browser receives carries it.
 */

/** Every visible Telegram refusal or health reason. */
export const TELEGRAM_REASON_CODES = [
  "telegram_access_off",
  "telegram_account_in_use",
  "telegram_bot_changed",
  "telegram_busy",
  "telegram_delivery_unknown",
  "telegram_file_too_large",
  "telegram_link_code_invalid",
  "telegram_not_linked",
  "telegram_poll_conflict",
  "telegram_render_fallback",
  "telegram_token_rejected",
  "telegram_unreachable",
  "telegram_unsupported_message",
  "telegram_voice_too_long",
  "telegram_voice_unavailable"
] as const;
export type TelegramReasonCode = (typeof TELEGRAM_REASON_CODES)[number];
export const telegramReasonCodeSchema = z.enum(TELEGRAM_REASON_CODES);

/** The health reasons the administrator's bot state can report. */
export const TELEGRAM_HEALTH_CODES = ["telegram_poll_conflict", "telegram_token_rejected", "telegram_unreachable"] as const;
export type TelegramHealthCode = (typeof TELEGRAM_HEALTH_CODES)[number];

/** Server-owned kinds of the rows an inline button's callback data names. */
export const TELEGRAM_CALLBACK_KINDS = [
  "approval_allow_once",
  "approval_allow_server",
  "approval_deny",
  "select_chat",
  "select_assistant",
  "select_model",
  "model_page",
  "toggle_search",
  "toggle_workspace",
  "toggle_agent",
  "stop_run",
  "unlink_confirm",
  "open_settings"
] as const;
export type TelegramCallbackKind = (typeof TELEGRAM_CALLBACK_KINDS)[number];
export const telegramCallbackKindSchema = z.enum(TELEGRAM_CALLBACK_KINDS);

/** `c:` and 22 base64url characters (128 random bits): the id of one server button row. */
export const TELEGRAM_CALLBACK_DATA_PATTERN = /^c:[A-Za-z0-9_-]{22}$/u;

export const TELEGRAM_LINK_STATES = ["not_linked", "linked", "access_off", "bot_changed"] as const;
export type TelegramLinkState = (typeof TELEGRAM_LINK_STATES)[number];

/** Bot API tokens: the bot id, a colon and the secret part. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u;
export const TELEGRAM_BOT_TOKEN_MAX_LENGTH = 150;
/** Telegram usernames: 4–32 letters, digits and underscores, starting with a letter. */
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;
const GROUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const TELEGRAM_ACCESS_GROUPS_MAX = 200;
export const TELEGRAM_DISPLAY_NAME_MAX_LENGTH = 128;
/** `t.me/<bot>?start=<code>`; Telegram allows 1–64 `[A-Za-z0-9_-]` characters in `start`. */
const TELEGRAM_DEEP_LINK_PATTERN = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\?start=[A-Za-z0-9_-]{1,64}$/u;

const timestamp = z.iso.datetime({ offset: false });
const username = z.string().regex(TELEGRAM_USERNAME_PATTERN);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const groupIds = z.array(z.string().regex(GROUP_ID_PATTERN)).max(TELEGRAM_ACCESS_GROUPS_MAX)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "duplicate group");

export const telegramAdminStateSchema = z.strictObject({
  enabled: z.boolean(),
  /** False opens Telegram to every active user; true only to members of `groupIds`. */
  restricted: z.boolean(),
  groupIds,
  tokenConfigured: z.boolean(),
  botUsername: username.nullable(),
  version,
  health: z.strictObject({
    lastPollAt: timestamp.nullable(),
    lastSuccessAt: timestamp.nullable(),
    lastFailureAt: timestamp.nullable(),
    lastFailureCode: telegramReasonCodeSchema.nullable()
  })
});
export type TelegramAdminState = z.infer<typeof telegramAdminStateSchema>;

const expectedVersion = version;
export const telegramAdminCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("test_and_save"),
    token: z.string().max(TELEGRAM_BOT_TOKEN_MAX_LENGTH).regex(TELEGRAM_BOT_TOKEN_PATTERN),
    expectedVersion
  }),
  z.strictObject({ action: z.literal("enable"), expectedVersion }),
  z.strictObject({ action: z.literal("disable"), expectedVersion }),
  z.strictObject({ action: z.literal("set_access"), restricted: z.boolean(), groupIds, expectedVersion })
]);
export type TelegramAdminCommand = z.infer<typeof telegramAdminCommandSchema>;

export const telegramUserStatusSchema = z.strictObject({
  /** False hides the Telegram block: the feature is off or not open to this user. */
  available: z.boolean(),
  state: z.enum(TELEGRAM_LINK_STATES),
  telegramUsername: username.optional(),
  linkedAt: timestamp.optional(),
  reasonCode: telegramReasonCodeSchema.optional()
});
export type TelegramUserStatus = z.infer<typeof telegramUserStatusSchema>;

export const telegramLinkCodeResponseSchema = z.strictObject({
  deepLink: z.string().max(200).regex(TELEGRAM_DEEP_LINK_PATTERN),
  expiresAt: timestamp
});
export type TelegramLinkCodeResponse = z.infer<typeof telegramLinkCodeResponseSchema>;

/** The administrator's view of one user's link; no Telegram ids. */
export const telegramAdminUserLinkSchema = z.strictObject({
  state: z.enum(TELEGRAM_LINK_STATES),
  telegramUsername: username.optional(),
  displayName: z.string().min(1).max(TELEGRAM_DISPLAY_NAME_MAX_LENGTH).optional(),
  linkedAt: timestamp.optional(),
  lastSeenAt: timestamp.optional(),
  reasonCode: telegramReasonCodeSchema.optional()
});
export type TelegramAdminUserLink = z.infer<typeof telegramAdminUserLinkSchema>;

function decoder<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

export const decodeTelegramAdminState = decoder(telegramAdminStateSchema);
export const decodeTelegramAdminCommand = decoder(telegramAdminCommandSchema);
export const decodeTelegramUserStatus = decoder(telegramUserStatusSchema);
export const decodeTelegramLinkCodeResponse = decoder(telegramLinkCodeResponseSchema);
export const decodeTelegramAdminUserLink = decoder(telegramAdminUserLinkSchema);

export function isTelegramReasonCode(value: unknown): value is TelegramReasonCode {
  return typeof value === "string" && (TELEGRAM_REASON_CODES as readonly string[]).includes(value);
}

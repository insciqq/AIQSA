import { z } from "zod";

/**
 * Discord Connect wires: the administrator's bot state and commands, the
 * server and channel choices, monitoring keys, the monitoring telemetry and
 * its problem rows, and the closed reason codes. The bot token and monitoring
 * key secrets are write-only: only the response that creates a monitoring key
 * carries its secret once, and no wire carries the token.
 */

/** Discord ids: unsigned 64-bit snowflakes as decimal strings. */
export const DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{1,20}$/u;
export const discordSnowflakeSchema = z.string().regex(DISCORD_SNOWFLAKE_PATTERN);

/** Bot tokens: three dot-separated base64url segments (id, timestamp, HMAC). */
export const DISCORD_BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{18,128}\.[A-Za-z0-9_-]{4,64}\.[A-Za-z0-9_-]{20,128}$/u;
export const DISCORD_BOT_TOKEN_MAX_LENGTH = 256;

/** GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, DIRECT_MESSAGES, DIRECT_MESSAGE_REACTIONS, MESSAGE_CONTENT. */
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15);

/** Every visible Discord refusal, interruption, setup or health reason. */
export const DISCORD_REASON_CODES = [
  "discord_assistant_missing",
  "discord_assistant_unavailable",
  "discord_busy",
  "discord_connect_address_invalid",
  "discord_context_unavailable",
  "discord_delivery_unknown",
  "discord_disabled",
  "discord_disconnected",
  "discord_failures_rising",
  "discord_gateway_refused",
  "discord_guild_missing",
  "discord_intents_disallowed",
  "discord_invalid_requests",
  "discord_key_limit",
  "discord_mcp_not_granted",
  "discord_mcp_too_many_tools",
  "discord_message_content_disabled",
  "discord_model_unavailable",
  "discord_monthly_budget",
  "discord_question_deleted",
  "discord_reply_expired",
  "discord_search_disabled",
  "discord_service_account_inactive",
  "discord_service_account_missing",
  "discord_session_limit",
  "discord_setup_incomplete",
  "discord_shared_key",
  "discord_stopped",
  "discord_thread_failed",
  "discord_thread_limit",
  "discord_token_missing",
  "discord_token_rejected",
  "discord_user_limit"
] as const;
export type DiscordReasonCode = (typeof DISCORD_REASON_CODES)[number];
export const discordReasonCodeSchema = z.enum(DISCORD_REASON_CODES);

/** The health reasons the bot state reports (PRD §10): admin status and attention. */
export const DISCORD_HEALTH_CODES = [
  "discord_connect_address_invalid", "discord_disconnected", "discord_gateway_refused", "discord_intents_disallowed",
  "discord_invalid_requests", "discord_session_limit", "discord_token_rejected"
] as const satisfies readonly DiscordReasonCode[];
export type DiscordHealthCode = (typeof DISCORD_HEALTH_CODES)[number];
export const discordHealthCodeSchema = z.enum(DISCORD_HEALTH_CODES);

/**
 * Setup check items (D-10), each with its own code; warnings never block
 * Enable. An item whose prerequisite failed is left out rather than shown as
 * passed. `discord_monthly_budget` warns that a monthly budget applies to the
 * service account (its own, a group's or the installation default): reaching
 * it stops every Discord thread at once (PRD D-12e). Per-user message limits
 * never apply to Discord runs, so they have no item.
 */
export const DISCORD_SETUP_CHECK_CODES = [
  "discord_token_missing", "discord_token_rejected", "discord_message_content_disabled", "discord_guild_missing",
  "discord_service_account_missing", "discord_service_account_inactive", "discord_assistant_missing",
  "discord_assistant_unavailable", "discord_model_unavailable", "discord_search_disabled", "discord_mcp_not_granted",
  "discord_mcp_too_many_tools", "discord_shared_key", "discord_monthly_budget"
] as const satisfies readonly DiscordReasonCode[];
export type DiscordSetupCheckCode = (typeof DISCORD_SETUP_CHECK_CODES)[number];

/** What the setup item's recovery button does in the Discord section. */
export const DISCORD_SETUP_ACTIONS = [
  "enter_token", "select_guild", "create_service_account", "open_service_account", "select_assistant",
  "open_assistant", "open_mcp_grants", "open_provider_keys", "open_usage_limits"
] as const;

export const DISCORD_CHANNEL_MODES = ["only_listed", "all_except"] as const;
export type DiscordChannelMode = (typeof DISCORD_CHANNEL_MODES)[number];
export const DISCORD_REPLY_STATES = ["claimed", "admitted", "delivered", "failed", "interrupted", "unknown"] as const;
export const DISCORD_REPLY_KINDS = ["answer", "follow_up", "refused"] as const;
export const DISCORD_LIMIT_KINDS = ["author", "thread", "key"] as const;
export const DISCORD_PROBLEM_KINDS = ["failed", "interrupted", "limit", "not_found", "rated_down", "slow"] as const;

export const DISCORD_CHANNELS_MAX = 200;
export const DISCORD_TEST_IDS_MAX = 10;
export const DISCORD_ACTIVITY_ROWS_MAX = 50;
export const DISCORD_MONITORING_KEYS_MAX = 5;
export const DISCORD_PROBLEM_ROWS_MAX = 500;
export const DISCORD_MONITORING_WINDOW_MAX_DAYS = 31;
/** The longest MCP server name the monitoring projection carries. */
export const DISCORD_MCP_SERVER_LABEL_MAX = 100;
/** Discord's own limit for guild, channel and thread names. */
export const DISCORD_NAME_MAX_LENGTH = 100;
export const DISCORD_LIMIT_DEFAULTS = Object.freeze({ perAuthorHourly: 20, perAuthorDaily: 100, perThreadHourly: 60, parallelThreads: 16 });

const timestamp = z.iso.datetime({ offset: false });
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const displayName = z.string().min(1).max(DISCORD_NAME_MAX_LENGTH);
/** AIQSA's own row ids (users, Assistants, chats, keys, MCP servers). */
const internalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const uniqueSnowflakes = (max: number) => z.array(discordSnowflakeSchema).max(max)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate id");
/** Discord bot usernames: 2–32 characters, no `@`, `#`, `:` or backticks. */
const botUsername = z.string().min(2).max(32).regex(/^[^@#:`\u0000-\u001f]+$/u);
/** A message link: `https://discord.com/channels/<guild or @me>/<channel>/<message>`. */
export const DISCORD_MESSAGE_LINK_PATTERN = /^https:\/\/discord\.com\/channels\/(?:[0-9]{1,20}|@me)\/[0-9]{1,20}\/[0-9]{1,20}$/u;
const messageLink = z.string().max(120).regex(DISCORD_MESSAGE_LINK_PATTERN);

export const discordLimitsSchema = z.strictObject({
  perAuthorHourly: z.number().int().min(1).max(1_000),
  perAuthorDaily: z.number().int().min(1).max(10_000),
  perThreadHourly: z.number().int().min(1).max(10_000),
  parallelThreads: z.number().int().min(1).max(64)
});
export type DiscordLimits = z.infer<typeof discordLimitsSchema>;

const latency = z.strictObject({ p50Ms: milliseconds.nullable(), p95Ms: milliseconds.nullable() });
const limitHits = z.strictObject({ author: count, thread: count, key: count });
const failuresByCode = z.array(z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u), count })).max(100);

export const discordActivityStatsSchema = z.strictObject({
  requests: count,
  delivered: count,
  failed: count,
  interrupted: count,
  failuresByCode,
  latency,
  limitHits,
  /** Delivered answers that cited no source. */
  notFound: count,
  ratingsUp: count,
  ratingsDown: count
});
export type DiscordActivityStats = z.infer<typeof discordActivityStatsSchema>;

/** One `DiscordReply` row for the admin's Activity list; never message text. */
export const discordActivityRowSchema = z.strictObject({
  questionMessageId: discordSnowflakeSchema,
  receivedAt: timestamp,
  guildId: discordSnowflakeSchema.nullable(),
  channelId: discordSnowflakeSchema,
  channelName: displayName.nullable(),
  authorId: discordSnowflakeSchema,
  /** A display snapshot taken when the question arrived; never logged. */
  authorName: displayName,
  kind: z.enum(DISCORD_REPLY_KINDS),
  state: z.enum(DISCORD_REPLY_STATES),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable(),
  latencyMs: milliseconds.nullable(),
  messageLink,
  test: z.boolean()
});
export type DiscordActivityRow = z.infer<typeof discordActivityRowSchema>;

export const discordMonitoringKeySchema = z.strictObject({
  id: internalId,
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable()
});
export type DiscordMonitoringKey = z.infer<typeof discordMonitoringKeySchema>;

export const discordSetupItemSchema = z.strictObject({
  code: z.enum(DISCORD_SETUP_CHECK_CODES),
  /** `ok` items are listed too, so the section shows what passed. */
  status: z.enum(["ok", "warning", "blocking"]),
  action: z.enum(DISCORD_SETUP_ACTIONS).nullable(),
  /** `discord_mcp_too_many_tools` when it fails: the MCP tools the Assistant's exact row loads into each request. */
  toolCount: z.number().int().nonnegative().optional()
});
export type DiscordSetupItem = z.infer<typeof discordSetupItemSchema>;

/** `GET /api/admin/discord/activity`: the 24 h and 7 d summaries and the latest rows (D-28). */
export const discordAdminActivitySchema = z.strictObject({
  last24h: discordActivityStatsSchema,
  last7d: discordActivityStatsSchema,
  rows: z.array(discordActivityRowSchema).max(DISCORD_ACTIVITY_ROWS_MAX)
});
export type DiscordAdminActivity = z.infer<typeof discordAdminActivitySchema>;

/** `GET /api/admin/discord/monitoring-keys` and the answer to a revoke: every key, never a secret. */
export const discordMonitoringKeyListSchema = z.strictObject({
  keys: z.array(discordMonitoringKeySchema).max(50)
});
export type DiscordMonitoringKeyList = z.infer<typeof discordMonitoringKeyListSchema>;

export const discordAdminStateSchema = z.strictObject({
  enabled: z.boolean(),
  tokenConfigured: z.boolean(),
  bot: z.strictObject({ userId: discordSnowflakeSchema, username: botUsername, applicationId: discordSnowflakeSchema }).nullable(),
  guild: z.strictObject({ id: discordSnowflakeSchema, name: displayName }).nullable(),
  channelMode: z.enum(DISCORD_CHANNEL_MODES),
  /** Ids are stored; names are fetched for display and null when Discord no longer shows the channel. */
  channels: z.array(z.strictObject({ id: discordSnowflakeSchema, name: displayName.nullable() })).max(DISCORD_CHANNELS_MAX),
  dmEnabled: z.boolean(),
  /** Bot authors whose messages count as a person's, only in `testChannelIds`; their runs are marked `test`. */
  testAuthorIds: uniqueSnowflakes(DISCORD_TEST_IDS_MAX),
  testChannelIds: uniqueSnowflakes(DISCORD_TEST_IDS_MAX),
  serviceAccount: z.strictObject({
    status: z.enum(["missing", "active", "inactive"]),
    userId: internalId.nullable()
  }),
  assistant: z.strictObject({ id: internalId, name: z.string().min(1).max(200) }).nullable(),
  limits: discordLimitsSchema,
  health: z.strictObject({
    connected: z.boolean(),
    lastConnectedAt: timestamp.nullable(),
    lastEventAt: timestamp.nullable(),
    lastFailureAt: timestamp.nullable(),
    lastFailureCode: discordReasonCodeSchema.nullable()
  }),
  setup: z.strictObject({
    ready: z.boolean(),
    items: z.array(discordSetupItemSchema).max(DISCORD_SETUP_CHECK_CODES.length)
  }),
  version
});
export type DiscordAdminState = z.infer<typeof discordAdminStateSchema>;

/** The servers the bot is in, for the Server choice. */
export const discordGuildOptionsSchema = z.strictObject({
  guilds: z.array(z.strictObject({ id: discordSnowflakeSchema, name: displayName })).max(200)
});
export type DiscordGuildOptions = z.infer<typeof discordGuildOptionsSchema>;

/** The chosen server's channels the bot can see, for the Channels choice. */
export const discordChannelOptionsSchema = z.strictObject({
  channels: z.array(z.strictObject({
    id: discordSnowflakeSchema,
    name: displayName,
    kind: z.enum(["text", "announcement", "forum", "media", "voice", "stage", "category", "other"]),
    parentId: discordSnowflakeSchema.nullable()
  })).max(500)
});
export type DiscordChannelOptions = z.infer<typeof discordChannelOptionsSchema>;

/** `GET /api/admin/discord/assistants`: the Assistants the service account can use, for the Assistant choice. */
export const discordAssistantOptionsSchema = z.strictObject({
  assistants: z.array(z.strictObject({ id: internalId, name: z.string().min(1).max(200) })).max(500)
});
export type DiscordAssistantOptions = z.infer<typeof discordAssistantOptionsSchema>;

const expectedVersion = version;
export const discordAdminCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("test_and_save"),
    token: z.string().max(DISCORD_BOT_TOKEN_MAX_LENGTH).regex(DISCORD_BOT_TOKEN_PATTERN),
    expectedVersion
  }),
  z.strictObject({ action: z.literal("set_guild"), guildId: discordSnowflakeSchema, expectedVersion }),
  z.strictObject({
    action: z.literal("set_channels"), channelMode: z.enum(DISCORD_CHANNEL_MODES),
    channelIds: uniqueSnowflakes(DISCORD_CHANNELS_MAX), expectedVersion
  }),
  z.strictObject({ action: z.literal("set_direct_messages"), dmEnabled: z.boolean(), expectedVersion }),
  z.strictObject({
    action: z.literal("set_test_access"), testAuthorIds: uniqueSnowflakes(DISCORD_TEST_IDS_MAX),
    testChannelIds: uniqueSnowflakes(DISCORD_TEST_IDS_MAX), expectedVersion
  }),
  z.strictObject({ action: z.literal("create_service_account"), expectedVersion }),
  z.strictObject({ action: z.literal("set_assistant"), assistantId: internalId, expectedVersion }),
  z.strictObject({ action: z.literal("set_limits"), limits: discordLimitsSchema, expectedVersion }),
  z.strictObject({ action: z.literal("enable"), expectedVersion }),
  z.strictObject({ action: z.literal("disable"), expectedVersion })
]);
export type DiscordAdminCommand = z.infer<typeof discordAdminCommandSchema>;

/** The only wire that carries a monitoring key's secret, once. */
export const discordMonitoringKeyCreatedSchema = z.strictObject({
  key: discordMonitoringKeySchema,
  secret: z.string().regex(/^aiqsa_dmk_[A-Za-z0-9_-]{32,64}$/u)
});
export type DiscordMonitoringKeyCreated = z.infer<typeof discordMonitoringKeyCreatedSchema>;

/** One problem request in the monitoring telemetry (D-34); ids and codes only. */
export const discordProblemRowSchema = z.strictObject({
  questionMessageId: discordSnowflakeSchema,
  kind: z.enum(DISCORD_PROBLEM_KINDS),
  receivedAt: timestamp,
  guildId: discordSnowflakeSchema.nullable(),
  channelId: discordSnowflakeSchema,
  messageLink,
  chatId: internalId.nullable(),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable(),
  latencyMs: milliseconds.nullable(),
  limitKind: z.enum(DISCORD_LIMIT_KINDS).nullable(),
  test: z.boolean()
});
export type DiscordProblemRow = z.infer<typeof discordProblemRowSchema>;

const stageLatency = z.strictObject({ acked: latency, admitted: latency, firstStatus: latency, delivered: latency });

/** `GET /api/monitoring/discord`: aggregates over one window of at most 31 days, no texts. */
export const discordMonitoringTelemetrySchema = z.strictObject({
  since: timestamp,
  until: timestamp,
  generatedAt: timestamp,
  requests: count,
  delivered: count,
  failed: count,
  interrupted: count,
  failuresByCode,
  limitHits,
  notFound: count,
  ratingsUp: count,
  ratingsDown: count,
  latency: stageLatency,
  /**
   * MCP calls and errors by installation server, named by the administrator's
   * display name, never its id; a server since deleted is `other`, a personal
   * one (a service account has none) `personal`.
   */
  mcpByServer: z.array(z.strictObject({ server: z.string().min(1).max(DISCORD_MCP_SERVER_LABEL_MAX), calls: count, errors: count })).max(200),
  compactions: count,
  subagents: count,
  problems: z.array(discordProblemRowSchema).max(DISCORD_PROBLEM_ROWS_MAX)
}).refine((value) => Date.parse(value.since) < Date.parse(value.until)
  && Date.parse(value.until) - Date.parse(value.since) <= DISCORD_MONITORING_WINDOW_MAX_DAYS * 86_400_000, "invalid window");
export type DiscordMonitoringTelemetry = z.infer<typeof discordMonitoringTelemetrySchema>;

function decoder<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

export const decodeDiscordAdminState = decoder(discordAdminStateSchema);
export const decodeDiscordAdminCommand = decoder(discordAdminCommandSchema);
export const decodeDiscordGuildOptions = decoder(discordGuildOptionsSchema);
export const decodeDiscordChannelOptions = decoder(discordChannelOptionsSchema);
export const decodeDiscordAssistantOptions = decoder(discordAssistantOptionsSchema);
export const decodeDiscordAdminActivity = decoder(discordAdminActivitySchema);
export const decodeDiscordMonitoringKeyList = decoder(discordMonitoringKeyListSchema);
export const decodeDiscordMonitoringKeyCreated = decoder(discordMonitoringKeyCreatedSchema);
export const decodeDiscordMonitoringTelemetry = decoder(discordMonitoringTelemetrySchema);

export function isDiscordReasonCode(value: unknown): value is DiscordReasonCode {
  return typeof value === "string" && (DISCORD_REASON_CODES as readonly string[]).includes(value);
}

export function discordMessageLink(guildId: string | null, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

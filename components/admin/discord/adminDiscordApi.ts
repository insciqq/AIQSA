import {
  decodeDiscordAdminActivity,
  decodeDiscordAdminState,
  decodeDiscordAssistantOptions,
  decodeDiscordChannelOptions,
  decodeDiscordGuildOptions,
  decodeDiscordMonitoringKeyCreated,
  decodeDiscordMonitoringKeyList,
  type DiscordAdminActivity,
  type DiscordAdminCommand,
  type DiscordAdminState,
  type DiscordAssistantOptions,
  type DiscordChannelOptions,
  type DiscordGuildOptions,
  type DiscordMonitoringKeyCreated,
  type DiscordMonitoringKeyList
} from "@/lib/contracts/discord";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminDiscordResult<T> =
  | Readonly<{ data: T; ok: true }>
  | Readonly<{ error: string; ok: false }>;

/** The bot-state route's stale-version refusal: another administrator changed it after this page read it. */
export const ADMIN_DISCORD_STALE = "discord_control_stale";
export const ADMIN_DISCORD_NOT_FOUND = "not_found";

export const ADMIN_DISCORD_PATH = "/api/admin/discord";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorFrom(response: Response, value: unknown, fallback: string): string {
  if (response.status === 404) return ADMIN_DISCORD_NOT_FOUND;
  const code = isRecord(value) && typeof value.error === "string" && value.error.trim() ? value.error.trim() : "";
  // Other 409s (setup incomplete, unreadable token) are actionable refusals, not a stale page.
  if (response.status === 409) return code || ADMIN_DISCORD_STALE;
  return code || fallback;
}

async function request<T>(
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminDiscordResult<T>> {
  try {
    const response = await fetcher(path, { cache: "no-store", credentials: "same-origin", ...init });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) return { error: errorFrom(response, value, "discord_admin_action_failed"), ok: false };
    const decoded = decode(value);
    return decoded ? { data: decoded, ok: true } : { error: "discord_admin_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

const get = (signal?: AbortSignal): RequestInit => ({ method: "GET", ...(signal ? { signal } : {}) });

/** The bot state: on/off, choices, setup check and session health; never the token. */
export function requestAdminDiscord(fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request<DiscordAdminState>(ADMIN_DISCORD_PATH, get(signal), decodeDiscordAdminState, fetcher);
}

/** One command with the version the page last read; a stale version answers `discord_control_stale`. */
export function runAdminDiscordCommand(command: DiscordAdminCommand, fetcher: Fetcher = fetch) {
  return request<DiscordAdminState>(ADMIN_DISCORD_PATH, {
    body: JSON.stringify(command),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, decodeDiscordAdminState, fetcher);
}

/** The servers the bot is in. */
export function requestDiscordGuilds(fetcher: Fetcher = fetch) {
  return request<DiscordGuildOptions>(`${ADMIN_DISCORD_PATH}/guilds`, get(), decodeDiscordGuildOptions, fetcher);
}

/** One server's channels the bot can see; names are for display only. */
export function requestDiscordChannels(guildId: string, fetcher: Fetcher = fetch) {
  return request<DiscordChannelOptions>(
    `${ADMIN_DISCORD_PATH}/channels?guildId=${encodeURIComponent(guildId)}`,
    get(),
    decodeDiscordChannelOptions,
    fetcher
  );
}

/** The Assistants the service account can use. */
export function requestDiscordAssistants(fetcher: Fetcher = fetch) {
  return request<DiscordAssistantOptions>(`${ADMIN_DISCORD_PATH}/assistants`, get(), decodeDiscordAssistantOptions, fetcher);
}

export function requestDiscordActivity(fetcher: Fetcher = fetch) {
  return request<DiscordAdminActivity>(`${ADMIN_DISCORD_PATH}/activity`, get(), decodeDiscordAdminActivity, fetcher);
}

export function requestDiscordMonitoringKeys(fetcher: Fetcher = fetch) {
  return request<DiscordMonitoringKeyList>(`${ADMIN_DISCORD_PATH}/monitoring-keys`, get(), decodeDiscordMonitoringKeyList, fetcher);
}

/** The only answer that carries the key's secret; the page shows it once and never stores it. */
export function createDiscordMonitoringKey(fetcher: Fetcher = fetch) {
  return request<DiscordMonitoringKeyCreated>(
    `${ADMIN_DISCORD_PATH}/monitoring-keys`,
    { method: "POST" },
    decodeDiscordMonitoringKeyCreated,
    fetcher
  );
}

/** Revokes one key; the answer is the key list after revocation. */
export function revokeDiscordMonitoringKey(keyId: string, fetcher: Fetcher = fetch) {
  return request<DiscordMonitoringKeyList>(
    `${ADMIN_DISCORD_PATH}/monitoring-keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
    decodeDiscordMonitoringKeyList,
    fetcher
  );
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  discord_connect_address_invalid: "The Discord connect address in the installation's environment is not valid. " +
    "Fix AIQSA_DISCORD_CONNECT_ADDRESS and restart AIQSA.",
  discord_disconnected: "AIQSA lost its connection to Discord and is reconnecting.",
  discord_gateway_refused: "Discord refused the connection. AIQSA retries on its own; if this persists, check the bot in the Discord Developer Portal.",
  discord_intents_disallowed: "Discord refused the Message Content intent. Turn on Message Content Intent under Bot → " +
    "Privileged Gateway Intents in the Discord Developer Portal, then use Test & Save.",
  discord_invalid_requests: "Discord paused the bot after too many invalid requests. AIQSA resumes when the pause ends.",
  discord_message_content_disabled: "Message Content Intent is off for this bot. Turn it on under Bot → Privileged Gateway " +
    "Intents in the Discord Developer Portal, then use Test & Save.",
  discord_session_limit: "The bot has used up its daily Discord connection budget. AIQSA connects again when Discord resets it.",
  discord_setup_incomplete: "The setup checklist below has unfinished items. Complete them, then enable the bot.",
  discord_token_missing: "Save a bot token with Test & Save first.",
  discord_token_rejected: "Discord rejected the bot token. Reset the token in the Discord Developer Portal and use Test & Save."
};

/** The administrator's text for a session-health or Test & Save reason code. */
export function adminDiscordReasonMessage(code: string): string {
  return REASON_MESSAGES[code] ?? "Discord reported a problem with this bot.";
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [ADMIN_DISCORD_STALE]: "Another administrator changed the Discord settings. Reload to see them; your unsaved input here is kept.",
  [ADMIN_DISCORD_NOT_FOUND]: "This Discord item no longer exists. Reload and try again.",
  discord_admin_action_failed: "The Discord action could not be completed.",
  discord_admin_response_invalid: "The Discord API returned an unexpected response. Reload and try again.",
  discord_assistant_unavailable: "The service account cannot use this Assistant. Share it with the service account or one of its groups.",
  discord_encryption_unavailable: "AIQSA cannot store the token: the installation's encryption key is not configured.",
  discord_guild_missing: "The bot is not in this server. Invite the bot to the server first.",
  discord_monitoring_key_limit: "This installation already has the most monitoring keys allowed. Revoke one you no longer use.",
  discord_service_account_missing: "Create the service account first.",
  discord_token_unreadable: "The stored token cannot be read with this installation's encryption key. Paste the token again and use Test & Save.",
  discord_unreachable: "AIQSA cannot reach Discord. Check the server's outbound network and try again.",
  forbidden: "Your account no longer has permission to manage Discord.",
  network_error: "Could not reach the Discord administration API.",
  unauthorized: "Your administrator session is no longer valid. Sign in again."
};

export function adminDiscordErrorMessage(code: string): string {
  return REASON_MESSAGES[code] ?? ERROR_MESSAGES[code] ?? "The Discord action could not be completed.";
}

import {
  decodeTelegramAdminState,
  decodeTelegramAdminUserLink,
  type TelegramAdminCommand,
  type TelegramAdminState,
  type TelegramAdminUserLink
} from "@/lib/contracts/telegram";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminTelegramResult<T> =
  | Readonly<{ data: T; ok: true }>
  | Readonly<{ error: string; ok: false }>;

/** The bot-state route's stale-version refusal: another administrator changed it after this page read it. */
export const ADMIN_TELEGRAM_STALE = "telegram_control_stale";
export const ADMIN_TELEGRAM_NOT_FOUND = "not_found";

const ADMIN_TELEGRAM_PATH = "/api/admin/telegram";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorFrom(response: Response, value: unknown, fallback: string): string {
  if (response.status === 404) return ADMIN_TELEGRAM_NOT_FOUND;
  const code = isRecord(value) && typeof value.error === "string" && value.error.trim() ? value.error.trim() : "";
  // Other 409s (no stored token, unreadable token) are actionable refusals, not a stale page.
  if (response.status === 409) return code || ADMIN_TELEGRAM_STALE;
  return code || fallback;
}

async function request<T>(
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminTelegramResult<T>> {
  try {
    const response = await fetcher(path, { cache: "no-store", credentials: "same-origin", ...init });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) return { error: errorFrom(response, value, "telegram_admin_action_failed"), ok: false };
    const decoded = decode(value);
    return decoded ? { data: decoded, ok: true } : { error: "telegram_admin_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

function userPath(userId: string): string {
  return `${ADMIN_TELEGRAM_PATH}/users/${encodeURIComponent(userId)}`;
}

/** The bot state: on/off, access, whether a token is stored (never the token), the bot's username and poll health. */
export function requestAdminTelegram(fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request<TelegramAdminState>(ADMIN_TELEGRAM_PATH, { method: "GET", ...(signal ? { signal } : {}) }, decodeTelegramAdminState, fetcher);
}

/** One command with the version the page last read; a stale version answers `telegram_control_stale`. */
export function runAdminTelegramCommand(command: TelegramAdminCommand, fetcher: Fetcher = fetch) {
  return request<TelegramAdminState>(ADMIN_TELEGRAM_PATH, {
    body: JSON.stringify(command),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, decodeTelegramAdminState, fetcher);
}

/** One user's link as the administrator sees it; an invisible or missing user answers `not_found`. */
export function requestAdminUserTelegram(userId: string, fetcher: Fetcher = fetch) {
  return request<TelegramAdminUserLink>(userPath(userId), { method: "GET" }, decodeTelegramAdminUserLink, fetcher);
}

/** Removes the user's link; the answer is the link state after removal. */
export function unlinkAdminUserTelegram(userId: string, fetcher: Fetcher = fetch) {
  return request<TelegramAdminUserLink>(userPath(userId), { method: "DELETE" }, decodeTelegramAdminUserLink, fetcher);
}

const HEALTH_MESSAGES: Readonly<Record<string, string>> = {
  telegram_poll_conflict: "Another program is reading this bot's updates. A second AIQSA instance during a restart or deploy " +
    "causes this briefly; if it persists, stop the other program or create a new token in @BotFather and use Test & Save.",
  telegram_token_rejected: "Telegram rejected the bot token. Create a new token in @BotFather and use Test & Save.",
  telegram_unreachable: "AIQSA cannot reach Telegram. Check the server's outbound network and try again."
};

/** The administrator's text for a poll-health or Test & Save reason code. */
export function adminTelegramReasonMessage(code: string): string {
  return HEALTH_MESSAGES[code] ?? "Telegram reported a problem with this bot.";
}

export function adminTelegramErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    [ADMIN_TELEGRAM_STALE]: "Telegram settings changed elsewhere. The page was refreshed; review and try again.",
    forbidden: "Your account no longer has permission to manage Telegram.",
    network_error: "Could not reach the Telegram administration API.",
    telegram_admin_action_failed: "The Telegram action could not be completed.",
    telegram_access_groups_invalid: "Choose groups that exist and are not archived.",
    telegram_admin_response_invalid: "The Telegram API returned an unexpected response. Refresh and try again.",
    telegram_encryption_unavailable: "AIQSA cannot store the token: the installation's encryption key is not configured.",
    telegram_token_missing: "Save a bot token with Test & Save before turning Telegram on.",
    telegram_token_unreadable: "The stored token cannot be read with this installation's encryption key. Paste the token again and use Test & Save.",
    unauthorized: "Your administrator session is no longer valid. Sign in again.",
    ...HEALTH_MESSAGES
  };
  return messages[code] ?? "The Telegram action could not be completed.";
}

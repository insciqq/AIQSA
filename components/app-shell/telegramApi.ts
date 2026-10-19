import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeTelegramLinkCodeResponse,
  decodeTelegramUserStatus,
  type TelegramLinkCodeResponse,
  type TelegramUserStatus
} from "@/lib/contracts/telegram";

export const TELEGRAM_STATUS_PATH = "/api/me/telegram";
export const TELEGRAM_LINK_CODE_PATH = "/api/me/telegram/link-code";
/** The link-code limit (5 per 10 minutes) answers with this. */
export const TELEGRAM_LINK_RATE_LIMITED = "telegram_link_rate_limited";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(response: Response, value: unknown): string {
  if (response.status === 429) return TELEGRAM_LINK_RATE_LIMITED;
  return isRecord(value) && typeof value.error === "string" && value.error.trim()
    ? value.error.trim()
    : "telegram_request_failed";
}

export class TelegramApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "TelegramApiError";
  }
}

async function call<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null): Promise<T> {
  const response = await shellFetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...init.headers }
  });
  const body = await responseJson(response);
  if (!response.ok) throw new TelegramApiError(errorCode(response, body), response.status);
  const decoded = decode(body);
  if (!decoded) throw new TelegramApiError("telegram_response_invalid", 502);
  return decoded;
}

/** The signed-in user's Telegram link status. */
export function loadTelegramStatus(signal?: AbortSignal): Promise<TelegramUserStatus> {
  return call(TELEGRAM_STATUS_PATH, { method: "GET", ...(signal ? { signal } : {}) }, decodeTelegramUserStatus);
}

/** A one-time `t.me/<bot>?start=<code>` link for this user and session. */
export function requestTelegramLinkCode(signal?: AbortSignal): Promise<TelegramLinkCodeResponse> {
  return call(TELEGRAM_LINK_CODE_PATH, { method: "POST", ...(signal ? { signal } : {}) }, decodeTelegramLinkCodeResponse);
}

/** Removes the user's link; the answer is the status after removal. */
export function disconnectTelegram(signal?: AbortSignal): Promise<TelegramUserStatus> {
  return call(TELEGRAM_STATUS_PATH, { method: "DELETE", ...(signal ? { signal } : {}) }, decodeTelegramUserStatus);
}

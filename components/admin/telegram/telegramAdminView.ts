import { adminTelegramReasonMessage } from "@/components/admin/telegram/adminTelegramApi";
import { TELEGRAM_BOT_TOKEN_MAX_LENGTH, TELEGRAM_BOT_TOKEN_PATTERN, type TelegramAdminState } from "@/lib/contracts/telegram";

export type TelegramBotStatus = Readonly<{
  /** The one-line state under the status word, e.g. "Polling · last update 5 s ago". */
  detail: string;
  label: string;
  tone: "critical" | "neutral" | "ok";
}>;

function timeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "5 s ago", "3 min ago", "2 h ago" or the date for anything older than a day. */
export function telegramRelativeTime(value: string, nowMs: number): string {
  const at = timeMs(value);
  if (at === null) return "at an unknown time";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at))}`;
}

/** The latest health fact wins: a failure newer than the last successful poll is the current state. */
export function telegramBotStatus(state: TelegramAdminState, nowMs: number): TelegramBotStatus {
  if (!state.tokenConfigured) {
    return { detail: "Paste a bot token below and use Test & Save.", label: "Not set up", tone: "neutral" };
  }
  if (!state.enabled) {
    return { detail: "Users cannot connect Telegram or chat with the bot until you enable it.", label: "Off", tone: "neutral" };
  }
  const { lastFailureAt, lastFailureCode, lastSuccessAt } = state.health;
  const failureMs = timeMs(lastFailureAt);
  const successMs = timeMs(lastSuccessAt);
  if (lastFailureCode && failureMs !== null && (successMs === null || failureMs >= successMs)) {
    return {
      detail: `${adminTelegramReasonMessage(lastFailureCode)} Last failure ${telegramRelativeTime(lastFailureAt!, nowMs)}.`,
      label: "Attention",
      tone: "critical"
    };
  }
  if (lastSuccessAt) {
    return { detail: `Polling · last update ${telegramRelativeTime(lastSuccessAt, nowMs)}`, label: "On", tone: "ok" };
  }
  return { detail: "Polling · waiting for the first update", label: "On", tone: "ok" };
}

/** Local check before the token leaves the browser; the server repeats it and asks Telegram. */
export function telegramTokenError(token: string): string | null {
  const value = token.trim();
  if (!value) return "Paste the bot token from @BotFather.";
  if (value.length > TELEGRAM_BOT_TOKEN_MAX_LENGTH || !TELEGRAM_BOT_TOKEN_PATTERN.test(value)) {
    return "This is not a bot token. It looks like 123456789:AAE… with the bot id, a colon and the secret part.";
  }
  return null;
}

export type TelegramAccessDraft = Readonly<{ groupIds: readonly string[]; restricted: boolean }>;

export function telegramAccessDirty(draft: TelegramAccessDraft, state: TelegramAdminState): boolean {
  if (draft.restricted !== state.restricted) return true;
  if (!draft.restricted) return false;
  const stored = new Set(state.groupIds.map((id) => id.toLowerCase()));
  return draft.groupIds.length !== stored.size || draft.groupIds.some((id) => !stored.has(id.toLowerCase()));
}

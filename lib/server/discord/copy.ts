import type { DiscordReasonCode } from "../../contracts/discord";

/**
 * Every text the Discord bot posts (PRD §5, §10): English, short and fixed.
 * Model answers keep the question's language; these never pass through a
 * model and carry no user content except the numbers they are given.
 */

export const DISCORD_COPY = Object.freeze({
  openInAiqsa: "Open in AIQSA",
  stopped: "Stopped",
  busy: "AIQSA is busy, try again in a minute.",
  notSetUp: "Discord answers are not set up on this AIQSA yet.",
  contextUnavailable: "I can't read this thread's history. Ask an admin to give the bot Read Message History here.",
  usageLimit: "AIQSA usage limit reached. Ask your AIQSA administrator.",
  keyLimit: "The Discord model key has reached its daily limit.",
  somethingWrong: "Something went wrong. Ask again.",
  sharedKeyWarning: "Discord runs use the shared key",
  historyAttachmentName: "discord-history.md"
});

/** The status line while a run works: `Working · 0:12 — Searching the web`. */
export function discordWorkingStatus(elapsedMs: number, activity?: string): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const label = activity?.trim().slice(0, 100);
  return label ? `Working · ${clock} — ${label}` : `Working · ${clock}`;
}

/** A failed answer's status: `❌ <reason>`. */
export function discordFailureStatus(reason: string): string {
  return `❌ ${reason}`;
}

export function discordAuthorLimitText(perHour: number, retryInMinutes: number): string {
  return `You've reached the limit of ${perHour} questions per hour. Try again in ${Math.max(1, retryInMinutes)} min.`;
}

export function discordAuthorDailyLimitText(perDay: number): string {
  return `You've reached the limit of ${perDay} questions per day. Try again tomorrow.`;
}

export function discordThreadLimitText(perHour: number, retryInMinutes: number): string {
  return `This thread has reached its limit of ${perHour} questions per hour. Try again in ${Math.max(1, retryInMinutes)} min.`;
}

export function discordFilesOnlyInAiqsaText(count: number): string {
  return count === 1 ? "1 file is only in AIQSA" : `${count} files are only in AIQSA`;
}

export function discordEarlierMessagesText(count: number): string {
  return `${count} earlier messages are in the attached file`;
}

export function discordOmittedMessagesText(count: number): string {
  return `${count} earlier messages omitted`;
}

/** A thread name for a question with no usable text. */
export function discordQuestionFallbackThreadName(authorName: string): string {
  return `Question from ${authorName}`.slice(0, 80);
}

/**
 * The visible reason of a refusal code that people in Discord see, or `null`
 * for codes that stay silent there (the kill switch, unknown delivery) or
 * whose text needs numbers (limits) or is the administrator's only.
 */
export function discordReasonText(code: DiscordReasonCode): string | null {
  switch (code) {
    case "discord_busy": return DISCORD_COPY.busy;
    case "discord_setup_incomplete":
    case "discord_service_account_missing":
    case "discord_service_account_inactive":
    case "discord_assistant_missing":
    case "discord_assistant_unavailable":
    case "discord_model_unavailable":
    case "discord_mcp_not_granted":
    case "discord_search_disabled":
    case "discord_guild_missing":
    case "discord_token_missing":
    case "discord_message_content_disabled":
      return DISCORD_COPY.notSetUp;
    case "discord_context_unavailable": return DISCORD_COPY.contextUnavailable;
    case "discord_key_limit": return DISCORD_COPY.keyLimit;
    case "discord_reply_expired": return DISCORD_COPY.somethingWrong;
    case "discord_stopped":
    case "discord_question_deleted":
      return DISCORD_COPY.stopped;
    default: return null;
  }
}

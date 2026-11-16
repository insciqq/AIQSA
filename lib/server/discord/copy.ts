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

/** The bridge's own texts (PRD D-19, §10): status activities and the short reasons of refused or failed answers. */
export const DISCORD_BRIDGE_COPY = Object.freeze({
  activityThinking: "Thinking",
  activityWriting: "Writing the answer",
  activitySearching: "Searching the web",
  activityReading: "Reading a web page",
  activityFindingTools: "Looking for tools",
  activitySkill: "Reading a Skill",
  activityImage: "Generating an image",
  activitySubagent: "Working with a sub-agent",
  activityCompacting: "Compacting the conversation",
  activityTool: "Using a tool",
  modelUnavailable: "The model for Discord answers is unavailable right now. Ask your AIQSA administrator.",
  toolsUnavailable: "A tool this answer needs is unavailable right now. Try again later.",
  contextTooLarge: "This conversation is too long to answer here. Start a new thread.",
  attachmentUnavailable: "An attachment of this question could not be read.",
  tooLong: "This question is too long. Shorten it and ask again."
});

/** An MCP server at work, by its display name (redacted and escaped by the status formatter). */
export function discordUsingServerText(serverName: string): string {
  return `Using ${serverName}`;
}

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

/** Why an attachment of the turn went to the model only by name (lines of the run's context, not posted in Discord). */
export const DISCORD_ATTACHMENT_COPY = Object.freeze({
  tooLarge: "too large",
  unsupported: "file type not supported",
  overLimit: "over this turn's attachment limit",
  unreadable: "could not be downloaded",
  uploadRefused: "upload refused:"
});

/** `Attachments not added (too large): a.zip, b.mov`, with how many more when the list is cut. */
export function discordAttachmentsNotAddedText(reason: string, names: readonly string[], count: number): string {
  const more = count > names.length ? ` and ${count - names.length} more` : "";
  return `Attachments not added (${reason}): ${names.join(", ")}${more}`;
}

export function discordEarlierAttachmentsNamedText(count: number): string {
  return count === 1 ? "1 attachment of earlier messages is only named." : `${count} attachments of earlier messages are only named.`;
}

export function discordEarlierMessagesText(count: number): string {
  return `${count} earlier messages are in the attached file`;
}

export function discordOmittedMessagesText(count: number): string {
  return `${count} earlier messages omitted`;
}

/** Earlier messages past the read bound, whose number was not counted. */
export const DISCORD_EARLIER_MESSAGES_OMITTED = "Earlier messages omitted";

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
    case "discord_mcp_too_many_tools":
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

/** Voice messages (`voice.ts`): why one stayed without its text, as the run reads it and as the bot's refusal says it. */
export const DISCORD_VOICE_COPY = Object.freeze({
  unavailable: {
    line: "speech to text is not set up or unavailable",
    reply: "I can't transcribe voice messages: speech to text is not set up on this AIQSA. Ask your AIQSA administrator, or write your question."
  },
  too_long: {
    line: "longer than 10 minutes",
    reply: "This voice message is longer than 10 minutes, too long to transcribe. Send a shorter one or write your question."
  },
  rate_limited: { line: "too many voice messages from this author", reply: "You've sent too many voice messages." },
  usage_limit: { line: "usage limit reached", reply: "AIQSA usage limit reached. Ask your AIQSA administrator." },
  unreadable: { line: "the audio could not be downloaded", reply: "I couldn't download this voice message. Send it again." },
  no_speech: { line: "no speech recognised", reply: "I couldn't hear any speech in this voice message." },
  failed: { line: "transcription failed", reply: "I couldn't transcribe this voice message. Try again, or write your question." }
} as const);

/** The run's line before a voice message's transcript. */
export function discordVoiceTranscriptLabel(author: string): string {
  return `[Transcript of a voice message from ${author}]`;
}

/** The run's line for a voice message that stayed without its text. */
export function discordVoiceUntranscribedText(author: string, reason: string): string {
  return `[A voice message from ${author} could not be transcribed: ${reason}]`;
}

/** The bot's refusal of a question that is only a voice message too many: when to try again. */
export function discordVoiceRateLimitedText(retryInMinutes: number): string {
  return `${DISCORD_VOICE_COPY.rate_limited.reply} Try again in ${Math.max(1, retryInMinutes)} min.`;
}

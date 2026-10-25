import type { TelegramReasonCode } from "../../contracts/telegram";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { TelegramBotCommand } from "./botApi";

/**
 * Every fixed text the bot sends. English and short, like the product
 * interface; model answers keep the user's language. Interpolated names are
 * cut to a bounded length; callers pass display values, never ids.
 */

const NAME_MAX_LENGTH = 128;
const ACTIVITY_MAX_LENGTH = 200;

function bounded(value: string, max = NAME_MAX_LENGTH): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Registered with `setMyCommands` when the bot is enabled; `/start` stays unlisted. */
export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "new", description: "Start a new chat" },
  { command: "chats", description: "Continue one of your recent chats" },
  { command: "assistant", description: "Start a chat with an assistant" },
  { command: "model", description: "Choose the model for your messages" },
  { command: "settings", description: "Search, Workspace and model" },
  { command: "stop", description: "Stop the running reply" },
  { command: "help", description: "List the commands" },
  { command: "unlink", description: "Disconnect Telegram from AIQSA" }
];

export const TELEGRAM_COPY = {
  notLinked: "This bot works for users of this AIQSA. Open AIQSA → Settings → Connections → Connect Telegram.",
  disconnected: "This Telegram account was disconnected from AIQSA.",
  help: ["Send a message to chat with AIQSA.", ...TELEGRAM_BOT_COMMANDS.map(({ command, description }) => `/${command} — ${description}`)]
    .join("\n"),
  newChat: "New chat",
  followupAdded: "Added to the running reply.",
  replyRunning: "A reply is already running in this chat.",
  editsNotApplied: "Edits aren't applied. Send a new message.",
  stopped: "Stopped",
  buttonExpired: "This button has expired",
  buttonFailed: "Something went wrong. Try again.",
  allowOnce: "Allow once",
  deny: "Deny",
  allowedOnce: "Allowed once",
  denied: "Denied",
  approvalExpired: "This approval expired. Ask again.",
  stop: "Stop",
  unlinkConfirm: "Disconnect",
  unlinkQuestion: "Disconnect this Telegram account from AIQSA?",
  openSettings: "Open settings"
} as const;

/** Texts of the chat bridge: commands, menus, routing notices and how an answer ended. */
export const TELEGRAM_BRIDGE_COPY = {
  chooseModel: "Choose a model",
  staleMessage: "This message arrived while the bot was offline. Send it again to get an answer.",
  nothingRunning: "Nothing is running.",
  unknownCommand: "Unknown command. /help lists commands.",
  chatsTitle: "Choose a chat to continue:",
  noChats: "No chats yet. Send a message to start one.",
  assistantsTitle: "Choose an assistant. Your next message starts a chat with it:",
  noAssistants: "No assistants are available to you.",
  modelsTitle: "Choose the model for your messages:",
  noModels: "No models are available to you. Ask your AIQSA administrator.",
  settingsTitle: "Settings for your messages from Telegram:",
  previousPage: "‹ Back",
  nextPage: "More ›",
  replyChatUnavailable: "That chat isn't available anymore, so this goes to your current chat.",
  currentChatUnavailable: "Your current chat isn't available anymore, so this starts a new chat.",
  chatUnavailable: "That chat isn't available anymore.",
  assistantUnavailable: "That assistant isn't available anymore.",
  modelUnavailable: "That model isn't available anymore.",
  answerInAiqsa: "The answer is in AIQSA.",
  answerFailed: "The answer couldn't be completed. Open it in AIQSA for details."
} as const;

/** A failed answer: the reason AIQSA shows for it in the chat, bounded, or the generic text. */
export function telegramAnswerFailedText(reason: string | null | undefined): string {
  const detail = reason ? bounded(reason, 300) : "";
  return detail ? `The answer couldn't be completed: ${detail.replace(/[.!]$/u, "")}.` : TELEGRAM_BRIDGE_COPY.answerFailed;
}

/**
 * Why AIQSA did not start an answer, by family of the send handler's refusal
 * codes, each naming what to do next (`/model`, `/settings`, `/new` or AIQSA).
 */
export const TELEGRAM_RUN_REFUSAL_COPY = {
  replyRunning: `${TELEGRAM_COPY.replyRunning} Wait for it or stop it in AIQSA.`,
  usageUnavailable: "Usage limits could not be checked. Try again in a moment.",
  modelUnavailable: "This model isn't available to you now. Choose another with /model.",
  noModel: "No model is available to you. Ask your AIQSA administrator.",
  searchUnavailable: "Search isn't available for this model now. Turn Search off in /settings or choose another model with /model.",
  workspaceDisabled: "Workspace is off on this AIQSA. Turn Workspace off in /settings.",
  workspaceModel: "This model can't use Workspace. Choose another with /model or turn Workspace off in /settings.",
  workspaceUnavailable: "Workspace can't take this message now. Try again, or turn Workspace off in /settings.",
  toolsUnavailable: "A connected tool this chat uses isn't ready. Review your connections in AIQSA.",
  skillUnavailable: "A Skill this chat uses isn't available. Review your Skills in AIQSA.",
  assistantUnavailable: "This assistant isn't available now. Start a new chat with /new or choose another with /assistant.",
  chatUnavailable: "This chat isn't available anymore. Your next message starts a new chat.",
  attachmentUnavailable: "An attachment couldn't be used. Open AIQSA to check it.",
  contextTooLarge: "This chat is too long to continue here. Start a new chat with /new.",
  tooLong: "This message is too long. Shorten it and send it again.",
  generic: "AIQSA couldn't answer this message. Try again, or open AIQSA."
} as const;

function waitText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 60) return "in a minute";
  const waitMinutes = Math.ceil(seconds / 60);
  if (waitMinutes < 60) return `in ${waitMinutes} min`;
  const hours = Math.round(waitMinutes / 60);
  if (hours < 48) return `in about ${hours} h`;
  return `in about ${Math.round(hours / 24)} days`;
}

/**
 * A usage limit refusal (`429`): which limit, never the shared installation
 * amounts, and when sending works again from `retry-after`.
 */
export function telegramUsageLimitText(input: Readonly<{
  code: string; limit?: number | null; retryAfterSeconds?: number | null; window?: string | null;
}>): string {
  const when = waitText(input.retryAfterSeconds);
  switch (input.code) {
    case "installation_budget_exhausted":
      return `The monthly budget shared by everyone is used up. You can send messages again ${when}, or sooner if an administrator raises it.`;
    case "usage_budget_exhausted":
      return input.limit === 0
        ? "Your monthly budget is $0.00, so you can't send messages. An administrator can raise it."
        : `Your monthly budget is used up. You can send messages again ${when}.`;
    default: {
      const window = input.window === "day" ? "day" : "hour";
      if (input.limit === 0) return `Your limit is 0 messages per ${window}, so you can't send messages. An administrator can raise it.`;
      const reached = typeof input.limit === "number"
        ? `your limit of ${input.limit} ${input.limit === 1 ? "message" : "messages"} per ${window}`
        : "your message limit";
      return `You've reached ${reached}. You can send again ${when}.`;
    }
  }
}

export function telegramConnectedText(name: string): string {
  return `Connected to AIQSA as ${bounded(name)}. Send a message to start a new chat. /help lists commands.`;
}

export function telegramCurrentChatText(title: string): string {
  return `Current chat: ${bounded(title)}`;
}

export function telegramAssistantSelectedText(assistantName: string): string {
  return `Next message starts a chat with ${bounded(assistantName)}`;
}

export function telegramToggleLabel(name: "Search" | "Workspace", enabled: boolean): string {
  return `${name}: ${enabled ? "on" : "off"}`;
}

export function telegramModelLabel(modelName: string): string {
  return `Model: ${bounded(modelName)}`;
}

function minutes(elapsedMs: number): number {
  return Math.max(1, Math.round(elapsedMs / 60_000));
}

export function telegramWorkFinishedText(elapsedMs: number): string {
  return `Finished in ${minutes(elapsedMs)} min`;
}

/** The status of a run that works in Workspace. */
export function telegramWorkspaceWorkingText(elapsedMs: number, activity?: string): string {
  const head = `Working in Workspace · ${minutes(elapsedMs)} min`;
  const detail = activity ? bounded(activity, ACTIVITY_MAX_LENGTH) : "";
  return detail ? `${head} — ${detail}` : head;
}

/** The status of a Workspace run that ended with an error; the answer message says why. */
export function telegramWorkFailedText(elapsedMs: number): string {
  return `Failed after ${minutes(elapsedMs)} min`;
}

const ACTIVITY_TARGET_MAX_LENGTH = 120;

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * One Workspace step as the status names it, from the activity the
 * run already projected (redacted, bounded): what runs, is read or written,
 * or which tool is called. Null for lifecycle steps not worth a status line.
 */
export function telegramWorkActivityText(entry: ThreadWorkspaceActivityEntry): string | null {
  const active = entry.phase === "requested" || entry.phase === "running";
  const failed = entry.phase === "failed";
  const pick = (running: string, done: string, failure: string) => active ? running : failed ? failure : done;
  const target = (value: string | undefined, fallback: string) => bounded(value || fallback, ACTIVITY_TARGET_MAX_LENGTH) || fallback;
  const path = target(entry.file?.displayPath, "a file");
  switch (entry.kind) {
    case "command": {
      const command = target(entry.command?.preview, "a command");
      return pick(`Running ${command}`, `Ran ${command}`, `${command} failed`);
    }
    case "file_read": return pick(`Reading ${path}`, `Read ${path}`, `Couldn't read ${path}`);
    case "file_write": return pick(`Writing ${path}`, `Wrote ${path}`, `Couldn't write ${path}`);
    case "file_list": return pick(`Listing ${path}`, `Listed ${path}`, `Couldn't list ${path}`);
    case "file_copy": return pick(`Copying ${path}`, `Copied ${path}`, `Couldn't copy ${path}`);
    case "file_move": return pick(`Moving ${path}`, `Moved ${path}`, `Couldn't move ${path}`);
    case "file_remove": return pick(`Removing ${path}`, `Removed ${path}`, `Couldn't remove ${path}`);
    case "folder_create": return pick(`Creating folder ${path}`, `Created folder ${path}`, `Couldn't create folder ${path}`);
    case "file_check": return pick(`Checking ${path}`, `Checked ${path}`, `Couldn't check ${path}`);
    case "file_change": {
      const count = entry.count ?? entry.changes?.length ?? 0;
      const single = count === 1 ? entry.changes?.[0]?.displayPath : undefined;
      const files = single ? target(single, "a file") : plural(count, "file");
      return pick(`Editing ${files}`, `Edited ${files}`, `Couldn't edit ${files}`);
    }
    case "mcp_call": {
      if (entry.mcp?.discovery) return pick("Finding tools", "Found tools", "Tool discovery failed");
      const tool = target(`${entry.mcp?.serverName ? `${entry.mcp.serverName}: ` : ""}${entry.mcp?.toolName ?? ""}`, "a tool");
      return pick(`Calling ${tool}`, `Called ${tool}`, `${tool} failed`);
    }
    case "search": {
      const query = entry.search?.query ? target(entry.search.query, "the web") : "the web";
      return pick(`Searching ${query}`, `Searched ${query}`, "Search failed");
    }
    case "agent_note":
      return entry.text?.trim() ? entry.text : null;
    case "plan": {
      const items = entry.items ?? [];
      return items.length > 0 ? `Plan · ${items.filter((item) => item.completed).length} of ${items.length} done` : null;
    }
    case "workspace_start":
      return active ? "Starting the workspace" : failed ? "The workspace couldn't start" : null;
    case "attachments_prepare":
      return active ? `Preparing ${plural(entry.count ?? 0, "attachment")}` : null;
    case "outputs_export":
      return active ? `Exporting ${plural(entry.count ?? 0, "file")}` : null;
    default:
      return null;
  }
}

export function telegramApprovalTitle(serverName: string, toolName: string): string {
  return `${bounded(serverName)} · ${bounded(toolName)}`;
}

export function telegramAlwaysAllowLabel(serverName: string): string {
  return `Always allow ${bounded(serverName, 48)}`;
}

export function telegramAlwaysAllowedText(serverName: string): string {
  return `Always allowed for ${bounded(serverName)}`;
}

/** An MCP approval in Telegram (D-15) while it waits for a decision, and when a decision could not be made. */
export const TELEGRAM_APPROVAL_COPY = {
  pendingModel: "This tool may change data, so nothing was sent. If you allow it, the answer continues.",
  pendingCode: "Code in the Workspace called this tool, which may change data. Nothing was sent. If you allow it, the next run repeats the script.",
  pendingAgent: "Agent called this tool, which may change data. Nothing was sent.",
  stillRunning: "The answer is still finishing. Try again in a moment.",
  notSaved: "Your decision couldn't be saved. Try again.",
  unavailable: "This approval is no longer available."
} as const;

export function telegramVoiceTranscriptText(transcript: string): string {
  return `🎤 ${transcript}`;
}

const SCHEDULED_TITLE_MAX_LENGTH = 200;

/** A scheduled task's title as its Telegram delivery heads it: one line, bounded, never empty. */
export function telegramScheduledTitle(title: string): string {
  return bounded(title.replace(/[\u0000-\u001f\u007f]+/gu, " "), SCHEDULED_TITLE_MAX_LENGTH) || "Automation";
}

/** The files of a scheduled result that stay in AIQSA (too many or too large for Telegram). */
export function telegramScheduledFilesInAiqsaText(count: number): string {
  return count === 1 ? "1 more file is in AIQSA." : `${count} more files are in AIQSA.`;
}

/** Texts of voice messages, audio files, photos and documents sent to the bot. */
export const TELEGRAM_MEDIA_COPY = {
  voiceTooLarge: "Voice messages and audio files up to 10 MB are supported.",
  voiceUnreadable: "This voice message couldn't be read. Send it again or type your message.",
  voiceFailed: "This voice message couldn't be transcribed. Try again or type your message.",
  voiceEmpty: "No speech was recognized in this voice message.",
  fileUnreadable: "This file couldn't be downloaded from Telegram. Send it again.",
  fileFailed: "This file couldn't be added. Try again, or upload it in AIQSA.",
  fileProcessingFailed: "This file couldn't be processed. Upload it in AIQSA to see why.",
  fileStillProcessing: "This file is taking too long to process. Send it again in a few minutes.",
  pdfInvalid: "This PDF can't be read: it may be damaged or encrypted.",
  pdfTooManyPages: "This PDF has too many pages to read here. Upload it in AIQSA.",
  uploadBusy: "AIQSA is busy with other uploads. Send the file again in a minute."
} as const;

/** Too many voice messages in the dictation window; `retryAfterSeconds` from the limiter. */
export function telegramVoiceRateLimitedText(retryAfterSeconds: number | null | undefined): string {
  return `Too many voice messages in a short time. Send the next one ${waitText(retryAfterSeconds)}.`;
}

/**
 * A file whose type AIQSA does not accept, naming the accepted types. Without
 * Workspace only attachment types go; with it on, other files can too.
 */
export function telegramUnsupportedFileText(acceptedTypes: readonly string[], workspaceHint: boolean): string {
  const accepted = `This file type isn't supported. Send ${acceptedTypes.join(", ")}.`;
  return workspaceHint ? `${accepted} Other files work with Workspace on: turn it on in /settings.` : accepted;
}

/**
 * The one line under an answer's files: how many stayed in AIQSA (too many or
 * too large for Telegram), how many could not be sent, and Workspace files
 * still being prepared or that could not be prepared; null when all went.
 */
export function telegramFilesSummaryText(input: Readonly<{ left: number; failed: number; outputs?: "pending" | "failed" }>): string | null {
  const failed = input.failed === 1 ? "1 file couldn't be sent here" : `${input.failed} files couldn't be sent here`;
  const parts = [
    ...(input.left > 0 ? [telegramScheduledFilesInAiqsaText(input.left)] : []),
    ...(input.failed > 0 ? [input.left > 0 ? `${failed}.` : `${failed}; ${input.failed === 1 ? "it's" : "they're"} in AIQSA.`] : []),
    ...(input.outputs === "pending" ? ["More files are still being prepared in AIQSA."] : []),
    ...(input.outputs === "failed" ? ["Some files couldn't be prepared; AIQSA shows why."] : [])
  ];
  return parts.length > 0 ? parts.join(" ") : null;
}

/** What the user sees for each reason the bot itself answers; `undefined` for log- or settings-only reasons. */
const REASON_TEXT: Partial<Record<TelegramReasonCode, string>> = {
  telegram_not_linked: TELEGRAM_COPY.notLinked,
  telegram_access_off: "Telegram access is off for your account. Ask your AIQSA administrator.",
  telegram_link_code_invalid: "This link has expired. Create a new one in AIQSA → Settings → Connections.",
  telegram_account_in_use: "This Telegram account is connected to another AIQSA account. Disconnect it there first.",
  telegram_unsupported_message: "This message type isn't supported. Send text, voice, photos or documents.",
  telegram_file_too_large: "Files over 20 MB can't come through Telegram. Upload it in AIQSA.",
  telegram_voice_too_long: "Voice messages up to 10 minutes are supported.",
  telegram_voice_unavailable: "Voice messages are not set up on this AIQSA.",
  telegram_busy: "AIQSA is busy, try again in a minute."
};

export function telegramReasonText(code: TelegramReasonCode): string | undefined {
  return REASON_TEXT[code];
}

/** Replies of the core account commands. */
export const TELEGRAM_CORE_COPY = {
  notConnected: "This Telegram account is not connected to AIQSA."
} as const;

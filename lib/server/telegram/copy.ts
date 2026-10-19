import type { TelegramReasonCode } from "../../contracts/telegram";
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
  { command: "settings", description: "Search, Workspace, Agent and model" },
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
  openInAiqsa: "Open in AIQSA",
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

export function telegramConnectedText(name: string): string {
  return `Connected to AIQSA as ${bounded(name)}. Send a message to start a new chat. /help lists commands.`;
}

export function telegramCurrentChatText(title: string): string {
  return `Current chat: ${bounded(title)}`;
}

export function telegramAssistantSelectedText(assistantName: string): string {
  return `Next message starts a chat with ${bounded(assistantName)}`;
}

export function telegramToggleLabel(name: "Search" | "Workspace" | "Agent", enabled: boolean): string {
  return `${name}: ${enabled ? "on" : "off"}`;
}

export function telegramModelLabel(modelName: string): string {
  return `Model: ${bounded(modelName)}`;
}

function minutes(elapsedMs: number): number {
  return Math.max(1, Math.round(elapsedMs / 60_000));
}

export function telegramAgentWorkingText(elapsedMs: number, activity?: string): string {
  const head = `Agent is working · ${minutes(elapsedMs)} min`;
  const detail = activity ? bounded(activity, ACTIVITY_MAX_LENGTH) : "";
  return detail ? `${head} — ${detail}` : head;
}

export function telegramAgentFinishedText(elapsedMs: number): string {
  return `Finished in ${minutes(elapsedMs)} min`;
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

export function telegramVoiceTranscriptText(transcript: string): string {
  return `🎤 ${transcript}`;
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

/** Replies of the core bot until the chat bridge answers messages itself. */
export const TELEGRAM_CORE_COPY = {
  comingSoon: "Chats from Telegram aren't available on this AIQSA yet. /help lists commands.",
  notConnected: "This Telegram account is not connected to AIQSA."
} as const;

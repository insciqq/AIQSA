import type { BrowserPushMessage } from "../../contracts/browserPush";
import { scheduledTaskOutcomeCopy, scheduledTaskSourceLines } from "../scheduledTasks/notifications";
import type { BrowserPushEvent } from "./store";

const TITLE_MAX_CHARS = 120;
/** Unavailable sources a push names; the rest are counted. */
const PUSH_SOURCE_LINES = 3;

function cleanTitle(value: string, fallback: string): string {
  const title = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!title) return fallback;
  const characters = [...title];
  return characters.length > TITLE_MAX_CHARS ? `${characters.slice(0, TITLE_MAX_CHARS - 1).join("")}…` : title;
}

function chatPath(chatId: string): string {
  return `/c/${encodeURIComponent(chatId)}`;
}

/**
 * The content-free notification of one event: the chat or task title, the
 * outcome with fixed copy (for a scheduled run also the sources it could not
 * reach, by display name) and a same-origin path. Never answer text, prompts
 * or any identifier other than the chat id in the path.
 */
export function browserPushMessage(event: BrowserPushEvent): BrowserPushMessage {
  if (event.kind === "run") {
    return {
      body: event.status === "complete" ? "Answer ready" : "The answer did not complete",
      tag: `aiqsa-chat-${event.chatId}`,
      title: cleanTitle(event.title, "AIQSA chat"),
      url: chatPath(event.chatId),
      v: 1
    };
  }
  const { headline, reason } = scheduledTaskOutcomeCopy(event);
  return {
    // A few names keep the encrypted message within the push size bound.
    body: [headline, ...(reason ? [reason] : []), ...scheduledTaskSourceLines(event.unavailableSources, PUSH_SOURCE_LINES)]
      .join("\n"),
    tag: event.chatId ? `aiqsa-chat-${event.chatId}` : "aiqsa-scheduled",
    title: cleanTitle(event.title, "Scheduled task"),
    url: event.chatId ? chatPath(event.chatId) : "/scheduled",
    v: 1
  };
}

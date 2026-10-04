import type { BrowserPushMessage } from "../../contracts/browserPush";
import { scheduledTaskReasonMessage } from "../../contracts/scheduledTasks";
import type { BrowserPushEvent } from "./store";

const TITLE_MAX_CHARS = 120;

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
 * outcome with fixed copy and a same-origin path. Never answer text, prompts
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
  const paused = event.state === "FAILED" && event.trigger === "schedule" && event.taskPauseReason !== null;
  const [outcome, reason] = event.state === "COMPLETED"
    ? ["Scheduled task finished", scheduledTaskReasonMessage(event.reasonCode)]
    : paused
      ? ["Scheduled task paused", scheduledTaskReasonMessage(event.taskPauseReason)]
      : event.state === "SKIPPED"
        ? ["Scheduled task skipped", scheduledTaskReasonMessage(event.reasonCode)]
        : ["Scheduled task did not complete", scheduledTaskReasonMessage(event.reasonCode)];
  return {
    body: reason ? `${outcome}\n${reason}` : outcome,
    tag: event.chatId ? `aiqsa-chat-${event.chatId}` : "aiqsa-scheduled",
    title: cleanTitle(event.title, "Scheduled task"),
    url: event.chatId ? chatPath(event.chatId) : "/scheduled",
    v: 1
  };
}

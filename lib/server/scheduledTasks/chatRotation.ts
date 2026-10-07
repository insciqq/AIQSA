import type { ScheduledTaskChatMode } from "../../contracts/scheduledTasks";
import {
  scheduledTaskMonthChatTitle,
  scheduledTaskMonthKey,
  scheduledTaskRunChatTitle
} from "../../domain/scheduledTaskSchedule";

/**
 * Where an occurrence posts, free of I/O. In new-chat mode every run starts a
 * chat titled with its local date. In same-chat mode a run continues the
 * task's usable chat while the chat's month (`ScheduledTask.chatPeriod`, in the
 * task's zone) is the month of the run's instant, Run now included; the first
 * run of a later month starts a new chat titled with that month (a rotation:
 * the previous chat's shown result and Workspace files are carried over).
 * A chat without a recorded month (older than months, or the first run)
 * adopts the run's month. Without a usable chat a run starts a new one, with
 * nothing carried. A zone that no longer resolves never rotates and keeps the
 * plain task title.
 */
export type ScheduledTaskChatPlan =
  | Readonly<{ kind: "continue"; chatId: string; period: string | null }>
  | Readonly<{ kind: "rotate"; fromChatId: string; period: string; title: string }>
  | Readonly<{ kind: "new"; period: string | null; title: string }>;

function monthKey(instant: Date, timeZone: string): string | null {
  try {
    return scheduledTaskMonthKey(instant, timeZone);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function chatTitle(build: () => string, fallback: string): string {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) return fallback;
    throw error;
  }
}

export function planScheduledTaskChat(input: Readonly<{
  /** The task's chat while it can take the next turn. */
  chat: Readonly<{ id: string }> | null;
  chatMode: ScheduledTaskChatMode;
  /** The month the current chat takes; null when none was recorded yet. */
  chatPeriod: string | null;
  scheduledFor: Date;
  timeZone: string;
  title: string;
}>): ScheduledTaskChatPlan {
  const period = monthKey(input.scheduledFor, input.timeZone);
  if (input.chatMode === "new") {
    return { kind: "new", period, title: chatTitle(() => scheduledTaskRunChatTitle(input.title, input.scheduledFor, input.timeZone),
      input.title) };
  }
  const monthTitle = () => chatTitle(() => scheduledTaskMonthChatTitle(input.title, input.scheduledFor, input.timeZone), input.title);
  if (!input.chat) return { kind: "new", period, title: monthTitle() };
  // "YYYY-MM" orders as text: only a later month rotates (a zone change never goes back).
  if (period !== null && input.chatPeriod !== null && period > input.chatPeriod) {
    return { kind: "rotate", fromChatId: input.chat.id, period, title: monthTitle() };
  }
  return { kind: "continue", chatId: input.chat.id, period: input.chatPeriod ?? period };
}

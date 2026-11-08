"use client";

import { UiV2Icon } from "@/components/ui-v2";
import type { ScheduledTask } from "@/lib/contracts/scheduledTasks";
import { browserTimeZone, formatScheduledInstant } from "./scheduledTaskPresentation";

/** The task facts the hint needs. */
export type ScheduledTaskChatHintTask = Pick<ScheduledTask, "kind" | "nextRunAt" | "running" | "scheduleEnabled" | "status" |
  "webhookEnabled">;

const REPLIES_NOTE = "Replies here don't change the automation.";

/**
 * When the task continuing in this chat runs next, in the viewer's zone:
 * "Next check …" for monitoring, "Next run …" for others, or why it does not
 * run. Null until the task list has loaded.
 */
export function scheduledTaskChatHintText(task: ScheduledTaskChatHintTask | null | undefined, timeZone: string,
  now: Date = new Date()): string | null {
  if (!task) return null;
  const monitoring = task.kind === "monitoring";
  if (task.status === "completed") return "Completed";
  if (task.status === "paused") return "Paused";
  if (task.running) return monitoring ? "Checking now" : "Running now";
  if (task.nextRunAt) return `${monitoring ? "Next check" : "Next run"} ${formatScheduledInstant(task.nextRunAt, timeZone, now)}`;
  return !task.scheduleEnabled && task.webhookEnabled ? "Runs on each webhook call" : "No upcoming run";
}

/**
 * Quiet, persistent line above the composer in a task chat that later runs
 * continue: when the task runs next and its editor. Replies written here never
 * change the task; the line says so beside them, or on a second line on a
 * phone, and in its tooltip.
 */
export function ScheduledTaskChatHintV2({ now, onEdit, task, timeZone, title }: Readonly<{
  /** Fixed clock and zone for tests; the viewer's by default. */
  now?: Date;
  onEdit?(): void;
  task?: ScheduledTaskChatHintTask | null;
  timeZone?: string;
  title: string;
}>) {
  const status = scheduledTaskChatHintText(task, timeZone ?? browserTimeZone(), now);
  return (
    <div className="v2-scheduled-chat-hint" data-testid="scheduled-task-chat-hint" title={REPLIES_NOTE}>
      <UiV2Icon name="clock" />
      {status ? <>
        <p className="v2-scheduled-chat-hint-status">{status}</p>
        <span aria-hidden="true" className="v2-scheduled-chat-hint-sep v2-scheduled-chat-hint-note">·</span>
        <p className="v2-scheduled-chat-hint-note">{REPLIES_NOTE}</p>
      </> : <p className="v2-scheduled-chat-hint-status">{REPLIES_NOTE}</p>}
      {onEdit ? <>
        <span aria-hidden="true" className="v2-scheduled-chat-hint-sep">·</span>
        <button className="v2-scheduled-chat-hint-action v2-focusable" type="button" aria-label={`Edit automation ${title}`} onClick={onEdit}>
          Edit automation
        </button>
      </> : null}
    </div>
  );
}

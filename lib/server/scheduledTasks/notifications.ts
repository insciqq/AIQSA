import { scheduledTaskReasonMessage, type ScheduledTaskRunTrigger } from "../../contracts/scheduledTasks";
import type { SmtpProductMessage } from "../email/definitions";
import type { ScheduledTaskSettledState } from "./runnerPolicy";

/** A settled occurrence whose result email was claimed for sending. */
export type ScheduledTaskNotification = Readonly<{
  chatId: string | null;
  email: string;
  reasonCode: string | null;
  state: ScheduledTaskSettledState;
  /** The task's automatic pause reason while it is paused. */
  taskPauseReason: string | null;
  title: string;
  trigger: ScheduledTaskRunTrigger;
}>;

/**
 * Content-free result email: the task title, the outcome with fixed reason
 * copy (a monitoring check's outcome included) and a link to the task's chat.
 * Never answer text, the prompt or any identifier other than the chat link.
 */
export function scheduledTaskResultEmail(input: ScheduledTaskNotification & Readonly<{ appBaseUrl: string }>): SmtpProductMessage {
  const title = input.title.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  const paused = input.state === "FAILED" && input.trigger === "schedule" && input.taskPauseReason !== null;
  const [subject, outcome, reason] = input.state === "COMPLETED"
    ? ["Scheduled task finished", "finished", scheduledTaskReasonMessage(input.reasonCode)]
    : paused
      ? ["Scheduled task paused", "was paused", scheduledTaskReasonMessage(input.taskPauseReason)]
      : input.state === "SKIPPED"
        ? ["Scheduled task skipped", "was skipped", scheduledTaskReasonMessage(input.reasonCode)]
        : ["Scheduled task did not complete", "did not complete", scheduledTaskReasonMessage(input.reasonCode)];
  const link = new URL(input.chatId ? `/c/${encodeURIComponent(input.chatId)}` : "/", input.appBaseUrl).toString();
  return {
    kind: "scheduled_task_result",
    subject,
    text: [
      `Your AIQSA scheduled task "${title}" ${outcome}.`,
      ...(reason ? [reason] : []),
      "",
      input.chatId ? "Open the task's chat:" : "Open AIQSA:",
      link
    ].join("\n"),
    to: input.email
  };
}

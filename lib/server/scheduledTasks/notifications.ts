import {
  scheduledTaskReasonMessage,
  scheduledTaskSourceMessage,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskUnavailableSource
} from "../../contracts/scheduledTasks";
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
  /** The relevant sources the run could not reach (its source health); empty when complete. */
  unavailableSources: readonly ScheduledTaskUnavailableSource[];
}>;

const HEADLINES = {
  "did not complete": "Scheduled task did not complete",
  finished: "Scheduled task finished",
  "was paused": "Scheduled task paused",
  "was skipped": "Scheduled task skipped"
} as const;

/**
 * The outcome, its headline and the fixed reason line of a settled
 * occurrence, as the result email and the browser push state them. A
 * completed run that missed sources so often that it paused its task reads
 * as paused.
 */
export function scheduledTaskOutcomeCopy(input: Pick<ScheduledTaskNotification,
  "reasonCode" | "state" | "taskPauseReason" | "trigger" | "unavailableSources">): Readonly<{
  headline: (typeof HEADLINES)[keyof typeof HEADLINES];
  outcome: keyof typeof HEADLINES;
  reason: string | null;
}> {
  const copy = (outcome: keyof typeof HEADLINES, reason: string | null) => ({ headline: HEADLINES[outcome], outcome, reason });
  const pausedBySources = input.state === "COMPLETED" && input.trigger === "schedule" &&
    input.taskPauseReason === "source_unavailable" && input.unavailableSources.length > 0;
  if (pausedBySources) return copy("was paused", scheduledTaskReasonMessage(input.taskPauseReason));
  if (input.state === "COMPLETED") return copy("finished", null);
  if (input.state === "FAILED" && input.trigger === "schedule" && input.taskPauseReason !== null) {
    return copy("was paused", scheduledTaskReasonMessage(input.taskPauseReason));
  }
  return input.state === "SKIPPED"
    ? copy("was skipped", scheduledTaskReasonMessage(input.reasonCode))
    : copy("did not complete", scheduledTaskReasonMessage(input.reasonCode));
}

/**
 * One line per unavailable source, its display name made single-line; past
 * `limit` sources, one line counts the rest.
 */
export function scheduledTaskSourceLines(sources: readonly ScheduledTaskUnavailableSource[], limit = sources.length): string[] {
  const lines = sources.slice(0, limit).map((source) => scheduledTaskSourceMessage({
    ...source, name: source.name.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim()
  }));
  const more = sources.length - lines.length;
  return more > 0 ? [...lines, `${more} more ${more === 1 ? "source is" : "sources are"} unavailable.`] : lines;
}

/**
 * Content-free result email: the task title, the outcome with fixed reason
 * copy, the names of sources the run could not reach and a link to the task's
 * chat. Never answer text, the prompt or any identifier other than the chat
 * link.
 */
export function scheduledTaskResultEmail(input: ScheduledTaskNotification & Readonly<{ appBaseUrl: string }>): SmtpProductMessage {
  const title = input.title.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  const { headline, outcome, reason } = scheduledTaskOutcomeCopy(input);
  const link = new URL(input.chatId ? `/c/${encodeURIComponent(input.chatId)}` : "/", input.appBaseUrl).toString();
  return {
    kind: "scheduled_task_result",
    subject: headline,
    text: [
      `Your AIQSA scheduled task "${title}" ${outcome}.`,
      ...(reason ? [reason] : []),
      ...scheduledTaskSourceLines(input.unavailableSources),
      "",
      input.chatId ? "Open the task's chat:" : "Open AIQSA:",
      link
    ].join("\n"),
    to: input.email
  };
}

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

type OutcomeInput = Pick<ScheduledTaskNotification, "reasonCode" | "state" | "taskPauseReason" | "trigger" | "unavailableSources">;

/**
 * A completed scheduled run that paused its task: one that missed sources so
 * often (`source_unavailable`), or a monitoring check that ended a streak
 * without a report (`verdict_missing`). The settled run's own record shows it
 * caused that pause.
 */
function completedRunPausedTask(input: OutcomeInput): boolean {
  if (input.state !== "COMPLETED" || input.trigger !== "schedule") return false;
  return (input.taskPauseReason === "source_unavailable" && input.unavailableSources.length > 0) ||
    (input.taskPauseReason === "verdict_missing" && input.reasonCode === "unreported");
}

/**
 * The outcome, its headline and the fixed reason line of a settled
 * occurrence, as the result email and the browser push state them. A
 * completed run that paused its task reads as paused; any other completed
 * run names its monitoring check outcome, if it has one.
 */
export function scheduledTaskOutcomeCopy(input: OutcomeInput): Readonly<{
  headline: (typeof HEADLINES)[keyof typeof HEADLINES];
  outcome: keyof typeof HEADLINES;
  reason: string | null;
}> {
  const copy = (outcome: keyof typeof HEADLINES, reason: string | null) => ({ headline: HEADLINES[outcome], outcome, reason });
  if (completedRunPausedTask(input)) return copy("was paused", scheduledTaskReasonMessage(input.taskPauseReason));
  if (input.state === "COMPLETED") return copy("finished", scheduledTaskReasonMessage(input.reasonCode));
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
 * copy (a monitoring check's outcome included), the names of sources the run
 * could not reach and a link to the task's chat. Never answer text, the
 * prompt or any identifier other than the chat link.
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

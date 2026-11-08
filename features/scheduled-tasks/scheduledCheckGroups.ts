import type { ScheduledTaskCheckOutcome } from "@/lib/contracts/scheduledTasks";
import { formatScheduledDay, formatScheduledInstant } from "./scheduledTaskPresentation";

type TranscriptMessage = Readonly<{
  /** When the message was written; the transcript shows times only when it has them. */
  createdAt?: string;
  id: string;
  role: "assistant" | "user";
  scheduledOutcome?: ScheduledTaskCheckOutcome;
  /** Present on a user turn that a scheduled task posted. */
  scheduledTask?: Readonly<{ taskRunId: string }> | null;
  status?: "cancelled" | "complete" | "error" | "streaming";
}>;

/** What a folded run of checks holds, in words the transcript can say. */
export type ScheduledChecksSummary = Readonly<{
  /** Checks in the group, each counted once. */
  checks: number;
  /** Of those, checks that failed and were followed by a later successful one. */
  failed: number;
  /** When the group's latest check ran; null when the transcript has no time for it. */
  lastAt: string | null;
  /** "check" in a monitoring chat, "run" in a chat of a regular automation. */
  noun: "check" | "run";
}>;

/** A transcript entry: one message, or a run of folded scheduled checks. */
export type ScheduledTranscriptItem<T extends TranscriptMessage> =
  | Readonly<{ kind: "message"; message: T }>
  | Readonly<{ id: string; kind: "checks"; messages: readonly T[]; summary: ScheduledChecksSummary }>;

/** Group ids never collide with message ids. */
const GROUP_PREFIX = "scheduled-checks:";

type CheckState = "quiet" | "success" | "failed" | "pending";
type Unit<T> = { check: boolean; messages: T[] };

/**
 * A check's turn and its answer carry the same settled outcome; a failed run has none and an answer that errored or stopped.
 * Only `could_not_check` is a settled failure: an `unreported` check answered without its verdict, so its answer may hold
 * news and stays shown, like an update.
 */
function checkState<T extends TranscriptMessage>(unit: Unit<T>, last: boolean): CheckState {
  const outcome = unit.messages.find((message) => message.scheduledOutcome)?.scheduledOutcome;
  if (outcome) return outcome === "no_update" ? "quiet" : outcome === "could_not_check" ? "failed" : "success";
  const answer = unit.messages.filter((message) => message.role === "assistant").at(-1);
  if (!answer) return last ? "pending" : "failed";
  if (answer.status === "error" || answer.status === "cancelled") return "failed";
  if (answer.status === "streaming") return "pending";
  // A regular automation's run answers without a check outcome.
  return "success";
}

/**
 * Folds scheduled checks that need no attention into quiet groups; every
 * other message stays its own entry, in order. A check with no update always
 * folds. A check that failed (could not check, or a run that errored or
 * stopped without an outcome) folds only once a later check in
 * this transcript settled successfully: the latest failure stays visible
 * until then. Consecutive folded checks form one group; anything else
 * (an update, a running check, the user's own turns) ends it. A check counts
 * once, by its scheduled turn, or by its answer when an earlier page holds
 * the turn. The group id follows its first message, so an open group stays
 * open while later checks join it.
 */
export function groupScheduledChecks<T extends TranscriptMessage>(messages: readonly T[]): ScheduledTranscriptItem<T>[] {
  const units: Unit<T>[] = [];
  for (const message of messages) {
    const current = units.at(-1);
    if (message.role === "user") units.push({ check: Boolean(message.scheduledTask), messages: [message] });
    else if (current) current.messages.push(message);
    else units.push({ check: Boolean(message.scheduledOutcome), messages: [message] });
  }
  const noun = messages.some((message) => message.scheduledOutcome) ? "check" : "run";
  const folds: boolean[] = new Array<boolean>(units.length).fill(false);
  let laterSuccess = false;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (!unit.check) continue;
    const state = checkState(unit, index === units.length - 1);
    folds[index] = state === "quiet" || (state === "failed" && laterSuccess);
    if (state === "quiet" || state === "success") laterSuccess = true;
  }

  const items: ScheduledTranscriptItem<T>[] = [];
  let run: Unit<T>[] = [];
  const close = () => {
    if (!run.length) return;
    const groupMessages = run.flatMap((unit) => unit.messages);
    const failed = run.filter((unit) => checkState(unit, false) === "failed").length;
    const last = run.at(-1)!.messages;
    const lastAt = last.find((message) => message.createdAt)?.createdAt ?? null;
    items.push({ id: `${GROUP_PREFIX}${groupMessages[0]!.id}`, kind: "checks", messages: groupMessages,
      summary: { checks: run.length, failed, lastAt, noun } });
    run = [];
  };
  units.forEach((unit, index) => {
    if (folds[index]) {
      run.push(unit);
      return;
    }
    close();
    for (const message of unit.messages) items.push({ kind: "message", message });
  });
  close();
  return items;
}

function counted(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** "3 checks with no update", "23 checks with no update · 2 failed", "1 failed check". */
export function scheduledChecksLabel(summary: Pick<ScheduledChecksSummary, "checks" | "failed" | "noun">): string {
  const quiet = summary.checks - summary.failed;
  if (!summary.failed) return `${counted(summary.checks, "check")} with no update`;
  if (!quiet) return `${summary.failed} failed ${summary.failed === 1 ? summary.noun : `${summary.noun}s`}`;
  return `${counted(quiet, "check")} with no update · ${summary.failed} failed`;
}

/**
 * When a transcript message was written, if the browser's message carries it.
 * The wire sends `createdAt` on every message; the transcript shows run times
 * only once the client message keeps it.
 */
export function scheduledTurnCreatedAt(message: Readonly<{ createdAt?: string; id: string }>): string | null {
  return message.createdAt ?? null;
}

/** A transcript time in the viewer's zone: "15:03" today, "Sun 4 Oct, 15:03" on another day. */
export function formatScheduledTranscriptTime(value: string, timeZone: string, now: Date = new Date()): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const instant = formatScheduledInstant(date, timeZone, now);
  return formatScheduledDay(date, timeZone, now) === formatScheduledDay(now, timeZone, now)
    ? instant.slice(instant.lastIndexOf(", ") + 2) : instant;
}

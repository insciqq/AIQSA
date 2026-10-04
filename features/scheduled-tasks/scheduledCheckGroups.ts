import type { ScheduledTaskCheckOutcome } from "@/lib/contracts/scheduledTasks";

type TranscriptMessage = Readonly<{
  id: string;
  role: "assistant" | "user";
  scheduledOutcome?: ScheduledTaskCheckOutcome;
}>;

/** A transcript entry: one message, or a run of monitoring checks with no update. */
export type ScheduledTranscriptItem<T extends TranscriptMessage> =
  | Readonly<{ kind: "message"; message: T }>
  | Readonly<{ checks: number; id: string; kind: "checks"; messages: readonly T[] }>;

/** Group ids never collide with message ids. */
const GROUP_PREFIX = "scheduled-checks:";

/**
 * Groups each run of consecutive messages that belong to monitoring checks
 * with no update; every other message stays its own entry, in order. Only a
 * settled `no_update` outcome groups: a running check has none yet, and
 * checks that could not check or did not report stay visible. A check counts
 * once, by its scheduled turn, or by its answer when an earlier page holds the
 * turn. The group id follows its first message, so an open group stays open
 * while later checks join it.
 */
export function groupScheduledChecks<T extends TranscriptMessage>(messages: readonly T[]): ScheduledTranscriptItem<T>[] {
  const items: ScheduledTranscriptItem<T>[] = [];
  let run: T[] = [];
  const close = () => {
    if (!run.length) return;
    const checks = run.filter((message) => message.role === "user").length + (run[0]!.role === "assistant" ? 1 : 0);
    items.push({ checks, id: `${GROUP_PREFIX}${run[0]!.id}`, kind: "checks", messages: run });
    run = [];
  };
  for (const message of messages) {
    if (message.scheduledOutcome === "no_update") {
      run.push(message);
      continue;
    }
    close();
    items.push({ kind: "message", message });
  }
  close();
  return items;
}

export function scheduledChecksLabel(checks: number): string {
  return `${checks} ${checks === 1 ? "check" : "checks"} with no update`;
}

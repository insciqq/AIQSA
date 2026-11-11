import { describe, expect, it } from "vitest";
import type { ScheduledTaskCheckOutcome } from "@/lib/contracts/scheduledTasks";
import {
  formatScheduledTranscriptTime,
  groupScheduledChecks,
  quietChecksLabel,
  scheduledChecksLabel,
  scheduledTurnCreatedAt
} from "./scheduledCheckGroups";

type Message = Readonly<{
  createdAt?: string;
  id: string;
  role: "assistant" | "user";
  scheduledOutcome?: ScheduledTaskCheckOutcome;
  scheduledTask?: Readonly<{ taskRunId: string }> | null;
  status?: "cancelled" | "complete" | "error" | "streaming";
}>;

/** One check: its scheduled turn and its answer, both carrying the settled outcome (none while it runs or when it failed). */
function check(id: string, outcome?: ScheduledTaskCheckOutcome, answer: Partial<Message> = {}, createdAt?: string): Message[] {
  const marker = outcome ? { scheduledOutcome: outcome } : {};
  return [
    { id: `${id}-q`, role: "user", scheduledTask: { taskRunId: id }, ...marker, ...(createdAt ? { createdAt } : {}) },
    { id: `${id}-a`, role: "assistant", ...marker, ...answer }
  ];
}

/** A run that errored: no outcome, and its answer is a failure card. */
const failedRun = (id: string, createdAt?: string) => check(id, undefined, { status: "error" }, createdAt);

function shape(messages: readonly Message[]) {
  return groupScheduledChecks(messages).map((item) => item.kind === "message"
    ? item.message.id
    : { ...item.summary, id: item.id, messages: item.messages.map((message) => message.id) });
}

describe("groupScheduledChecks", () => {
  it("folds each run of consecutive checks with no update into one group and keeps everything else in order", () => {
    expect(shape([
      ...check("c1", "baseline"), ...check("c2", "no_update"), ...check("c3", "no_update"), ...check("c4", "update"),
      ...check("c5", "no_update"), { id: "reply", role: "user" }, { id: "reply-a", role: "assistant" }, ...check("c6", "no_update")
    ])).toEqual([
      "c1-q", "c1-a",
      { checks: 2, failed: 0, id: "scheduled-checks:c2-q", lastAt: null, messages: ["c2-q", "c2-a", "c3-q", "c3-a"], noun: "check" },
      "c4-q", "c4-a",
      { checks: 1, failed: 0, id: "scheduled-checks:c5-q", lastAt: null, messages: ["c5-q", "c5-a"], noun: "check" },
      "reply", "reply-a",
      { checks: 1, failed: 0, id: "scheduled-checks:c6-q", lastAt: null, messages: ["c6-q", "c6-a"], noun: "check" }
    ]);
  });

  it("folds failed checks into the surrounding group once a later check settled successfully", () => {
    // The production shape: two failures, then checks with no update; the group says when its latest check ran.
    expect(shape([
      ...check("c1", "baseline"), ...failedRun("c2"), ...check("c3", "could_not_check"), ...check("c4", "no_update"),
      ...check("c5", "no_update", {}, "2026-10-04T08:00:00.000Z")
    ])).toEqual([
      "c1-q", "c1-a",
      { checks: 4, failed: 2, id: "scheduled-checks:c2-q", lastAt: "2026-10-04T08:00:00.000Z", noun: "check",
        messages: ["c2-q", "c2-a", "c3-q", "c3-a", "c4-q", "c4-a", "c5-q", "c5-a"] }
    ]);
    // A failure between a first check and an update folds on its own, and a stopped run counts too.
    expect(shape([...check("c1", "baseline"), ...check("c2", undefined, { status: "cancelled" }), ...check("c3", "could_not_check"),
      ...check("c4", "update")])).toEqual([
      "c1-q", "c1-a",
      { checks: 2, failed: 2, id: "scheduled-checks:c2-q", lastAt: null, messages: ["c2-q", "c2-a", "c3-q", "c3-a"], noun: "check" },
      "c4-q", "c4-a"
    ]);
  });

  it("never folds a check that answered without its verdict, since its answer may hold news", () => {
    // The answer said what happened but recorded no verdict; the next check compares with it and has no update.
    expect(shape([...check("c1", "unreported"), ...check("c2", "no_update")])).toEqual([
      "c1-q", "c1-a",
      { checks: 1, failed: 0, id: "scheduled-checks:c2-q", lastAt: null, messages: ["c2-q", "c2-a"], noun: "check" }
    ]);
    // It shows that checks run again, so a failure before it folds.
    expect(shape([...failedRun("c1"), ...check("c2", "unreported")])).toEqual([
      { checks: 1, failed: 1, id: "scheduled-checks:c1-q", lastAt: null, messages: ["c1-q", "c1-a"], noun: "check" },
      "c2-q", "c2-a"
    ]);
  });

  it("keeps the latest failures visible while nothing successful followed them", () => {
    const tail = [...failedRun("c3"), ...check("c4", "could_not_check")];
    expect(shape([...check("c1", "baseline"), ...check("c2", "no_update"), ...tail])).toEqual([
      "c1-q", "c1-a",
      { checks: 1, failed: 0, id: "scheduled-checks:c2-q", lastAt: null, messages: ["c2-q", "c2-a"], noun: "check" },
      ...tail.map((message) => message.id)
    ]);
    // A running check is not a success yet: the failure before it stays until it settles.
    const running = check("c5", undefined, { status: "streaming" });
    expect(shape([...check("c1", "baseline"), ...failedRun("c2"), ...running]))
      .toEqual(["c1-q", "c1-a", "c2-q", "c2-a", "c5-q", "c5-a"]);
    // The user's own turn after a failure is not a check.
    expect(shape([...failedRun("c1"), { id: "reply", role: "user" }, { id: "reply-a", role: "assistant" }]))
      .toEqual(["c1-q", "c1-a", "reply", "reply-a"]);
  });

  it("never folds a first check, an update, a reached goal or a running check", () => {
    const messages = [...check("c1", "baseline"), ...check("c2", "update"), ...check("c3", "goal_reached"),
      ...check("c4", undefined, { status: "streaming" })];
    expect(shape(messages)).toEqual(messages.map((message) => message.id));
  });

  it("folds a regular automation's failed run once a later run answered, and counts runs", () => {
    expect(shape([...failedRun("r1"), ...failedRun("r2", "2026-10-03T08:00:00.000Z"), ...check("r3")])).toEqual([
      { checks: 2, failed: 2, id: "scheduled-checks:r1-q", lastAt: "2026-10-03T08:00:00.000Z", noun: "run",
        messages: ["r1-q", "r1-a", "r2-q", "r2-a"] },
      "r3-q", "r3-a"
    ]);
    // The latest answered run stays visible, and an answered run is never folded.
    expect(shape([...check("r1"), ...check("r2")])).toEqual(["r1-q", "r1-a", "r2-q", "r2-a"]);
  });

  it("keeps the group id while later checks join it, so an open group stays open after a running check settles", () => {
    const running = shape([...check("c1", "no_update"), ...check("c2", undefined, { status: "streaming" })]);
    const settled = shape([...check("c1", "no_update"), ...check("c2", "no_update")]);
    expect(running[0]).toMatchObject({ id: "scheduled-checks:c1-q", checks: 1 });
    expect(running.slice(1)).toEqual(["c2-q", "c2-a"]);
    expect(settled).toEqual([{ checks: 2, failed: 0, id: "scheduled-checks:c1-q", lastAt: null, messages: ["c1-q", "c1-a", "c2-q", "c2-a"],
      noun: "check" }]);
  });

  it("counts a check whose turn is on an earlier page by its answer", () => {
    expect(shape([{ id: "c1-a", role: "assistant", scheduledOutcome: "no_update" }, ...check("c2", "no_update")]))
      .toEqual([{ checks: 2, failed: 0, id: "scheduled-checks:c1-a", lastAt: null, messages: ["c1-a", "c2-q", "c2-a"], noun: "check" }]);
  });
});

describe("quietChecksLabel", () => {
  it("counts the checks the history leaves out", () => {
    expect(quietChecksLabel(1)).toBe("Checked once, no change");
    expect(quietChecksLabel(202)).toBe("Checked 202 times, no change");
  });
});

describe("scheduledChecksLabel", () => {
  it("says what the group holds in true counts", () => {
    expect(scheduledChecksLabel({ checks: 1, failed: 0, noun: "check" })).toBe("1 check with no update");
    expect(scheduledChecksLabel({ checks: 4, failed: 0, noun: "check" })).toBe("4 checks with no update");
    expect(scheduledChecksLabel({ checks: 25, failed: 2, noun: "check" })).toBe("23 checks with no update · 2 failed");
    expect(scheduledChecksLabel({ checks: 2, failed: 1, noun: "check" })).toBe("1 check with no update · 1 failed");
    expect(scheduledChecksLabel({ checks: 1, failed: 1, noun: "check" })).toBe("1 failed check");
    expect(scheduledChecksLabel({ checks: 3, failed: 3, noun: "run" })).toBe("3 failed runs");
  });
});

describe("formatScheduledTranscriptTime", () => {
  const now = new Date("2026-10-04T10:00:00.000Z");
  it("shows only the time today and the day on other days, in the viewer's zone", () => {
    expect(formatScheduledTranscriptTime("2026-10-04T08:03:00.000Z", "Europe/London", now)).toBe("09:03");
    expect(formatScheduledTranscriptTime("2026-10-03T14:03:00.000Z", "Europe/London", now)).toBe("Sat 3 Oct, 15:03");
    // Late on the 3rd in London is already the 4th in Tokyo.
    expect(formatScheduledTranscriptTime("2026-10-03T22:30:00.000Z", "Asia/Tokyo", now)).toBe("07:30");
    expect(formatScheduledTranscriptTime("2025-12-31T09:00:00.000Z", "Europe/London", now)).toBe("Wed 31 Dec 2025, 09:00");
    expect(formatScheduledTranscriptTime("not a time", "Europe/London", now)).toBeNull();
  });

  it("reads a message's time only when the message carries one", () => {
    expect(scheduledTurnCreatedAt({ createdAt: "2026-10-04T08:03:00.000Z", id: "m" })).toBe("2026-10-04T08:03:00.000Z");
    expect(scheduledTurnCreatedAt({ id: "m" })).toBeNull();
  });
});

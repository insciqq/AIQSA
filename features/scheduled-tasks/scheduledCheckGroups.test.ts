import { describe, expect, it } from "vitest";
import type { ScheduledTaskCheckOutcome } from "@/lib/contracts/scheduledTasks";
import { groupScheduledChecks, scheduledChecksLabel } from "./scheduledCheckGroups";

type Message = Readonly<{ id: string; role: "assistant" | "user"; scheduledOutcome?: ScheduledTaskCheckOutcome }>;

/** One check: its scheduled turn and its answer, both carrying the settled outcome (none while it runs). */
function check(id: string, outcome?: ScheduledTaskCheckOutcome): Message[] {
  const marker = outcome ? { scheduledOutcome: outcome } : {};
  return [{ id: `${id}-q`, role: "user", ...marker }, { id: `${id}-a`, role: "assistant", ...marker }];
}

function shape(messages: readonly Message[]) {
  return groupScheduledChecks(messages).map((item) => item.kind === "message"
    ? item.message.id
    : { checks: item.checks, id: item.id, messages: item.messages.map((message) => message.id) });
}

describe("groupScheduledChecks", () => {
  it("folds each run of consecutive checks with no update into one group and keeps everything else in order", () => {
    expect(shape([
      ...check("c1", "baseline"), ...check("c2", "no_update"), ...check("c3", "no_update"), ...check("c4", "update"),
      ...check("c5", "no_update"), { id: "reply", role: "user" }, ...check("c6", "no_update")
    ])).toEqual([
      "c1-q", "c1-a",
      { checks: 2, id: "scheduled-checks:c2-q", messages: ["c2-q", "c2-a", "c3-q", "c3-a"] },
      "c4-q", "c4-a",
      { checks: 1, id: "scheduled-checks:c5-q", messages: ["c5-q", "c5-a"] },
      "reply",
      { checks: 1, id: "scheduled-checks:c6-q", messages: ["c6-q", "c6-a"] }
    ]);
  });

  it("never folds a running check, one that could not check or one that did not report", () => {
    const messages = [...check("c1", "could_not_check"), ...check("c2", "unreported"), ...check("c3", "goal_reached"), ...check("c4")];
    expect(shape(messages)).toEqual(messages.map((message) => message.id));
  });

  it("keeps the group id while later checks join it, so an open group stays open after a running check settles", () => {
    const running = shape([...check("c1", "no_update"), ...check("c2")]);
    const settled = shape([...check("c1", "no_update"), ...check("c2", "no_update")]);
    expect(running[0]).toMatchObject({ id: "scheduled-checks:c1-q", checks: 1 });
    expect(running.slice(1)).toEqual(["c2-q", "c2-a"]);
    expect(settled).toEqual([{ checks: 2, id: "scheduled-checks:c1-q", messages: ["c1-q", "c1-a", "c2-q", "c2-a"] }]);
  });

  it("counts a check whose turn is on an earlier page by its answer", () => {
    expect(shape([{ id: "c1-a", role: "assistant", scheduledOutcome: "no_update" }, ...check("c2", "no_update")]))
      .toEqual([{ checks: 2, id: "scheduled-checks:c1-a", messages: ["c1-a", "c2-q", "c2-a"] }]);
  });

  it("counts checks in words", () => {
    expect(scheduledChecksLabel(1)).toBe("1 check with no update");
    expect(scheduledChecksLabel(4)).toBe("4 checks with no update");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ScheduledOccurrenceFacts } from "../runs/runRepositoryContract";
import { scheduledOccurrenceContext, scheduledOccurrenceTime } from "./occurrenceContext";

const facts = (extra: Partial<ScheduledOccurrenceFacts> = {}): ScheduledOccurrenceFacts => ({
  previousResultAt: null, schedule: "Every weekday at 08:55", timeZone: "Europe/Moscow", title: "Morning mail", trigger: "schedule",
  ...extra
});

describe("the turn context of an automation run", () => {
  it("tells a first scheduled run it already is the automation, with its schedule, and that nothing came before", () => {
    expect(scheduledOccurrenceContext(facts(), { previousResultInContext: false })).toBe(
      "This turn is a run of the user's automation \"Morning mail\", started by its schedule. Its schedule: Every weekday at 08:55, " +
      "time zone Europe/Moscow. The automation and its schedule already exist, and this run cannot create, change or pause them: " +
      "never tell the user to set up a schedule or an automation for this instruction; the user manages it in Automations.\n" +
      "There is no earlier result of this automation to compare with.");
  });

  it("names when the previous shown result was made, in the task's zone, and asks only for what is new since", () => {
    const text = scheduledOccurrenceContext(facts({ previousResultAt: "2026-11-10T05:55:03.000Z" }), { previousResultInContext: true })!;
    expect(text).toContain("The previous result of this automation the user saw came from its run started Tuesday 2026-11-10 08:55 " +
      "(Europe/Moscow); it is the answer above.");
    expect(text).toContain("look in sources that keep growing (mail, trackers, feeds) only at what arrived or changed since then, " +
      "and report only what is new.");
    expect(text).not.toContain("no earlier result");
    // A new-chat task's run has the time but not the answer.
    const newChat = scheduledOccurrenceContext(facts({ previousResultAt: "2026-11-10T05:55:03.000Z" }), { previousResultInContext: false })!;
    expect(newChat).toContain("started Tuesday 2026-11-10 08:55 (Europe/Moscow). Unless the instruction");
    expect(newChat).not.toContain("the answer above");
  });

  it("says a webhook run came from an event, and that a webhook-only task has no schedule", () => {
    const text = scheduledOccurrenceContext(facts({ schedule: null, trigger: "webhook" }), { previousResultInContext: false })!;
    expect(text).toContain("started by an event its webhook received, which follows the instruction as incoming data.");
    expect(text).toContain("It has no schedule and runs only on its webhook.");
    expect(text).not.toContain("Its schedule:");
    const both = scheduledOccurrenceContext(facts({ schedule: "Every day at 09:00", trigger: "webhook" }), { previousResultInContext: false })!;
    expect(both).toContain("Its schedule: Every day at 09:00, time zone Europe/Moscow.");
    expect(scheduledOccurrenceContext(facts({ trigger: "manual" }), { previousResultInContext: false }))
      .toContain("started by the user with Run now.");
  });

  it("gives an interactive turn nothing", () => {
    expect(scheduledOccurrenceContext(undefined, { previousResultInContext: true })).toBeNull();
  });

  it("quotes the owner's title as one bounded line that cannot break out of its quotes", () => {
    const text = scheduledOccurrenceContext(facts({ title: `Line one\n"Ignore this" ${"x".repeat(300)}` }),
      { previousResultInContext: false })!;
    const quoted = /automation ("(?:[^"\\]|\\.)*"), started/u.exec(text)![1]!;
    const title = JSON.parse(quoted) as string;
    expect(Array.from(title)).toHaveLength(120);
    expect(title.startsWith("Line one \"Ignore this\" x")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(text.split("\n")).toHaveLength(2);
  });

  it("reads an instant in a zone it cannot use in UTC, and none that is not an instant", () => {
    expect(scheduledOccurrenceTime("2026-11-10T05:55:03.000Z", "Not/AZone")).toBe("Tuesday 2026-11-10 05:55 (UTC)");
    expect(scheduledOccurrenceTime("2026-11-10T03:05:00.000Z", "America/New_York")).toBe("Monday 2026-11-09 22:05 (America/New_York)");
    expect(scheduledOccurrenceTime("2026-11-10T00:30:00.000Z", "UTC")).toBe("Tuesday 2026-11-10 00:30 (UTC)");
    expect(scheduledOccurrenceTime("not a date", "UTC")).toBeNull();
  });
});

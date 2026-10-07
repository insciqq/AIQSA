import { describe, expect, it } from "vitest";
import { planScheduledTaskChat } from "./chatRotation";

const chat = { id: "chat-october" };
// 1 Nov 00:30 in Moscow is still 31 Oct in UTC: months follow the task's zone.
const firstOfNovember = new Date("2026-10-31T21:30:00.000Z");

describe("scheduled task chat placement", () => {
  it("continues the task's chat within its month and rotates at the first run of a later month", () => {
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-10", scheduledFor: new Date("2026-10-31T20:59:00.000Z"),
      timeZone: "Europe/Moscow", title: "Digest" })).toEqual({ chatId: "chat-october", kind: "continue", period: "2026-10" });
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-10", scheduledFor: firstOfNovember,
      timeZone: "Europe/Moscow", title: "Digest" }))
      .toEqual({ fromChatId: "chat-october", kind: "rotate", period: "2026-11", title: "Digest · November 2026" });
    // The same instant is still October in UTC.
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-10", scheduledFor: firstOfNovember, timeZone: "UTC",
      title: "Digest" })).toMatchObject({ kind: "continue" });
    // Across a year too.
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-12", scheduledFor: new Date("2027-01-01T06:00:00.000Z"),
      timeZone: "UTC", title: "Digest" })).toMatchObject({ kind: "rotate", period: "2027-01", title: "Digest · January 2027" });
  });

  it("never rotates back a month, and lets a chat without a month adopt the run's", () => {
    // A zone moved earlier: the chat's month stays until a later one comes.
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-11", scheduledFor: new Date("2026-10-31T22:00:00.000Z"),
      timeZone: "UTC", title: "Digest" })).toEqual({ chatId: "chat-october", kind: "continue", period: "2026-11" });
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: null, scheduledFor: firstOfNovember, timeZone: "Europe/Moscow",
      title: "Digest" })).toEqual({ chatId: "chat-october", kind: "continue", period: "2026-11" });
  });

  it("starts a chat titled with the month without a usable chat, and a dated one per run in new-chat mode", () => {
    expect(planScheduledTaskChat({ chat: null, chatMode: "same", chatPeriod: "2026-10", scheduledFor: firstOfNovember,
      timeZone: "Europe/Moscow", title: "Digest" })).toEqual({ kind: "new", period: "2026-11", title: "Digest · November 2026" });
    expect(planScheduledTaskChat({ chat, chatMode: "new", chatPeriod: "2026-10", scheduledFor: firstOfNovember,
      timeZone: "Europe/Moscow", title: "Digest" })).toEqual({ kind: "new", period: "2026-11", title: "Digest · 1 Nov 2026" });
  });

  it("keeps the plain title and never rotates when the zone no longer resolves", () => {
    expect(planScheduledTaskChat({ chat, chatMode: "same", chatPeriod: "2026-10", scheduledFor: firstOfNovember, timeZone: "Mars/Olympus",
      title: "Digest" })).toEqual({ chatId: "chat-october", kind: "continue", period: "2026-10" });
    expect(planScheduledTaskChat({ chat: null, chatMode: "same", chatPeriod: null, scheduledFor: firstOfNovember,
      timeZone: "Mars/Olympus", title: "Digest" })).toEqual({ kind: "new", period: null, title: "Digest" });
  });

  it("shortens a long task title to keep the month's chat title within the bound", () => {
    const plan = planScheduledTaskChat({ chat: null, chatMode: "same", chatPeriod: null, scheduledFor: firstOfNovember,
      timeZone: "Europe/Moscow", title: "Ж".repeat(120) });
    expect(plan.kind === "new" && Array.from(plan.title)).toHaveLength(120);
    expect(plan).toMatchObject({ title: expect.stringMatching(/Ж… · November 2026$/u) });
  });
});

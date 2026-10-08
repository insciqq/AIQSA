import { describe, expect, it } from "vitest";
import { browserPushMessage } from "./payload";
import type { OccurrencePushEvent } from "./store";

const occurrence: OccurrencePushEvent = {
  chatId: "chat-1", kind: "occurrence", reasonCode: null, state: "COMPLETED", taskPauseReason: null,
  title: "Morning brief", trigger: "schedule", unavailableSources: [], userId: "owner-1"
};

describe("browser push message", () => {
  it("names a finished or failed chat answer by its title and links only the chat", () => {
    expect(browserPushMessage({ chatId: "chat 1", kind: "run", status: "complete", title: "Trip plan", userId: "owner-1" }))
      .toEqual({ body: "Answer ready", tag: "aiqsa-chat-chat 1", title: "Trip plan", url: "/c/chat%201", v: 1 });
    expect(browserPushMessage({ chatId: "chat-1", kind: "run", status: "error", title: "Trip plan", userId: "owner-1" }))
      .toMatchObject({ body: "The answer did not complete", url: "/c/chat-1" });
  });

  it("states each scheduled outcome with fixed copy and never the owner id", () => {
    expect(browserPushMessage(occurrence)).toEqual({
      body: "Scheduled task finished", tag: "aiqsa-chat-chat-1", title: "Morning brief", url: "/c/chat-1", v: 1
    });
    expect(browserPushMessage({ ...occurrence, chatId: null, reasonCode: "missed", state: "SKIPPED" })).toEqual({
      body: "Scheduled task skipped\nSkipped: the scheduled time passed while runs were unavailable.",
      tag: "aiqsa-scheduled", title: "Morning brief", url: "/scheduled", v: 1
    });
    expect(browserPushMessage({ ...occurrence, reasonCode: "model_unavailable", state: "FAILED", taskPauseReason: "model_unavailable" }).body)
      .toBe("Scheduled task paused\nThe model is no longer available. Choose another model and resume.");
    expect(browserPushMessage({ ...occurrence, reasonCode: "admission_failed", state: "FAILED", trigger: "manual" }).body)
      .toBe("Scheduled task did not complete\nThe run could not start.");
    expect(JSON.stringify(browserPushMessage(occurrence))).not.toContain("owner-1");
    expect(browserPushMessage({ ...occurrence, reasonCode: "update" }).body)
      .toBe("Scheduled task finished\nUpdate: something changed since the last shown result.");
  });

  it("names a few unavailable sources of an incomplete run and counts the rest", () => {
    const source = (name: string) => ({ name, reason: "mcp_reauthorization_required" as const });
    expect(browserPushMessage({ ...occurrence, unavailableSources: [source("Mail")] }).body)
      .toBe("Scheduled task finished\nMail needs sign-in.");
    expect(browserPushMessage({ ...occurrence, unavailableSources: ["A", "B", "C", "D", "E"].map(source) }).body)
      .toBe("Scheduled task finished\nA needs sign-in.\nB needs sign-in.\nC needs sign-in.\n2 more sources are unavailable.");
    expect(browserPushMessage({ ...occurrence, taskPauseReason: "source_unavailable", unavailableSources: [source("Mail")] }).body)
      .toMatch(/^Scheduled task paused\nPaused after 3 runs in a row[^\n]*\nMail needs sign-in\.$/u);
  });

  it("says when a monitoring check paused its task and names what a check could not reach", () => {
    // The third scheduled check in a row without a report paused the task.
    expect(browserPushMessage({ ...occurrence, reasonCode: "unreported", taskPauseReason: "verdict_missing" }).body)
      .toBe("Scheduled task paused\nPaused after three checks in a row did not report whether anything changed. Resume to try again.");
    // A manual check never reports the task's pause as its own outcome.
    expect(browserPushMessage({ ...occurrence, reasonCode: "unreported", taskPauseReason: "verdict_missing", trigger: "manual" }).body)
      .toBe("Scheduled task finished\nShown: the check did not report whether anything changed.");
    expect(browserPushMessage({ ...occurrence, reasonCode: "could_not_check",
      unavailableSources: [{ name: "Tracker", reason: "mcp_server_unavailable" }] }).body)
      .toBe("Scheduled task finished\nCould not check: a source was unavailable.\nTracker is unavailable.");
  });

  it("names an automatic answer review's end once: the reviewed answer, how it stopped, or the failed answer", () => {
    const ended = { answerFailed: false, chatId: "chat-1", kind: "answer_review" as const, rounds: 2, state: "finished" as const,
      stopReason: "max_rounds" as const, title: "Trip plan", userId: "owner-1" };
    expect(browserPushMessage(ended)).toEqual({ body: "Reviewed answer ready · 2 rounds", tag: "aiqsa-chat-chat-1", title: "Trip plan",
      url: "/c/chat-1", v: 1 });
    expect(browserPushMessage({ ...ended, rounds: 1, stopReason: "clean" }).body).toBe("Reviewed answer ready · 1 round");
    expect(browserPushMessage({ ...ended, state: "stopped", stopReason: "budget" }).body)
      .toBe("Answer ready · Stopped: usage limit reached");
    expect(browserPushMessage({ ...ended, stopReason: "disagreement" }).body)
      .toBe("Answer ready · Stopped: the reviewers repeat findings the author rejected");
    expect(browserPushMessage({ ...ended, answerFailed: true, rounds: 0, state: "stopped", stopReason: "error" }).body)
      .toBe("The answer did not complete");
    expect(JSON.stringify(browserPushMessage(ended))).not.toContain("owner-1");
  });

  it("cleans and bounds titles and falls back when empty", () => {
    const long = browserPushMessage({ chatId: "c", kind: "run", status: "complete", title: `A\u0000b\n${"x".repeat(300)}`, userId: "u" });
    expect(long.title.startsWith("A b ")).toBe(true);
    expect([...long.title]).toHaveLength(120);
    expect(long.title.endsWith("…")).toBe(true);
    expect(browserPushMessage({ chatId: "c", kind: "run", status: "complete", title: " \n ", userId: "u" }).title).toBe("AIQSA chat");
  });
});

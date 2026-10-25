import { describe, expect, it } from "vitest";
import { browserPushMessage, connectPushMessage } from "./payload";
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
      body: "Automation finished", tag: "aiqsa-chat-chat-1", title: "Morning brief", url: "/c/chat-1", v: 1
    });
    expect(browserPushMessage({ ...occurrence, chatId: null, reasonCode: "missed", state: "SKIPPED" })).toEqual({
      body: "Automation skipped\nSkipped: the scheduled time passed while runs were unavailable.",
      tag: "aiqsa-scheduled", title: "Morning brief", url: "/scheduled", v: 1
    });
    expect(browserPushMessage({ ...occurrence, reasonCode: "model_unavailable", state: "FAILED", taskPauseReason: "model_unavailable" }).body)
      .toBe("Automation paused\nThe model is no longer available. Choose another model and resume.");
    expect(browserPushMessage({ ...occurrence, reasonCode: "admission_failed", state: "FAILED", trigger: "manual" }).body)
      .toBe("Automation did not complete\nThe run could not start.");
    expect(JSON.stringify(browserPushMessage(occurrence))).not.toContain("owner-1");
    expect(browserPushMessage({ ...occurrence, reasonCode: "update" }).body)
      .toBe("Automation finished\nUpdate: something changed since the last shown result.");
  });

  it("names a few unavailable sources of an incomplete run and counts the rest", () => {
    const source = (name: string) => ({ name, reason: "mcp_reauthorization_required" as const });
    expect(browserPushMessage({ ...occurrence, unavailableSources: [source("Mail")] }).body)
      .toBe("Automation finished\nMail needs sign-in.");
    expect(browserPushMessage({ ...occurrence, unavailableSources: ["A", "B", "C", "D", "E"].map(source) }).body)
      .toBe("Automation finished\nA needs sign-in.\nB needs sign-in.\nC needs sign-in.\n2 more sources are unavailable.");
    expect(browserPushMessage({ ...occurrence, taskPauseReason: "source_unavailable", unavailableSources: [source("Mail")] }).body)
      .toMatch(/^Automation paused\nPaused after 3 runs in a row[^\n]*\nMail needs sign-in\.$/u);
  });

  it("says when a monitoring check paused its task and names what a check could not reach", () => {
    // The third scheduled check in a row without a report paused the task.
    expect(browserPushMessage({ ...occurrence, reasonCode: "unreported", taskPauseReason: "verdict_missing" }).body)
      .toBe("Automation paused\nPaused after three checks in a row did not report whether anything changed. Resume to try again.");
    // A manual check never reports the task's pause as its own outcome.
    expect(browserPushMessage({ ...occurrence, reasonCode: "unreported", taskPauseReason: "verdict_missing", trigger: "manual" }).body)
      .toBe("Automation finished\nShown: the check did not report whether anything changed.");
    expect(browserPushMessage({ ...occurrence, reasonCode: "could_not_check",
      unavailableSources: [{ name: "Tracker", reason: "mcp_server_unavailable" }] }).body)
      .toBe("Automation finished\nCould not check: a source was unavailable.\nTracker is unavailable.");
  });

  it("cleans and bounds titles and falls back when empty", () => {
    const long = browserPushMessage({ chatId: "c", kind: "run", status: "complete", title: `A\u0000b\n${"x".repeat(300)}`, userId: "u" });
    expect(long.title.startsWith("A b ")).toBe(true);
    expect([...long.title]).toHaveLength(120);
    expect(long.title.endsWith("…")).toBe(true);
    expect(browserPushMessage({ chatId: "c", kind: "run", status: "complete", title: " \n ", userId: "u" }).title).toBe("AIQSA chat");
  });

  it("names an AIQSA Connect session that needs its owner with fixed copy and links the session", () => {
    const deviceId = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11";
    expect(connectPushMessage({ deviceId, sessionId: "ac-abc123", sessionTitle: "Fix\u001b[31m build", status: "needs_approval" })).toEqual({
      body: "Needs approval", tag: `aiqsa-connect-${deviceId}-ac-abc123`, title: "Fix [31m build", url: `/connect/${deviceId}/ac-abc123`, v: 1
    });
    expect(connectPushMessage({ deviceId, sessionId: "ac-abc123", sessionTitle: " ", status: "waiting" }))
      .toMatchObject({ body: "Waiting for you", title: "AIQSA Connect" });
    expect([...connectPushMessage({ deviceId, sessionId: "ac-abc123", sessionTitle: "x".repeat(300), status: "waiting" }).title]).toHaveLength(120);
  });
});

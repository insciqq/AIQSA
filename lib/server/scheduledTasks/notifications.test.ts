import { describe, expect, it } from "vitest";
import { normalizeSmtpProductMessage } from "../email/definitions";
import { scheduledTaskResultEmail, type ScheduledTaskNotification } from "./notifications";

const base: ScheduledTaskNotification = {
  chatId: "chat-1", email: "owner@example.test", reasonCode: null, state: "COMPLETED", taskPauseReason: null,
  title: "Утренняя сводка", trigger: "schedule", unavailableSources: []
};

describe("scheduled task result email", () => {
  it("names the task and links its chat without any other content", () => {
    const message = scheduledTaskResultEmail({ ...base, appBaseUrl: "https://aiqsa.example.test/" });
    expect(normalizeSmtpProductMessage(message)).toEqual(message);
    expect(message).toEqual({
      kind: "scheduled_task_result",
      subject: "Automation finished",
      text: "Your AIQSA automation \"Утренняя сводка\" finished.\n\nOpen the automation's chat:\nhttps://aiqsa.example.test/c/chat-1",
      to: "owner@example.test"
    });
  });

  it("states failures, skips and automatic pauses with fixed reason copy", () => {
    const appBaseUrl = "https://aiqsa.example.test";
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "model_run_cancelled", state: "FAILED" }))
      .toMatchObject({ subject: "Automation did not complete", text: expect.stringContaining("Stopped in the chat.") });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, chatId: null, reasonCode: "missed", state: "SKIPPED" }))
      .toMatchObject({ subject: "Automation skipped", text: expect.stringMatching(/Skipped: the scheduled time passed[^\n]*\n\nOpen AIQSA:\nhttps:\/\/aiqsa\.example\.test\/$/u) });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "model_unavailable", state: "FAILED", taskPauseReason: "model_unavailable" }))
      .toMatchObject({ subject: "Automation paused", text: expect.stringContaining("The model is no longer available.") });
    // A manual run never reports the task's pause as its own outcome.
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "run_orphaned", state: "FAILED", taskPauseReason: "model_unavailable",
      trigger: "manual" })).toMatchObject({ subject: "Automation did not complete" });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, title: "Line\u0000one\u007f" }).text).toContain("\"Line one\"");
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "run_deadline", state: "FAILED" }))
      .toMatchObject({ subject: "Automation did not complete", text: expect.stringContaining("Stopped after running for 30 minutes.") });
    // A monitoring check names its outcome.
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "goal_reached" }))
      .toMatchObject({ subject: "Automation finished", text: expect.stringContaining("finished.\nGoal reached — automation completed.\n") });
  });

  it("names the sources an incomplete run could not reach and the pause they caused", () => {
    const appBaseUrl = "https://aiqsa.example.test";
    const unavailableSources = [{ name: "Почта", reason: "mcp_reauthorization_required" }, { name: "Tracker", reason: "mcp_server_unavailable" }] as const;
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, unavailableSources: [...unavailableSources] })).toEqual({
      kind: "scheduled_task_result",
      subject: "Automation finished",
      text: "Your AIQSA automation \"Утренняя сводка\" finished.\nПочта needs sign-in.\nTracker is unavailable.\n\n" +
        "Open the automation's chat:\nhttps://aiqsa.example.test/c/chat-1",
      to: "owner@example.test"
    });
    // The third incomplete run in a row paused the task: its notification says so.
    const paused = scheduledTaskResultEmail({ ...base, appBaseUrl, taskPauseReason: "source_unavailable", unavailableSources: [unavailableSources[0]] });
    expect(paused.subject).toBe("Automation paused");
    expect(paused.text).toContain("could not reach a source the automation uses");
    expect(paused.text).toContain("Почта needs sign-in.");
  });

  it("says when a monitoring check paused its task, and only for the check that did", () => {
    const appBaseUrl = "https://aiqsa.example.test";
    const missing = scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "unreported", taskPauseReason: "verdict_missing" });
    expect(missing.subject).toBe("Automation paused");
    expect(missing.text).toContain("was paused.\nPaused after three checks in a row did not report whether anything changed.");
    // A manual check, or a check that reported, did not cause the pause.
    for (const other of [{ trigger: "manual" as const }, { reasonCode: "update" }]) {
      expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "unreported", taskPauseReason: "verdict_missing", ...other }))
        .toMatchObject({ subject: "Automation finished" });
    }
    // The source alert of a check that could not check names its outcome and the missing source.
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "could_not_check",
      unavailableSources: [{ name: "Tracker", reason: "mcp_server_unavailable" }] }).text)
      .toContain("finished.\nCould not check: a source was unavailable.\nTracker is unavailable.\n");
  });
});

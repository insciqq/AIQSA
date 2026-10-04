import { describe, expect, it } from "vitest";
import { normalizeSmtpProductMessage } from "../email/definitions";
import { scheduledTaskResultEmail, type ScheduledTaskNotification } from "./notifications";

const base: ScheduledTaskNotification = {
  chatId: "chat-1", email: "owner@example.test", reasonCode: null, state: "COMPLETED", taskPauseReason: null,
  title: "Утренняя сводка", trigger: "schedule"
};

describe("scheduled task result email", () => {
  it("names the task and links its chat without any other content", () => {
    const message = scheduledTaskResultEmail({ ...base, appBaseUrl: "https://aiqsa.example.test/" });
    expect(normalizeSmtpProductMessage(message)).toEqual(message);
    expect(message).toEqual({
      kind: "scheduled_task_result",
      subject: "Scheduled task finished",
      text: "Your AIQSA scheduled task \"Утренняя сводка\" finished.\n\nOpen the task's chat:\nhttps://aiqsa.example.test/c/chat-1",
      to: "owner@example.test"
    });
  });

  it("states failures, skips and automatic pauses with fixed reason copy", () => {
    const appBaseUrl = "https://aiqsa.example.test";
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "model_run_cancelled", state: "FAILED" }))
      .toMatchObject({ subject: "Scheduled task did not complete", text: expect.stringContaining("Stopped in the chat.") });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, chatId: null, reasonCode: "missed", state: "SKIPPED" }))
      .toMatchObject({ subject: "Scheduled task skipped", text: expect.stringMatching(/Skipped: the scheduled time passed[^\n]*\n\nOpen AIQSA:\nhttps:\/\/aiqsa\.example\.test\/$/u) });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "model_unavailable", state: "FAILED", taskPauseReason: "model_unavailable" }))
      .toMatchObject({ subject: "Scheduled task paused", text: expect.stringContaining("The model is no longer available.") });
    // A manual run never reports the task's pause as its own outcome.
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, reasonCode: "run_orphaned", state: "FAILED", taskPauseReason: "model_unavailable",
      trigger: "manual" })).toMatchObject({ subject: "Scheduled task did not complete" });
    expect(scheduledTaskResultEmail({ ...base, appBaseUrl, title: "Line\u0000one\u007f" }).text).toContain("\"Line one\"");
  });
});

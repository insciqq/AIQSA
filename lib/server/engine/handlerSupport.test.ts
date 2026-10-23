// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { selfServiceChat } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  it("are interactive personal and temporary chats only", () => {
    expect(selfServiceChat(prepared())).toBe(true);
    expect(selfServiceChat(prepared({ initialChatMode: "TEMPORARY" }))).toBe(true);
    for (const other of [prepared({ project: { projectId: "p" } }), prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } }),
      prepared({}, { answerReviewStep: {} }), prepared({}, { monitoringVerdictTool: true })]) {
      expect(selfServiceChat(other)).toBe(false);
    }
  });

  it("never include a scheduled task's occurrence, which changes nothing of its owner's own", () => {
    expect(selfServiceChat(prepared(), { scheduled: true })).toBe(false);
    expect(selfServiceChat(prepared(), { scheduled: false })).toBe(true);
  });

  it("never include a Telegram turn, whose bridge cannot show their cards", () => {
    expect(selfServiceChat(prepared(), { telegram: true })).toBe(false);
    expect(selfServiceChat(prepared(), { telegram: false })).toBe(true);
  });
});

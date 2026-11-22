import { describe, expect, it } from "vitest";
import { recordingTransaction, type RecordedCall } from "../chatSearch/index/markRecorder.testFixtures";
import { TEMPORARY_CHAT_RETENTION_MS } from "../chats/temporaryRetention";
import { settleTerminalChatSource } from "./prismaRepositoryPreparation";

const OWNER = "owner-1";
const INPUT = { assistantMessageId: "answer-1", chatId: "chat-1", runId: "run-1", status: "complete" as const, userId: OWNER };

const isChatLock = (call: RecordedCall) => call.name === "$queryRaw" && Boolean(call.text?.includes("FROM \"Chat\" WHERE"));
const isMonitoringRead = (call: RecordedCall) => call.name === "$queryRaw" &&
  Boolean(call.text?.includes("monitoringVerdictTool"));

function settlement(chat: Readonly<{ memoryMode: string }> | null, keptChatTime: Date | null = null) {
  return recordingTransaction({
    $queryRaw: (call) => {
      const recorded = call as RecordedCall;
      if (isMonitoringRead(recorded)) return keptChatTime ? [{ updatedAt: keptChatTime }] : [];
      return isChatLock(recorded) && chat ? [chat] : [];
    }
  });
}

describe("a run's terminal write to its chat", () => {
  it.each(["complete", "error", "cancelled"] as const)("marks the chat of a %s answer after locking and touching it", async (status) => {
    const recorder = settlement({ memoryMode: "NORMAL" });

    await settleTerminalChatSource(recorder.tx, { ...INPUT, status });

    const lock = recorder.indexOf(isChatLock);
    const touch = recorder.indexOf((call) => call.name === "chat.update");
    expect(recorder.calls[lock]!.text).toContain("FOR UPDATE");
    expect(recorder.calls[lock]!.values).toEqual(["chat-1", OWNER]);
    expect(recorder.calls[touch]!.args).toMatchObject({ data: { updatedAt: expect.any(Date) }, where: { id: "chat-1" } });
    expect(touch).toBeGreaterThan(lock);
    expect(recorder.indexOf((call) => call.name === "$executeRaw")).toBeGreaterThan(touch);
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining(["chat-1", OWNER]) }]);
  });

  it("moves a Temporary chat's deadline to a day after the answer", async () => {
    const recorder = settlement({ memoryMode: "TEMPORARY" });
    const before = Date.now();

    await settleTerminalChatSource(recorder.tx, INPUT);

    const { data } = recorder.calls.find((call) => call.name === "chat.update")!.args as {
      data: { temporaryRetentionDeadline: Date };
    };
    expect(data.temporaryRetentionDeadline.getTime()).toBeGreaterThanOrEqual(before + TEMPORARY_CHAT_RETENTION_MS);
    expect(recorder.calls.some((call) => call.name.startsWith("memoryDeletionOutbox."))).toBe(false);
  });

  it("keeps a monitoring check's place in the chat list", async () => {
    const kept = new Date("2026-11-01T08:00:00Z");
    const recorder = settlement({ memoryMode: "EXCLUDED" }, kept);

    await settleTerminalChatSource(recorder.tx, INPUT);

    const restore = recorder.calls.find((call) => call.name === "chat.updateMany");
    expect(restore?.args).toMatchObject({ data: { updatedAt: kept }, where: { id: "chat-1" } });
  });

  it("a background sub-agent's run, which has no answer of its own, marks nothing", async () => {
    const recorder = settlement({ memoryMode: "NORMAL" });

    await settleTerminalChatSource(recorder.tx, { ...INPUT, assistantMessageId: null });

    expect(recorder.marks()).toEqual([]);
  });

  it("leaves a chat that is gone or fenced for deletion alone, and the run still settles", async () => {
    const recorder = settlement(null);

    await expect(settleTerminalChatSource(recorder.tx, INPUT)).resolves.toBeUndefined();

    expect(recorder.calls[0]!.text).toContain("\"permanentDeletionAt\" IS NULL");
    expect(recorder.calls.filter((call) => call.name !== "$queryRaw")).toEqual([]);
  });
});

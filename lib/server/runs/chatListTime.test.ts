// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  keepChatListTime,
  monitoringAdmissionChatTime,
  monitoringCheckChatTime,
  moveShownMonitoringCheck
} from "./chatListTime";

type Tx = Prisma.TransactionClient;
const kept = new Date("2026-11-01T08:00:00.000Z");

function sqlOf(query: unknown): string {
  return (query as { sql: string }).sql;
}

describe("a monitoring check's chat time", () => {
  it("is read, under the chat row lock, only for a run whose accepted request marks it a check", async () => {
    const $queryRaw = vi.fn(async () => [{ updatedAt: kept }]);
    await expect(monitoringCheckChatTime({ $queryRaw } as unknown as Tx, { chatId: "chat-1", runId: "run-1" })).resolves.toEqual(kept);
    const sql = sqlOf(($queryRaw.mock.calls as unknown[][])[0]![0]);
    expect(sql).toContain(`"normalizedRequest" -> 'monitoringVerdictTool' = 'true'::jsonb`);
    expect(sql).toContain("FOR UPDATE OF chat");
    // Any other run, or a run of another chat, keeps nothing.
    await expect(monitoringCheckChatTime({ $queryRaw: vi.fn(async () => []) } as unknown as Tx, { chatId: "chat-1", runId: "run-2" }))
      .resolves.toBeNull();
  });

  it("is the chat's own at admission, or the rotated-from chat's when the check opens the month's new chat", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { id: string } }) =>
      ({ "chat-new": { updatedAt: new Date("2026-11-01T00:00:05.000Z") }, "chat-old": { updatedAt: kept } })[where.id] ?? null);
    const tx = { chat: { findFirst } } as unknown as Tx;
    await expect(monitoringAdmissionChatTime(tx, { chatId: "chat-new", rotatedFromChatId: "chat-old", userId: "owner" }))
      .resolves.toEqual(kept);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "chat-old", permanentDeletionAt: null, userId: "owner" }
    }));
    await expect(monitoringAdmissionChatTime(tx, { chatId: "chat-new", userId: "owner" }))
      .resolves.toEqual(new Date("2026-11-01T00:00:05.000Z"));
    // A rotated-from chat that is gone leaves the new chat its own time.
    await expect(monitoringAdmissionChatTime(tx, { chatId: "chat-new", rotatedFromChatId: "chat-gone", userId: "owner" }))
      .resolves.toEqual(new Date("2026-11-01T00:00:05.000Z"));
  });

  it("is put back explicitly, so the write itself does not move the chat", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await keepChatListTime({ chat: { updateMany } } as unknown as Tx, "chat-1", kept);
    expect(updateMany).toHaveBeenCalledWith({ data: { updatedAt: kept }, where: { id: "chat-1" } });
  });

  it("moves to the settlement time when a check of this occurrence is shown, never back and never another run's chat", async () => {
    const now = new Date("2026-11-08T10:00:00.000Z");
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn(async () => ({ chatId: "chat-1" }));
    const tx = { chat: { updateMany }, modelRun: { findFirst } } as unknown as Tx;
    await moveShownMonitoringCheck(tx, { now, occurrenceId: "occurrence-1", runId: "run-1", userId: "owner" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "run-1", normalizedRequest: { equals: true, path: ["monitoringVerdictTool"] }, scheduledOccurrenceId: "occurrence-1",
      userId: "owner"
    } }));
    expect(updateMany).toHaveBeenCalledWith({ data: { updatedAt: now },
      where: { id: "chat-1", permanentDeletionAt: null, updatedAt: { lt: now }, userId: "owner" } });

    // A standard task's run moved its chat with its own writes: settlement leaves it.
    findFirst.mockResolvedValueOnce(null as unknown as { chatId: string });
    updateMany.mockClear();
    await moveShownMonitoringCheck(tx, { now, occurrenceId: "occurrence-2", runId: "run-2", userId: "owner" });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

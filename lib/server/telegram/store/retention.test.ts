import { describe, expect, it, vi } from "vitest";
import { deleteExpiredTelegramRecords, TELEGRAM_PRUNE_BATCH_ROWS } from "./retention";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY = 24 * 3_600_000;

function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join("?").replace(/\s+/gu, " ");
}

describe("Telegram record retention", () => {
  it("deletes each table's expired rows in bounded batches with its own cutoff", async () => {
    const counts = [TELEGRAM_PRUNE_BATCH_ROWS, 3, 0, 1, 0, 2];
    const executeRaw = vi.fn(async () => counts.shift() ?? 0);
    await expect(deleteExpiredTelegramRecords({ $executeRaw: executeRaw } as never, NOW)).resolves.toBe(TELEGRAM_PRUNE_BATCH_ROWS + 6);
    const calls = executeRaw.mock.calls as unknown[][];
    expect(calls).toHaveLength(6);
    expect(sqlOf(calls[0]!)).toContain(`DELETE FROM "TelegramLinkCode"`);
    expect(sqlOf(calls[1]!)).toContain(`DELETE FROM "TelegramLinkCode"`);
    expect(calls[0]!.slice(1)).toEqual([new Date(NOW.getTime() - DAY), new Date(NOW.getTime() - DAY), TELEGRAM_PRUNE_BATCH_ROWS]);
    expect(sqlOf(calls[2]!)).toContain(`DELETE FROM "TelegramUpdateReceipt"`);
    expect(calls[2]![1]).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(sqlOf(calls[3]!)).toContain(`DELETE FROM "TelegramCallback"`);
    expect(calls[3]![1]).toEqual(new Date(NOW.getTime() - DAY));
    expect(sqlOf(calls[4]!)).toContain(`DELETE FROM "TelegramMessageRef"`);
    expect(calls[4]![1]).toEqual(new Date(NOW.getTime() - 90 * DAY));
    expect(sqlOf(calls[5]!)).toContain(`DELETE FROM "TelegramScheduledDelivery"`);
    expect(sqlOf(calls[5]!)).toContain(`"state" <> 'pending'`);
    expect(calls[5]![1]).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });

  it("tries every table when one fails, then reports the first failure", async () => {
    const executeRaw = vi.fn(async () => 0)
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce(4);
    await expect(deleteExpiredTelegramRecords({ $executeRaw: executeRaw } as never, NOW)).rejects.toThrow("lock timeout");
    expect(executeRaw).toHaveBeenCalledTimes(5);
  });
});

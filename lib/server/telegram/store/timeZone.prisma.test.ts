// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaTelegramTimeZoneStore, TELEGRAM_TIME_ZONE_RUN_WINDOW } from "./timeZone";

/**
 * The browser time zone a Telegram run reuses, read from the user's own
 * newest accepted runs on a disposable database. Rows belong to this file's
 * synthetic accounts and are removed after each test.
 */

const NOW = Date.parse("2026-10-19T08:00:00.000Z");
const users: string[] = [];
const store = createPrismaTelegramTimeZoneStore(prisma);

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

async function owner() {
  const user = await prisma.user.create({ data: {
    displayName: "Synthetic Telegram zone", email: `telegram-zone-${randomUUID()}@example.test`, status: "active"
  } });
  users.push(user.id);
  const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId: user.id } });
  return { chatId: chat.id, userId: user.id };
}

async function run(
  account: Readonly<{ chatId: string; userId: string }>, minutesAgo: number, baseline: Record<string, string> | null,
  scheduledTaskId?: string
) {
  const question = await prisma.message.create({ data: { chatId: account.chatId, content: textMessageContent("synthetic"), role: "user" } });
  await prisma.modelRun.create({ data: {
    chatId: account.chatId, createdAt: new Date(NOW - minutesAgo * 60_000), modelId: "fixture",
    normalizedRequest: baseline ? { prompt: { baseline } } : {}, provider: "fake", status: "complete",
    ...(scheduledTaskId ? { scheduledTaskId } : {}), userId: account.userId, userMessageId: question.id
  } });
}

const client = (timeZone: string) => ({ source: "standard_chat", timeZone, timeZoneSource: "client" });
const fallback = { source: "standard_chat", timeZone: "UTC", timeZoneSource: "utc_fallback" };

describe("Telegram run time zone (stateful)", () => {
  it("uses the owner's newest browser zone, skipping UTC fallbacks, scheduled-task zones and other users' runs", async () => {
    const alex = await owner();
    const other = await owner();
    await run(alex, 30, client("Europe/Moscow"));
    await run(alex, 20, fallback);
    // A scheduled run carries its task's zone (a plain id: the column has no relation).
    await run(alex, 10, client("America/New_York"), `synthetic-task-${randomUUID()}`);
    await run(alex, 5, null);
    await run(other, 1, client("Asia/Tokyo"));
    await expect(store.latestClientTimeZone(alex.userId)).resolves.toBe("Europe/Moscow");
    await expect(store.latestClientTimeZone(other.userId)).resolves.toBe("Asia/Tokyo");
    await run(alex, 1, { source: "assistant_chat", timeZone: "Asia/Yerevan", timeZoneSource: "client" });
    await expect(store.latestClientTimeZone(alex.userId)).resolves.toBe("Asia/Yerevan");
  });

  it("looks no further back than its window and knows no zone for a user without runs", async () => {
    const alex = await owner();
    await run(alex, TELEGRAM_TIME_ZONE_RUN_WINDOW + 10, client("Europe/Moscow"));
    for (let index = 0; index < TELEGRAM_TIME_ZONE_RUN_WINDOW; index += 1) {
      await run(alex, TELEGRAM_TIME_ZONE_RUN_WINDOW - index, fallback);
    }
    await expect(store.latestClientTimeZone(alex.userId)).resolves.toBeNull();
    await expect(store.latestClientTimeZone((await owner()).userId)).resolves.toBeNull();
  });
});

// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { readFailureStreakLoad } from "./failureStreaks";

// Every row belongs to this file's own users; only they are removed. The
// window lies decades back at a random minute, so no other run falls in it.
const OWNERS = [`failure-streaks-a-${randomUUID()}`, `failure-streaks-b-${randomUUID()}`];
const BASE = new Date(Date.UTC(2002, 2, 4, 5, Math.floor(Math.random() * 600)));
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: OWNERS } } });
  await prisma.$disconnect();
});

type Run = Readonly<{ chat: number; minutes: number; status: "error" | "cancelled" | "complete" | "streaming"; code?: string }>;

describe("failure streaks on PostgreSQL", () => {
  it("finds consecutive failed or cancelled runs of one user in one chat, longest first, without content", async () => {
    const chats: Array<{ chatId: string; messageId: string; userId: string }> = [];
    for (const [index, id] of OWNERS.entries()) {
      await prisma.user.create({ data: { displayName: "Failure streaks owner", id, status: "active" } });
      for (let chat = 0; chat < (index === 0 ? 2 : 1); chat += 1) {
        const created = await prisma.chat.create({ data: { title: "Private streak title", userId: id } });
        const message = await prisma.message.create({
          data: { chatId: created.id, content: textMessageContent("Private streak prompt"), role: "user", status: "complete" }
        });
        chats.push({ chatId: created.id, messageId: message.id, userId: id });
      }
    }
    // Chat 0 (owner A): three failures end at a completed run, then two more stay short of a streak.
    // Chat 1 (owner A): four failures in a row up to the window's end, a run in flight between them.
    // Chat 2 (owner B): three in a row, then a completed run; one more failure falls before the window.
    const runs: Run[] = [
      { chat: 0, minutes: 1, status: "error", code: "provider_server_error" },
      { chat: 0, minutes: 2, status: "cancelled" },
      { chat: 0, minutes: 3, status: "error", code: "provider_server_error" },
      { chat: 0, minutes: 4, status: "complete" },
      { chat: 0, minutes: 5, status: "error", code: "provider_server_error" },
      { chat: 0, minutes: 6, status: "error", code: "provider_server_error" },
      { chat: 1, minutes: 10, status: "error", code: "agent_provider_failed" },
      { chat: 1, minutes: 11, status: "error", code: "agent_provider_failed" },
      { chat: 1, minutes: 12, status: "streaming" },
      { chat: 1, minutes: 13, status: "error" },
      { chat: 1, minutes: 14, status: "error", code: "agent_provider_failed" },
      { chat: 2, minutes: -5, status: "error", code: "provider_server_error" },
      { chat: 2, minutes: 20, status: "error", code: "context_too_large" },
      { chat: 2, minutes: 21, status: "error", code: "context_too_large" },
      { chat: 2, minutes: 22, status: "cancelled" },
      { chat: 2, minutes: 23, status: "complete" }
    ];
    const ids: string[] = [];
    for (const run of runs) {
      const owner = chats[run.chat]!;
      const id = randomUUID();
      ids.push(id);
      await prisma.modelRun.create({
        data: {
          id, chatId: owner.chatId, userId: owner.userId, userMessageId: owner.messageId, provider: "streak-provider",
          modelId: "streak-model", status: run.status, createdAt: at(run.minutes), normalizedRequest: {},
          ...(run.status === "error"
            ? { errorPayload: run.code === undefined ? { message: "Private failure detail" } : { code: run.code, message: "Private failure detail" } }
            : {})
        }
      });
    }

    const load = await readFailureStreakLoad(prisma, { from: at(0), to: at(60), limit: 10, runsPerStreak: 2 });
    expect(load).toEqual({ streaks: 3, users: 2, longest: 4, truncated: false, rows: [
      { userId: OWNERS[0], runs: 4, failed: 4, cancelled: 0, firstAt: at(10), lastAt: at(14), ongoing: true,
        codes: [{ code: "agent_provider_failed", runs: 3 }, { code: null, runs: 1 }], newestRunIds: [ids[10], ids[9]] },
      { userId: OWNERS[1], runs: 3, failed: 2, cancelled: 1, firstAt: at(20), lastAt: at(22), ongoing: false,
        codes: [{ code: "context_too_large", runs: 2 }], newestRunIds: [ids[14], ids[13]] },
      { userId: OWNERS[0], runs: 3, failed: 2, cancelled: 1, firstAt: at(1), lastAt: at(3), ongoing: false,
        codes: [{ code: "provider_server_error", runs: 2 }], newestRunIds: [ids[2], ids[1]] }
    ] });
    expect(JSON.stringify(load)).not.toMatch(/Private/u);

    const own = await readFailureStreakLoad(prisma, { from: at(0), to: at(60), limit: 1, runsPerStreak: 5, userId: OWNERS[1] });
    expect(own).toMatchObject({ streaks: 1, users: 1, longest: 3, truncated: false, rows: [{ userId: OWNERS[1], runs: 3 }] });
    const cut = await readFailureStreakLoad(prisma, { from: at(0), to: at(60), limit: 1, runsPerStreak: 1 });
    expect(cut).toMatchObject({ streaks: 3, truncated: true, rows: [{ runs: 4, newestRunIds: [ids[10]] }] });
    await expect(readFailureStreakLoad(prisma, { from: at(-60), to: at(-30), limit: 10, runsPerStreak: 2 }))
      .resolves.toEqual({ streaks: 0, users: 0, longest: 0, rows: [], truncated: false });
  });
});

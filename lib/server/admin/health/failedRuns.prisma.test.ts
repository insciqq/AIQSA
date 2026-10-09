// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { readFailedRunLoad } from "./failedRuns";

// Every row belongs to this file's own users; only they are removed. The
// window lies decades back at a random minute, so no other run falls in it.
const OWNERS = [`failed-runs-a-${randomUUID()}`, `failed-runs-b-${randomUUID()}`];
const BASE = new Date(Date.UTC(2001, 1, 3, 4, Math.floor(Math.random() * 600)));
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: OWNERS } } });
  await prisma.$disconnect();
});

describe("failed runs on PostgreSQL", () => {
  it("counts failed runs of the window by code and user, without stops, refused input or content", async () => {
    const chats = [];
    for (const id of OWNERS) {
      await prisma.user.create({ data: { displayName: "Failed runs owner", id, status: "active" } });
      const chat = await prisma.chat.create({ data: { title: "Private failed-run title", userId: id } });
      const message = await prisma.message.create({
        data: { chatId: chat.id, content: textMessageContent("Private failed-run prompt"), role: "user", status: "complete" }
      });
      chats.push({ chatId: chat.id, messageId: message.id, userId: id });
    }
    const runs: Array<{ owner: number; minutes: number; status: "error" | "cancelled" | "complete"; code?: string | null }> = [
      { owner: 0, minutes: 5, status: "error", code: "provider_server_error" },
      { owner: 1, minutes: 10, status: "error", code: "provider_server_error" },
      { owner: 1, minutes: 15, status: "error", code: "provider_server_error" },
      { owner: 0, minutes: 20, status: "error", code: null },
      { owner: 0, minutes: 25, status: "error", code: "context_too_large" },
      { owner: 0, minutes: 30, status: "cancelled" },
      { owner: 1, minutes: 35, status: "complete" },
      // Outside the window on both sides.
      { owner: 0, minutes: -5, status: "error", code: "provider_server_error" },
      { owner: 0, minutes: 60, status: "error", code: "provider_server_error" }
    ];
    const ids: string[] = [];
    for (const run of runs) {
      const owner = chats[run.owner]!;
      const id = randomUUID();
      ids.push(id);
      await prisma.modelRun.create({
        data: {
          id, chatId: owner.chatId, userId: owner.userId, userMessageId: owner.messageId, provider: "failed-runs-provider",
          modelId: "failed-runs-model", status: run.status, createdAt: at(run.minutes), normalizedRequest: {},
          ...(run.status === "error"
            ? { errorPayload: run.code === null ? { message: "Private failure detail" } : { code: run.code, message: "Private failure detail" } }
            : {})
        }
      });
    }

    const load = await readFailedRunLoad(prisma, { from: at(0), to: at(60), perCode: 2, groupLimit: 10 });
    expect(load).toEqual({ runs: 4, users: 2, groupsTruncated: false, groups: [
      { code: "provider_server_error", runs: 3, users: 2, firstAt: at(5), lastAt: at(15), newest: [
        { runId: ids[2], userId: OWNERS[1], startedAt: at(15) },
        { runId: ids[1], userId: OWNERS[1], startedAt: at(10) }
      ] },
      { code: null, runs: 1, users: 1, firstAt: at(20), lastAt: at(20), newest: [{ runId: ids[3], userId: OWNERS[0], startedAt: at(20) }] }
    ] });
    expect(JSON.stringify(load)).not.toMatch(/Private/u);

    const cut = await readFailedRunLoad(prisma, { from: at(0), to: at(60), perCode: 1, groupLimit: 1 });
    expect(cut).toMatchObject({ runs: 4, users: 2, groupsTruncated: true, groups: [{ code: "provider_server_error", runs: 3 }] });
    expect(cut.groups[0]!.newest).toHaveLength(1);

    await expect(readFailedRunLoad(prisma, { from: at(-60), to: at(-30), perCode: 2, groupLimit: 10 }))
      .resolves.toEqual({ runs: 0, users: 0, groups: [], groupsTruncated: false });
  });
});

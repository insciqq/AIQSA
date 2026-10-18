// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { readModelRunLoad } from "./modelRuns";

// Every row belongs to this file's own user and provider rows; only they are
// removed. The window lies decades back at a random minute, so no other run
// falls in it.
const MARK = `model-runs-${randomUUID()}`;
const OWNER = `${MARK}-owner`;
const CONNECTION = `${MARK}-conn`;
const MODELS = [`${MARK}-model-a`, `${MARK}-model-b`];
const BASE = new Date(Date.UTC(2003, 3, 5, 6, Math.floor(Math.random() * 600)));
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: OWNER } });
  await prisma.providerModel.deleteMany({ where: { connectionId: CONNECTION } });
  await prisma.providerConnection.deleteMany({ where: { id: CONNECTION } });
  await prisma.$disconnect();
});

describe("runs by model on PostgreSQL", () => {
  it("counts every run of the window once per answer connection and model, with its failure codes and no content", async () => {
    await prisma.providerConnection.create({ data: { displayName: "Model runs connection", family: `${MARK}-family`, id: CONNECTION } });
    for (const id of MODELS) {
      await prisma.providerModel.create({ data: { capabilities: {}, connectionId: CONNECTION, defaultParams: {}, displayName: id, id,
        modelId: `${id}/upstream`, provider: `${MARK}-family` } });
    }
    await prisma.user.create({ data: { displayName: "Model runs owner", id: OWNER, status: "active" } });
    const chat = await prisma.chat.create({ data: { title: "Private model-runs title", userId: OWNER } });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: textMessageContent("Private model-runs prompt"), role: "user", status: "complete" }
    });
    const runs: Array<{ model: number | null; minutes: number; status: "error" | "cancelled" | "complete" | "queued"; code?: string }> = [
      { model: 0, minutes: 1, status: "complete" },
      { model: 0, minutes: 2, status: "complete" },
      { model: 0, minutes: 3, status: "error", code: "provider_server_error" },
      { model: 0, minutes: 4, status: "error", code: "provider_server_error" },
      { model: 0, minutes: 5, status: "error", code: "agent_provider_failed" },
      { model: 0, minutes: 6, status: "error", code: "context_too_large" },
      { model: 0, minutes: 7, status: "cancelled" },
      { model: 0, minutes: 8, status: "queued" },
      { model: 1, minutes: 9, status: "complete" },
      { model: null, minutes: 10, status: "error" },
      // Outside the window.
      { model: 0, minutes: -5, status: "error", code: "provider_server_error" }
    ];
    for (const run of runs) {
      const id = randomUUID();
      await prisma.modelRun.create({
        data: {
          id, chatId: chat.id, userId: OWNER, userMessageId: message.id, provider: `${MARK}-family`, modelId: "model-runs-model",
          status: run.status, createdAt: at(run.minutes), normalizedRequest: {},
          ...(run.status === "error"
            ? { errorPayload: run.code === undefined ? { message: "Private failure detail" } : { code: run.code, message: "Private failure detail" } }
            : {})
        }
      });
      if (run.model !== null) {
        await prisma.providerRunBinding.create({ data: { connectionId: CONNECTION, credentialSource: "default", executionSnapshot: {},
          modelRunId: id, providerModelId: MODELS[run.model]!, role: "answer" } });
      }
    }

    const load = await readModelRunLoad(prisma, { from: at(0), to: at(60), limit: 10, codesPerModel: 1 });
    expect(load).toEqual({ truncated: false, rows: [
      { connectionId: CONNECTION, providerModelId: MODELS[0], accepted: 8, completed: 2, failed: 3, refusedInput: 1, cancelled: 1, open: 1,
        users: 1, lastFailedAt: at(5), codes: [{ code: "provider_server_error", runs: 2 }] },
      { connectionId: null, providerModelId: null, accepted: 1, completed: 0, failed: 1, refusedInput: 0, cancelled: 0, open: 0, users: 1,
        lastFailedAt: at(10), codes: [{ code: null, runs: 1 }] },
      { connectionId: CONNECTION, providerModelId: MODELS[1], accepted: 1, completed: 1, failed: 0, refusedInput: 0, cancelled: 0, open: 0,
        users: 1, lastFailedAt: null, codes: [] }
    ] });
    expect(JSON.stringify(load)).not.toMatch(/Private/u);
    await expect(readModelRunLoad(prisma, { from: at(0), to: at(60), limit: 1, codesPerModel: 5 }))
      .resolves.toMatchObject({ truncated: true, rows: [{ providerModelId: MODELS[0], codes: [{ runs: 2 }, { runs: 1 }] }] });
  });
});

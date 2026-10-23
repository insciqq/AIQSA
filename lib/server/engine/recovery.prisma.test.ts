import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createNativeRunStore } from "./runStore";
import { createNativeOrphanFinder, NATIVE_RUN_INTERRUPTED, reconcileNativeRuns } from "./recovery";
import { createTranscriptRepository } from "./transcriptRepository";

// Long before any other fixture: only the runs this file backdates are older than the boundary.
const BACKDATED = new Date("2001-02-03T04:05:06.000Z");
const BOOTED = new Date("2001-02-04T04:05:06.000Z");

const owners: string[] = [];
const repository = createPrismaRunRepository(prisma);
const transcripts = createTranscriptRepository(prisma);

async function owner(): Promise<string> {
  const userId = `native-recovery-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Native recovery test", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

async function activeRun(userId: string, engine: "native" | "v1", options: Readonly<{ backdated?: boolean; published?: boolean }> = {}) {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
    title: "Recovery", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Q"), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Partial work"),
    parentMessageId: question.id, role: "assistant", status: options.published ? "complete" : "streaming" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  // Only a preparing run lacks its normalized request (ModelRun_memory_request_shape_check).
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine, modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status: "streaming", userId, userMessageId: question.id,
    ...(options.published ? { answerCompletedAt: new Date() } : {}),
    ...(options.backdated ? { createdAt: BACKDATED, updatedAt: BACKDATED } : {}) } });
  return { answerId: answer.id, chatId: chat.id, runId: run.id };
}

function recovery(live: readonly string[] = []) {
  return { bootedAt: BOOTED, findOrphans: createNativeOrphanFinder(prisma), liveRunIds: () => live, repository,
    runs: createNativeRunStore(prisma) };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("native run recovery on the database", () => {
  it("interrupts an orphaned native run with its transcript and text kept, and never touches the old core's", async () => {
    const userId = await owner();
    const native = await activeRun(userId, "native", { backdated: true });
    const oldCore = await activeRun(userId, "v1", { backdated: true });
    await transcripts.append({ chatId: native.chatId, runId: native.runId, userId }, 0,
      [{ id: randomUUID(), kind: "assistant_text", text: "Partial work" }]);
    await expect(reconcileNativeRuns(recovery(), { userId })).resolves.toBe(1);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: native.runId } })).resolves.toMatchObject({
      errorPayload: expect.objectContaining({ code: NATIVE_RUN_INTERRUPTED.code }), status: "error" });
    await expect(prisma.message.findUniqueOrThrow({ where: { id: native.answerId } })).resolves.toMatchObject({
      content: textMessageContent("Partial work"), errorMessage: NATIVE_RUN_INTERRUPTED.message, status: "error" });
    await expect(prisma.runTranscriptItem.count({ where: { modelRunId: native.runId } })).resolves.toBe(1);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: oldCore.runId } })).resolves.toMatchObject({ status: "streaming" });
  });

  it("leaves a native run this process executes, and a fresh one, alone", async () => {
    const userId = await owner();
    const live = await activeRun(userId, "native", { backdated: true });
    const fresh = await activeRun(userId, "native");
    await expect(reconcileNativeRuns(recovery([live.runId]), { userId })).resolves.toBe(0);
    for (const run of [live, fresh]) {
      await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).resolves.toMatchObject({ status: "streaming" });
    }
  });

  it("completes an orphaned native run whose answer was published", async () => {
    const userId = await owner();
    const published = await activeRun(userId, "native", { backdated: true, published: true });
    await expect(reconcileNativeRuns(recovery(), { userId })).resolves.toBe(1);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: published.runId } })).resolves.toMatchObject({ status: "complete" });
  });
});

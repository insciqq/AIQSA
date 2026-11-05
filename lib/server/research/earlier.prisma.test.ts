import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type ResearchFrame, type ResearchRecordInput } from "../../contracts/research";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createResearchEarlier, createResearchEarlierStore } from "./earlier";
import { createResearchEvidenceRepository } from "./evidenceRepository";
import type { ResearchRunScope } from "./ports";

/**
 * What a new research reads of earlier research, on PostgreSQL: the released frames and the cited records of its own branch's earlier runs, this user's in this
 * chat only. A run on a sibling branch, another user's run and another chat's run give nothing, even when their ids are asked for. `earlier.test.ts` proves which
 * runs the items name, and what a run does with what this gives.
 */
const owners: string[] = [];
const signal = new AbortController().signal;
const repository = createResearchEvidenceRepository(prisma);

async function owner(): Promise<string> {
  const userId = `research-earlier-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Research earlier test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

async function chatOf(userId: string): Promise<string> {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Research", userId } });
  return chat.id;
}

type Run = Readonly<{ answerId: string; chatId: string; runId: string; userId: string }>;

/** A native run answering a question under `parentMessageId`, settled, as an earlier run of a chat is. */
async function runOf(userId: string, chatId: string, parentMessageId?: string): Promise<Run> {
  const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"), ...(parentMessageId ? { parentMessageId } : {}),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic report"), parentMessageId: question.id, role: "assistant", status: "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: { deepResearch: true },
    provider: "fake", status: "complete", userId, userMessageId: question.id } });
  return { answerId: answer.id, chatId, runId: run.id, userId };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

const frameOf = (label: string): ResearchFrame => ({ branches: [], changes: [], criteria: [{ criterion: "Price", key: "price", why: "The budget decides." }],
  rows: [{ key: "pick", label }] });

/** A research released on `run`'s row, with one finding for its pick, as a finished research leaves them. */
async function researched(run: Run, label: string): Promise<string> {
  await prisma.researchFrame.create({ data: { answer: json({}), chatId: run.chatId, frame: json(frameOf(label)), goal: "Choose a mattress.", modelRunId: run.runId,
    proposal: json({}), releasedAt: new Date(), userId: run.userId, windowEndsAt: new Date() } });
  const record: ResearchRecordInput = { claim: `${label} costs 20 000 ₽.`, criterionKey: "price", kind: "finding", quote: "20 000 ₽", rowKey: "pick",
    sourceClass: "action_channel", standing: "confirmed", supersedes: null, url: `https://shop.example/${encodeURIComponent(label)}` };
  const written = await repository.append({ chatId: run.chatId, researchRunId: run.runId, userId: run.userId }, { author: { name: "shops", threadId: "thread-shops" },
    chain: [run.runId], page: null, quoteCheck: { kept: { reason: null, status: "found" }, notKept: null }, record, sourceQuality: { publishedOn: null, registrableDomain: "shop.example", textGroupKey: null } });
  if (written.kind !== "recorded") throw new Error(`refused: ${written.code}`);
  return written.record.id;
}

const scopeOf = (run: Run, branchRunIds: readonly string[]) =>
  ({ branchRunIds, chatId: run.chatId, now: () => Date.now(), researchRunId: run.runId, runId: run.runId, userId: run.userId }) as unknown as ResearchRunScope;

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("what a new research reads of earlier research", () => {
  it("reads its branch's earlier researches, this user's in this chat, and nothing of a sibling branch, another user or another chat", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    // Two researches on one branch, and a sibling branch beside the second.
    const first = await runOf(userId, chatId);
    const second = await runOf(userId, chatId, first.answerId);
    const sibling = await runOf(userId, chatId, first.answerId);
    const firstRecord = await researched(first, "Askona Balance Forma");
    const secondRecord = await researched(second, "Lonax Memory");
    const siblingRecord = await researched(sibling, "Optima Classic");
    // Another user's research, and this user's in another chat.
    const otherUser = await owner();
    const theirs = await runOf(otherUser, await chatOf(otherUser));
    const theirRecord = await researched(theirs, "Their Mattress");
    const elsewhere = await runOf(userId, await chatOf(userId));
    const elsewhereRecord = await researched(elsewhere, "Elsewhere Mattress");
    // The new research's run, after the second on its branch.
    const current = await runOf(userId, chatId, second.answerId);

    const port = createResearchEarlier({ store: createResearchEarlierStore(prisma) })(scopeOf(current, [first.runId, second.runId]));
    const read = await port.read({ recordIds: [firstRecord, secondRecord, siblingRecord, theirRecord, elsewhereRecord],
      researchRunIds: [first.runId, second.runId, sibling.runId, theirs.runId, elsewhere.runId, current.runId] }, signal);
    expect(new Map([...read.frames].map(([runId, frame]) => [runId, frame.rows[0]!.label]))).toEqual(new Map([[first.runId, "Askona Balance Forma"],
      [second.runId, "Lonax Memory"]]));
    expect(read.records.map(({ id, rowKey, runId, url }) => ({ id, rowKey, runId, url })).sort((one, other) => one.url!.localeCompare(other.url!))).toEqual([
      { id: firstRecord, rowKey: "pick", runId: first.runId, url: "https://shop.example/Askona%20Balance%20Forma" },
      { id: secondRecord, rowKey: "pick", runId: second.runId, url: "https://shop.example/Lonax%20Memory" }]);
    expect(read.records.every(({ createdAt, kind }) => kind === "finding" && Number.isFinite(Date.parse(createdAt)))).toBe(true);

    // The store itself keys every read by the owner and the chat, whatever ids it is handed.
    const store = createResearchEarlierStore(prisma);
    await expect(store.frames({ chatId, userId: otherUser }, [first.runId, second.runId])).resolves.toEqual([]);
    await expect(store.frames({ chatId: elsewhere.chatId, userId }, [first.runId])).resolves.toEqual([]);
    await expect(store.records({ chatId, userId: otherUser }, { ids: [firstRecord], runIds: [first.runId] })).resolves.toEqual([]);
    await expect(store.records({ chatId, userId }, { ids: [theirRecord, elsewhereRecord], runIds: [theirs.runId, elsewhere.runId] })).resolves.toEqual([]);
  });

  it("leaves out a research whose plan was never released", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const first = await runOf(userId, chatId);
    await prisma.researchFrame.create({ data: { chatId, goal: "Choose a mattress.", modelRunId: first.runId, proposal: json({}), userId, windowEndsAt: new Date() } });
    const current = await runOf(userId, chatId, first.answerId);
    const read = await createResearchEarlier({ store: createResearchEarlierStore(prisma) })(scopeOf(current, [first.runId]))
      .read({ recordIds: [], researchRunIds: [first.runId] }, signal);
    expect(read.frames.size).toBe(0);
  });
});

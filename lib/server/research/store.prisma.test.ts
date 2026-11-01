import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RESEARCH_PAGE_LIMITS } from "../../contracts/research";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";

/**
 * The research store's tables on PostgreSQL: what goes with a run, a chat and an account, what a Continue's rows keep when
 * the earlier run goes, and what the keys and checks refuse whatever the application does.
 */
const owners: string[] = [];
const LINK = "https://lab.example/x1";
const FRAME = { branches: [], changes: [], criteria: [{ criterion: "Firmness", key: "firmness", why: "It holds the back." }], rows: [] };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function owner(): Promise<string> {
  const userId = `research-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Research test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

async function chatOf(userId: string): Promise<string> {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Research", userId } });
  return chat.id;
}

/** A question answered by a native run, under `parentMessageId`. */
async function runOf(userId: string, chatId: string, parentMessageId?: string): Promise<Readonly<{ answerId: string; chatId: string; runId: string; userId: string }>> {
  const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"), ...(parentMessageId ? { parentMessageId } : {}),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
    status: "complete", userId, userMessageId: question.id } });
  return { answerId: answer.id, chatId, runId: run.id, userId };
}

type Run = Awaited<ReturnType<typeof runOf>>;

const keys = (run: Run) => ({ chatId: run.chatId, modelRunId: run.runId, userId: run.userId });

function frameOf(run: Run, data: Readonly<{ continuedFromRunId?: string }> = {}) {
  return prisma.researchFrame.create({ data: { ...keys(run), ...data, goal: "Choose a mattress." } });
}

function pageOf(run: Run, text = "The X1 held up after 10 years.") {
  return prisma.researchPage.create({ data: { ...keys(run), contentHash: sha256(text), linkHash: sha256(LINK), obtainedBy: "tool", sizeBytes: Buffer.byteLength(text), text, url: LINK } });
}

function findingOf(run: Run, sequence: number, data: Readonly<{ pageId?: string; supersedesId?: string }> = {}) {
  return prisma.researchEvidence.create({ data: { ...keys(run), ...data, claim: "The X1 holds up.", kind: "finding", quote: "held up after 10 years", quoteCheck: "found", sequence,
    sourceClass: "independent_tests", standing: "confirmed", url: LINK } });
}

/** One research run's rows of each table. */
async function researched(run: Run) {
  await frameOf(run);
  const page = await pageOf(run);
  await findingOf(run, 0, { pageId: page.id });
}

const rowsOf = async (run: Run) => ({
  evidence: await prisma.researchEvidence.count({ where: { modelRunId: run.runId } }),
  frames: await prisma.researchFrame.count({ where: { modelRunId: run.runId } }),
  pages: await prisma.researchPage.count({ where: { modelRunId: run.runId } })
});

const NONE = { evidence: 0, frames: 0, pages: 0 };
const ONE_OF_EACH = { evidence: 1, frames: 1, pages: 1 };

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("deleting what research belongs to", () => {
  it("removes a chat's evidence, pages and frame, and leaves another chat's", async () => {
    const userId = await owner();
    const deleted = await runOf(userId, await chatOf(userId));
    const kept = await runOf(userId, await chatOf(userId));
    await researched(deleted);
    await researched(kept);
    // As `lib/server/chats/permanentDeletion/cleanup.ts` deletes a chat: its runs, then the chat.
    await prisma.modelRun.deleteMany({ where: { chatId: deleted.chatId } });
    await prisma.chat.delete({ where: { id: deleted.chatId } });
    await expect(rowsOf(deleted)).resolves.toEqual(NONE);
    await expect(rowsOf(kept)).resolves.toEqual(ONE_OF_EACH);
  });

  it("removes a deleted answer's rows with its run, as deleting a message or a branch does", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const deleted = await runOf(userId, chatId);
    const kept = await runOf(userId, chatId);
    await researched(deleted);
    await researched(kept);
    await prisma.modelRun.deleteMany({ where: { id: deleted.runId } });
    await expect(rowsOf(deleted)).resolves.toEqual(NONE);
    await expect(rowsOf(kept)).resolves.toEqual(ONE_OF_EACH);
  });

  it("removes them with the account", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    await researched(run);
    await prisma.user.deleteMany({ where: { id: userId } });
    await expect(rowsOf(run)).resolves.toEqual(NONE);
  });
});

describe("a Continue's rows", () => {
  it("name the earlier run's, and when that run goes they lose only the reference, and keep what is their own", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const earlier = await runOf(userId, chatId);
    const later = await runOf(userId, chatId, earlier.answerId);
    await frameOf(earlier);
    const page = await pageOf(earlier);
    const record = await findingOf(earlier, 0, { pageId: page.id });
    await frameOf(later, { continuedFromRunId: earlier.runId });
    const correction = await findingOf(later, 0, { pageId: page.id, supersedesId: record.id });
    await expect(prisma.researchFrame.findUniqueOrThrow({ where: { modelRunId: later.runId }, include: { continuedFrom: true } }))
      .resolves.toMatchObject({ continuedFrom: { modelRunId: earlier.runId } });

    await prisma.modelRun.deleteMany({ where: { id: earlier.runId } });

    await expect(rowsOf(earlier)).resolves.toEqual(NONE);
    await expect(prisma.researchFrame.findUniqueOrThrow({ where: { modelRunId: later.runId } })).resolves.toMatchObject({ chatId, continuedFromRunId: null, userId });
    await expect(prisma.researchEvidence.findUniqueOrThrow({ where: { id: correction.id } })).resolves.toMatchObject({ chatId, pageId: null, supersedesId: null, userId });
  });

  it("go together with the earlier run when one deletion takes both", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const earlier = await runOf(userId, chatId);
    const later = await runOf(userId, chatId, earlier.answerId);
    await researched(earlier);
    await frameOf(later, { continuedFromRunId: earlier.runId });
    await findingOf(later, 0);
    await prisma.modelRun.deleteMany({ where: { chatId } });
    await expect(rowsOf(earlier)).resolves.toEqual(NONE);
    await expect(rowsOf(later)).resolves.toEqual(NONE);
  });
});

describe("the keys carry the owner and the chat", () => {
  it("refuse a row bound to another user's or another chat's run", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    const otherChat = await runOf(userId, await chatOf(userId));
    const otherUserId = await owner();
    const otherUser = await runOf(otherUserId, await chatOf(otherUserId));
    await expect(frameOf({ ...run, chatId: otherChat.chatId })).rejects.toThrow();
    await expect(frameOf({ ...run, userId: otherUserId })).rejects.toThrow();
    await expect(pageOf({ ...run, chatId: otherChat.chatId })).rejects.toThrow();
    await expect(findingOf({ ...run, userId: otherUser.userId }, 0)).rejects.toThrow();
  });

  it("refuse a link, a correction or a page of another chat or another user, so a Continue there can reach nothing", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    const otherChat = await runOf(userId, await chatOf(userId));
    const otherUserId = await owner();
    const otherUser = await runOf(otherUserId, await chatOf(otherUserId));
    await researched(otherChat);
    await researched(otherUser);
    const otherPage = await prisma.researchPage.findFirstOrThrow({ where: { modelRunId: otherChat.runId } });
    const foreignRecord = await prisma.researchEvidence.findFirstOrThrow({ where: { modelRunId: otherUser.runId } });
    await expect(frameOf(run, { continuedFromRunId: otherChat.runId })).rejects.toThrow();
    await expect(frameOf(run, { continuedFromRunId: otherUser.runId })).rejects.toThrow();
    await expect(findingOf(run, 0, { pageId: otherPage.id })).rejects.toThrow();
    await expect(findingOf(run, 0, { supersedesId: foreignRecord.id })).rejects.toThrow();
  });

  it("refuse a link to a run with no frame: the link names research, never any run", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const run = await runOf(userId, chatId);
    const ordinary = await runOf(userId, chatId);
    await expect(frameOf(run, { continuedFromRunId: ordinary.runId })).rejects.toThrow();
    await expect(frameOf(run, { continuedFromRunId: run.runId })).rejects.toThrow();
  });
});

describe("what the database refuses", () => {
  it("keeps a run's order and one correction per record", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    const record = await findingOf(run, 0);
    await expect(findingOf(run, 0)).rejects.toThrow();
    await findingOf(run, 1, { supersedesId: record.id });
    await expect(findingOf(run, 2, { supersedesId: record.id })).rejects.toThrow();
  });

  it("holds each kind to its own fields, and a page to its bound and its size", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), kind: "guess", sequence: 0 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), kind: "finding", sequence: 0 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), kind: "not_found", reason: "Nowhere.", rowKey: "x1", sequence: 0 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), kind: "dataset", sequence: 0 } })).rejects.toThrow();
    await prisma.researchEvidence.create({ data: { ...keys(run), criterionKey: "firmness", kind: "not_found", reason: "Nowhere.", rowKey: "x1", sequence: 0 } });
    await prisma.researchEvidence.create({ data: { ...keys(run), kind: "unreachable", reason: "It asks to sign in.", sequence: 1, target: "shop.example" } });
    const big = "x".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage + 1);
    const page = { ...keys(run), contentHash: sha256("x"), linkHash: sha256(LINK), obtainedBy: "tool", url: LINK };
    await expect(prisma.researchPage.create({ data: { ...page, sizeBytes: Buffer.byteLength(big), text: big } })).rejects.toThrow();
    await expect(prisma.researchPage.create({ data: { ...page, sizeBytes: 2, text: "x" } })).rejects.toThrow();
    await expect(prisma.researchPage.create({ data: { ...page, obtainedBy: "hearsay", sizeBytes: 1, text: "x" } })).rejects.toThrow();
    await expect(prisma.researchPage.create({ data: { ...page, contentHash: "abc", sizeBytes: 1, text: "x" } })).rejects.toThrow();
    await prisma.researchPage.create({ data: { ...page, sizeBytes: 1, text: "x" } });
    await expect(prisma.researchPage.create({ data: { ...page, sizeBytes: 1, text: "x" } })).rejects.toThrow();
  });

  it("releases a plan only with its proposal, its answer and its frame, all at once", async () => {
    const userId = await owner();
    const run = await runOf(userId, await chatOf(userId));
    const opened = { proposal: { understood: "A mattress." }, windowEndsAt: new Date() };
    const answer = { changed: false, plan: {}, released_by: "timer" };
    await frameOf(run);
    const where = { modelRunId: run.runId };
    await expect(prisma.researchFrame.update({ data: { windowEndsAt: new Date() }, where })).rejects.toThrow();
    await expect(prisma.researchFrame.update({ data: { heldUntil: new Date() }, where })).rejects.toThrow();
    await prisma.researchFrame.update({ data: opened, where });
    await expect(prisma.researchFrame.update({ data: { releasedAt: new Date() }, where })).rejects.toThrow();
    await expect(prisma.researchFrame.update({ data: { answer, releasedAt: new Date() }, where })).rejects.toThrow();
    await prisma.researchFrame.update({ data: { answer, frame: FRAME, releasedAt: new Date() }, where });
  });
});

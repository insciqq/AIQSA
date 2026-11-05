import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RESEARCH_EVIDENCE_LIMITS, RESEARCH_PAGE_LIMITS, type ResearchAgentRef, type ResearchRecordInput } from "../../contracts/research";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createSubagentThreadStore } from "../engine/subagents/threadStore";
import { prisma } from "../prisma";
import { createResearchEvidenceRepository } from "./evidenceRepository";
import { createResearchEvidenceStore } from "./evidenceStore";
import type { ResearchEvidencePort, ResearchRunScope } from "./ports";

/**
 * The evidence store on PostgreSQL: what one research reads, across runs and owners, how a Continue reaches earlier records, and that
 * `sequence` and the bounds hold when parallel researchers write at once. `store.prisma.test.ts` proves the tables themselves.
 */
const owners: string[] = [];
const LINK = "https://lab.example/x1";
const QUOTE = "held up after 10 years";
const PAGE = `The X1 ${QUOTE} of use.`;
const LAB: ResearchAgentRef = { name: "lab", threadId: "thread-lab" };
const SHOP: ResearchAgentRef = { name: "shop", threadId: "thread-shop" };
const MAIN: ResearchAgentRef = { name: null, threadId: null };
const signal = new AbortController().signal;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function owner(): Promise<string> {
  const userId = `research-evidence-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Research evidence test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

async function chatOf(userId: string): Promise<string> {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Research", userId } });
  return chat.id;
}

type Run = Readonly<{ answerId: string; chatId: string; questionId: string; runId: string; userId: string }>;

/** A question answered by a native run, under `parentMessageId`. */
async function runOf(userId: string, chatId: string, parentMessageId?: string): Promise<Run> {
  const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"), ...(parentMessageId ? { parentMessageId } : {}),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
    status: "complete", userId, userMessageId: question.id } });
  return { answerId: answer.id, chatId, questionId: question.id, runId: run.id, userId };
}

const newRun = async () => {
  const userId = await owner();
  return runOf(userId, await chatOf(userId));
};

const keys = (run: Run) => ({ chatId: run.chatId, modelRunId: run.runId, userId: run.userId });

function storeOf(run: Run, overrides: Partial<ResearchRunScope> = {}): ResearchEvidencePort {
  const scope = { branchRunIds: [], chatId: run.chatId, researchRunId: run.runId, runId: run.runId, userId: run.userId, ...overrides } as unknown as ResearchRunScope;
  return createResearchEvidenceStore({ repository: createResearchEvidenceRepository(prisma), savedResults: { read: async () => null }, threads: createSubagentThreadStore(prisma) })(scope);
}

const finding = (quote = QUOTE, url = LINK, supersedes: string | null = null): ResearchRecordInput => ({ claim: "The X1 holds up.", criterionKey: "firmness", kind: "finding", quote, rowKey: "x1",
  sourceClass: "independent_tests", standing: "confirmed", supersedes, url });
const notFound: ResearchRecordInput = { criterionKey: "firmness", kind: "not_found", reason: "Nowhere.", rowKey: "x1", sourceClass: null, supersedes: null };

let calls = 0;

/** A settled `fetch_url` call, as its batch leaves it. */
function fetched(run: Run, threadId: string | null, url = LINK, text = PAGE) {
  calls += 1;
  const providerCallId = `call-${calls}`;
  return prisma.modelRunToolCall.create({ data: { arguments: { url }, completedAt: new Date(), modelRunId: run.runId, ordinal: calls, providerCallId, result: { callId: providerCallId,
    content: [{ type: "json", value: { contentType: "html", fetchedAt: new Date().toISOString(), finalUrl: url, note: "Untrusted.", text, title: null, truncated: false, url } }],
    name: "fetch_url", status: "complete" }, roundIndex: 1, startedAt: new Date(), state: "complete", subagentThreadId: threadId, toolName: "fetch_url" } });
}

/** What a browser command printed, as its call's row keeps it. */
function printed(run: Run, threadId: string | null, text: string) {
  calls += 1;
  const providerCallId = `call-${calls}`;
  const toolName = "mcp__workspace__sandbox_shell";
  return prisma.modelRunToolCall.create({ data: { arguments: { command: "aiqsa-browser text" }, completedAt: new Date(), modelRunId: run.runId, ordinal: calls, providerCallId,
    result: { callId: providerCallId, content: [{ text, type: "text" }], name: toolName, status: "complete" }, roundIndex: 1, startedAt: new Date(), state: "complete", subagentThreadId: threadId, toolName } });
}

async function recorded(port: ResearchEvidencePort, record: ResearchRecordInput, author = LAB) {
  const written = await port.record({ author, record }, signal);
  if (written.kind !== "recorded") throw new Error(`refused: ${written.code}`);
  return written.record;
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("what a research reads", () => {
  it("is its own: another run's, chat's or user's records and pages read as nothing", async () => {
    const run = await newRun();
    const sameChat = await runOf(run.userId, run.chatId);
    const otherChat = await runOf(run.userId, await chatOf(run.userId));
    const stranger = await newRun();
    await fetched(run, LAB.threadId);
    const record = await recorded(storeOf(run), finding());
    for (const other of [sameChat, otherChat, stranger]) {
      await expect(storeOf(other).records(signal)).resolves.toEqual([]);
      await expect(storeOf(other).page(record.pageId!, signal)).resolves.toBeNull();
    }
    await expect(storeOf(run).records(signal)).resolves.toEqual([expect.objectContaining({ id: record.id, pageId: record.pageId })]);
    await expect(storeOf(run).page(record.pageId!, signal)).resolves.toMatchObject({ obtainedBy: "tool", text: PAGE, url: LINK });
  });

  it("is the same for every agent of the run, and one correction never lowers what stands", async () => {
    const run = await newRun();
    await fetched(run, LAB.threadId);
    await fetched(run, null);
    const wrong = await recorded(storeOf(run), finding("broke after a year"));
    expect(wrong.quoteCheck).toEqual({ reason: null, status: "not_verbatim" });
    await recorded(storeOf(run), notFound, SHOP);
    const right = await recorded(storeOf(run), finding(QUOTE, LINK, wrong.id), MAIN);
    expect(right).toMatchObject({ quoteCheck: { status: "found" }, supersedes: wrong.id });
    const live = await storeOf(run).records(signal);
    expect(live.map((record) => record.sequence)).toEqual([1, 2]);
    expect(live.map((record) => record.author)).toEqual([SHOP, MAIN]);
    await expect(prisma.researchEvidence.count({ where: keys(run) })).resolves.toBe(3);
    await expect(prisma.researchPage.count({ where: keys(run) })).resolves.toBe(1);
  });

  it("refuses a correction of another chat's or user's record as one that does not exist", async () => {
    const run = await newRun();
    const stranger = await newRun();
    const otherChat = await runOf(run.userId, await chatOf(run.userId));
    const theirs = await recorded(storeOf(stranger), notFound);
    const elsewhere = await recorded(storeOf(otherChat), notFound);
    for (const supersedes of [theirs.id, elsewhere.id, randomUUID()]) {
      await expect(storeOf(run).record({ author: LAB, record: { ...notFound, supersedes } }, signal)).resolves.toMatchObject({ code: "research_record_unknown", kind: "refused" });
    }
    await expect(prisma.researchEvidence.count({ where: keys(run) })).resolves.toBe(0);
  });
});

describe("what a write reads of its agent", () => {
  it("takes only the writer's own page, and a browser's under the link it cites", async () => {
    const run = await newRun();
    await fetched(run, SHOP.threadId);
    await printed(run, LAB.threadId, `[browser #1] open @ lab.example/x1\n${PAGE}`);
    await expect(recorded(storeOf(run), finding())).resolves.toMatchObject({ quoteCheck: { reason: null, status: "found" } });
    await expect(prisma.researchPage.findFirstOrThrow({ where: keys(run) })).resolves.toMatchObject({ obtainedBy: "browser", url: LINK });
    await expect(recorded(storeOf(run), finding(), MAIN)).resolves.toMatchObject({ pageId: null, quoteCheck: { status: "unsupported" } });
  });

  it("appends an approval continuation to the run that started the research, and reaches what its agent read there", async () => {
    const started = await newRun();
    const continued = await runOf(started.userId, started.chatId, started.answerId);
    await fetched(started, null);
    const port = storeOf(continued, { branchRunIds: [started.runId], researchRunId: started.runId });
    const record = await recorded(port, finding(), MAIN);
    expect(record).toMatchObject({ quoteCheck: { status: "found" }, runId: started.runId, sequence: 0 });
    await expect(storeOf(started).records(signal)).resolves.toEqual([expect.objectContaining({ id: record.id })]);
    await expect(prisma.researchEvidence.count({ where: keys(continued) })).resolves.toBe(0);
  });

  it("reaches a background child's own run", async () => {
    const run = await newRun();
    const thread = await prisma.subagentThread.create({ data: { anchorRunId: run.runId, chatId: run.chatId, name: "child", userId: run.userId } });
    const call = await prisma.modelRunToolCall.create({ data: { arguments: { background: true }, modelRunId: run.runId, ordinal: 0, providerCallId: "subagent-call", roundIndex: 0, state: "running",
      toolName: "call_subagent" } });
    const turn = await prisma.subagentTurn.create({ data: { chatId: run.chatId, mode: "background", modelId: "fake-qsa", parentRunId: run.runId, parentToolCallId: call.id, provider: "fake",
      threadId: thread.id, userId: run.userId } });
    const background = await prisma.modelRun.create({ data: { chatId: run.chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "streaming",
      subagentThreadId: thread.id, subagentTurnId: turn.id, userId: run.userId, userMessageId: run.questionId } });
    await fetched({ ...run, runId: background.id }, thread.id);
    await expect(recorded(storeOf(run), finding(), { name: "child", threadId: thread.id })).resolves.toMatchObject({ quoteCheck: { status: "found" }, runId: run.runId });
  });
});

describe("a rating (operator decision 2026-11-05)", () => {
  const CARD = "https://clinic.example/doctors/ivanova";
  const CARD_PAGE = "Иванова Анна, дерматолог. Рейтинг 4,9 · 1 284 отзыва пациентов.";
  const rating = { count: 1_284, counted: "reviews" as const, scaleMax: 5, score: 4.9, variantsMerged: false };
  const rated: ResearchRecordInput = { claim: "Пациенты оценивают Иванову на 4,9 из 5 по 1 284 отзывам.", criterionKey: "ratings", kind: "finding",
    quote: "Рейтинг 4,9 · 1 284 отзыва пациентов", rating, rowKey: "ivanova", sourceClass: "owner_reviews", standing: "confirmed", supersedes: null, url: CARD };

  it("is kept with its finding in a column of its own and read back with it, and a finding with none reads as before", async () => {
    const run = await newRun();
    await fetched(run, LAB.threadId, CARD, CARD_PAGE);
    await fetched(run, LAB.threadId);
    const record = await recorded(storeOf(run), rated);
    expect(record).toMatchObject({ kind: "finding", quoteCheck: { reason: null, status: "found" }, rating });
    await expect(prisma.researchEvidence.findFirstOrThrow({ select: { dataset: true, rating: true }, where: { ...keys(run), id: record.id } }))
      .resolves.toEqual({ dataset: null, rating: { count: 1_284, counted: "reviews", scale_max: 5, score: 4.9, variants_merged: false } });
    const plain = await recorded(storeOf(run), finding());
    await expect(prisma.researchEvidence.findFirstOrThrow({ select: { rating: true }, where: { ...keys(run), id: plain.id } })).resolves.toEqual({ rating: null });
    const live = await storeOf(run).records(signal);
    expect(live).toEqual([expect.objectContaining({ id: record.id, rating }), expect.objectContaining({ id: plain.id })]);
    expect(live[1]).not.toHaveProperty("rating");
  });

  it("is refused by the database on any record but a finding, and as anything but one object", async () => {
    const run = await newRun();
    const document = { count: 1_284, counted: "reviews", scale_max: 5, score: 4.9, variants_merged: false };
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), criterionKey: "ratings", kind: "not_found", rating: document, reason: "Nowhere.", rowKey: "ivanova",
      sequence: 0 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...keys(run), kind: "unreachable", rating: document, reason: "It asks to sign in.", target: "clinic.example",
      sequence: 1 } })).rejects.toThrow();
    const finding = { ...keys(run), claim: "Rated 4.9.", kind: "finding", quote: "Рейтинг 4,9", quoteCheck: "found", sourceClass: "owner_reviews", standing: "confirmed", url: CARD };
    await expect(prisma.researchEvidence.create({ data: { ...finding, rating: [document], sequence: 2 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...finding, rating: 4.9, sequence: 3 } })).rejects.toThrow();
    await expect(prisma.researchEvidence.create({ data: { ...finding, rating: document, sequence: 4 } })).resolves.toMatchObject({ rating: document });
    await expect(prisma.researchEvidence.count({ where: keys(run) })).resolves.toBe(1);
  });
});

describe("a Continue", () => {
  it("reaches the earlier run's records and pages, corrects them, and stops at the bound", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const earlier = await runOf(userId, chatId);
    const later = await runOf(userId, chatId, earlier.answerId);
    await prisma.researchFrame.create({ data: { ...keys(earlier), goal: "Choose a mattress." } });
    await prisma.researchFrame.create({ data: { ...keys(later), continuedFromRunId: earlier.runId, goal: "Choose a mattress." } });
    await fetched(earlier, LAB.threadId);
    const first = await recorded(storeOf(earlier), finding());
    const kept = await recorded(storeOf(earlier), notFound);
    const port = storeOf(later);
    const correction = await recorded(port, finding(QUOTE, LINK, first.id));
    expect(correction).toMatchObject({ quoteCheck: { status: "found" }, runId: later.runId, sequence: 0 });
    const live = await port.records(signal);
    expect(live.map((record) => record.id)).toEqual([kept.id, correction.id]);
    await expect(port.page(first.pageId!, signal)).resolves.toMatchObject({ text: PAGE });
    await expect(storeOf(earlier).records(signal)).resolves.toEqual([expect.objectContaining({ id: first.id }), expect.objectContaining({ id: kept.id })]);
  });

  it("walks no further than the bound", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const runs: Run[] = [];
    for (let index = 0; index < RESEARCH_EVIDENCE_LIMITS.continuationChain + 2; index += 1) {
      const run = await runOf(userId, chatId, runs.at(-1)?.answerId);
      await prisma.researchFrame.create({ data: { ...keys(run), ...runs.length > 0 ? { continuedFromRunId: runs.at(-1)!.runId } : {}, goal: "Choose a mattress." } });
      await recorded(storeOf(run), notFound);
      runs.push(run);
    }
    const read = await storeOf(runs.at(-1)!).records(signal);
    expect(read.map((record) => record.runId)).toEqual(runs.slice(-(RESEARCH_EVIDENCE_LIMITS.continuationChain + 1)).map((run) => run.runId));
  });
});

describe("parallel researchers", () => {
  it("keep one order with no gap or repeat", async () => {
    const run = await newRun();
    const written = await Promise.all(Array.from({ length: 16 }, async (_, index) => recorded(storeOf(run), notFound, index % 2 === 0 ? LAB : SHOP)));
    expect(written.map((record) => record.sequence).sort((one, other) => one - other)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    const read = await storeOf(run).records(signal);
    expect(read.map((record) => record.sequence)).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });

  it("stop at the record bound exactly, and each one past it hears so", async () => {
    const run = await newRun();
    await prisma.researchEvidence.createMany({ data: Array.from({ length: RESEARCH_EVIDENCE_LIMITS.recordsPerRun - 3 }, (_, sequence) => ({ ...keys(run), criterionKey: "firmness", kind: "not_found",
      reason: "Nowhere.", rowKey: "x1", sequence })) });
    const written = await Promise.all(Array.from({ length: 8 }, () => storeOf(run).record({ author: LAB, record: notFound }, signal)));
    expect(written.filter((entry) => entry.kind === "recorded")).toHaveLength(3);
    expect(written.filter((entry) => entry.kind === "refused" && entry.code === "research_records_full")).toHaveLength(5);
    await expect(prisma.researchEvidence.count({ where: keys(run) })).resolves.toBe(RESEARCH_EVIDENCE_LIMITS.recordsPerRun);
  });

  it("stop at the page bound exactly, and no finding is lost past it", async () => {
    const run = await newRun();
    const texts = Array.from({ length: 6 }, (_, index) => `Page ${index}: ${PAGE}`);
    await Promise.all(texts.map((text, index) => fetched(run, LAB.threadId, `https://lab.example/${index}`, text)));
    await prisma.researchPage.createMany({ data: Array.from({ length: RESEARCH_PAGE_LIMITS.pagesPerRun - 2 }, (_, index) => ({ ...keys(run), contentHash: sha256(`text-${index}`), linkHash: sha256(`link-${index}`),
      obtainedBy: "tool", sizeBytes: 1, text: "x", url: `https://lab.example/filler/${index}` })) });
    const written = await Promise.all(texts.map((_, index) => recorded(storeOf(run), finding(QUOTE, `https://lab.example/${index}`))));
    expect(written.filter((record) => record.pageId !== null)).toHaveLength(2);
    expect(written.filter((record) => record.pageId === null).map((record) => record.quoteCheck)).toEqual(Array.from({ length: 4 }, () => ({ reason: "page_not_stored", status: "not_checked" })));
    await expect(prisma.researchPage.count({ where: keys(run) })).resolves.toBe(RESEARCH_PAGE_LIMITS.pagesPerRun);
    await expect(prisma.researchEvidence.count({ where: keys(run) })).resolves.toBe(6);
  });

  it("stop at the bytes of a run too, counted over what is stored", async () => {
    const run = await newRun();
    const room = 100;
    const text = (index: number) => `${index} ${PAGE}`;
    await fetched(run, LAB.threadId, "https://lab.example/a", text(1));
    await fetched(run, LAB.threadId, "https://lab.example/b", text(2));
    const fill = Math.floor((RESEARCH_PAGE_LIMITS.bytesPerRun - room) / RESEARCH_PAGE_LIMITS.bytesPerPage);
    const filler = "x".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage);
    const rest = "x".repeat(RESEARCH_PAGE_LIMITS.bytesPerRun - room - fill * RESEARCH_PAGE_LIMITS.bytesPerPage);
    await prisma.researchPage.create({ data: { ...keys(run), contentHash: sha256("rest"), linkHash: sha256("rest"), obtainedBy: "tool", sizeBytes: rest.length, text: rest, url: "https://lab.example/rest" } });
    for (let index = 0; index < fill; index += 1) {
      await prisma.researchPage.create({ data: { ...keys(run), contentHash: sha256(`text-${index}`), linkHash: sha256(`link-${index}`), obtainedBy: "tool", sizeBytes: filler.length, text: filler,
        url: `https://lab.example/filler/${index}` } });
    }
    await expect(recorded(storeOf(run), finding(QUOTE, "https://lab.example/a"))).resolves.toMatchObject({ quoteCheck: { status: "found" } });
    await expect(recorded(storeOf(run), finding(QUOTE, "https://lab.example/b"))).resolves.toMatchObject({ pageId: expect.any(String) });
    const third = "y".repeat(room);
    await fetched(run, LAB.threadId, "https://lab.example/c", `${QUOTE} ${third}`);
    await expect(recorded(storeOf(run), finding(QUOTE, "https://lab.example/c"))).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "page_not_stored", status: "not_checked" } });
  });

  it("keep one copy of a page they all read", async () => {
    const run = await newRun();
    await fetched(run, LAB.threadId);
    await fetched(run, SHOP.threadId);
    const written = await Promise.all(Array.from({ length: 8 }, (_, index) => recorded(storeOf(run), finding(), index % 2 === 0 ? LAB : SHOP)));
    expect(new Set(written.map((record) => record.pageId)).size).toBe(1);
    await expect(prisma.researchPage.count({ where: keys(run) })).resolves.toBe(1);
  });

  it("get one correction of a record, and the others hear it", async () => {
    const run = await newRun();
    const wrong = await recorded(storeOf(run), notFound);
    const written = await Promise.all(Array.from({ length: 6 }, () => storeOf(run).record({ author: SHOP, record: { ...notFound, supersedes: wrong.id } }, signal)));
    expect(written.filter((entry) => entry.kind === "recorded")).toHaveLength(1);
    expect(written.filter((entry) => entry.kind === "refused" && entry.code === "research_record_corrected")).toHaveLength(5);
    await expect(storeOf(run).records(signal)).resolves.toHaveLength(1);
  });

  it("hear it when another branch's Continue corrected the same record first, whose record still stands here", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const earlier = await runOf(userId, chatId);
    const one = await runOf(userId, chatId, earlier.answerId);
    const other = await runOf(userId, chatId, earlier.answerId);
    await prisma.researchFrame.create({ data: { ...keys(earlier), goal: "Choose a mattress." } });
    await prisma.researchFrame.create({ data: { ...keys(one), continuedFromRunId: earlier.runId, goal: "Choose a mattress." } });
    await prisma.researchFrame.create({ data: { ...keys(other), continuedFromRunId: earlier.runId, goal: "Choose a mattress." } });
    const record = await recorded(storeOf(earlier), notFound);
    await recorded(storeOf(one), { ...notFound, supersedes: record.id });
    await expect(storeOf(other).record({ author: LAB, record: { ...notFound, supersedes: record.id } }, signal)).resolves.toMatchObject({ code: "research_record_corrected", kind: "refused" });
    await expect(storeOf(other).records(signal)).resolves.toEqual([expect.objectContaining({ id: record.id })]);
  });
});

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  decodeResearchPlanProposal,
  RESEARCH_EVIDENCE_LIMITS,
  researchFrameFromPlan,
  researchPlanAnswerDocument,
  researchPlanProposalDocument,
  type ResearchAgentRef,
  type ResearchRecordInput
} from "../../contracts/research";
import { RUN_INTERRUPTED_FAILURE, RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createSubagentThreadStore } from "../engine/subagents/threadStore";
import { prisma } from "../prisma";
import { createResearchEvidenceRepository } from "./evidenceRepository";
import { createResearchEvidenceStore } from "./evidenceStore";
import { createResearchCoverage, createResearchFrameStore, researchFilledCells } from "./matrix";
import { proposalArguments } from "./planWindow.testFixtures";
import type { ResearchRunScope } from "./ports";
import { createResearchResume, createResearchResumeStore } from "./resume";

/**
 * A Continue on PostgreSQL: a run interrupted with its records, continued and interrupted again, loses no cell and has none researched from nothing;
 * another user's or another branch's Continue gets nothing, and the plain cases pick nothing up. `resume.test.ts` proves what a run does with what this gives.
 */
const owners: string[] = [];
const GOAL = "Choose a mattress.";
const LINK = "https://lab.example/x1";
const QUOTE = "held up after 10 years";
const PAGE = `The X1 ${QUOTE} of use.`;
const LAB: ResearchAgentRef = { name: "lab", threadId: "thread-lab" };
const signal = new AbortController().signal;

const decoded = decodeResearchPlanProposal({ ...proposalArguments({ questions: [{ question: "Which mattress holds up?", sites: [],
  source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }] }),
  criteria: [{ criterion: "Firmness", key: "firmness", why: "It holds the back." }, { criterion: "Durability", key: "durability", why: "It is bought for years." }],
  rows: [{ key: "x1", label: "X1" }, { key: "x2", label: "X2" }] });
if (!decoded.ok) throw new Error(decoded.message);
const PROPOSAL = decoded.value;
const ALL_CELLS = ["x1/durability", "x1/firmness", "x2/durability", "x2/firmness"];

async function owner(): Promise<string> {
  const userId = `research-resume-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Research resume test user", id: userId, status: "active",
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
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "complete" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
    status: "complete", userId, userMessageId: question.id } });
  return { answerId: answer.id, chatId, runId: run.id, userId };
}

const keys = (run: Run) => ({ chatId: run.chatId, modelRunId: run.runId, userId: run.userId });

const json = (value: unknown) => value as Prisma.InputJsonValue;

const interrupted = (run: Run, failure: Readonly<{ code: string; message: string }> = RUN_INTERRUPTED_FAILURE) =>
  prisma.modelRun.update({ data: { errorPayload: json(failure), status: "error" }, where: { id: run.runId } });

/** A plan released on `run`'s own row, as the window leaves it. */
const released = (run: Run) => prisma.researchFrame.create({ data: { ...keys(run), answer: json(researchPlanAnswerDocument({ changed: false, plan: PROPOSAL, releasedBy: "timer" })),
  frame: json(researchFrameFromPlan(PROPOSAL)), goal: GOAL, proposal: json(researchPlanProposalDocument(PROPOSAL)), releasedAt: new Date(), windowEndsAt: new Date() } });

function scopeOf(run: Run, branchRunIds: readonly string[]): ResearchRunScope {
  return { branchRunIds, chatId: run.chatId, now: () => Date.now(), researchRunId: run.runId, runId: run.runId, userId: run.userId } as unknown as ResearchRunScope;
}

const repository = createResearchEvidenceRepository(prisma);

/** The real ports of a run, as `defaultNativeEngineDeps` wires them. */
function portsOf(run: Run, branchRunIds: readonly string[] = []) {
  const scope = scopeOf(run, branchRunIds);
  const evidence = createResearchEvidenceStore({ repository, savedResults: { read: async () => null }, threads: createSubagentThreadStore(prisma) })(scope);
  return { coverage: createResearchCoverage({ store: createResearchFrameStore(prisma) })(scope, { evidence }), evidence,
    resume: createResearchResume({ store: createResearchResumeStore(prisma, repository) })(scope) };
}

let calls = 0;

/** A settled `fetch_url` call, as its batch leaves it. */
function fetched(run: Run, threadId: string | null) {
  calls += 1;
  const providerCallId = `call-${calls}`;
  return prisma.modelRunToolCall.create({ data: { arguments: { url: LINK }, completedAt: new Date(), modelRunId: run.runId, ordinal: calls, providerCallId, result: { callId: providerCallId,
    content: [{ type: "json", value: { contentType: "html", fetchedAt: new Date().toISOString(), finalUrl: LINK, note: "Untrusted.", text: PAGE, title: null, truncated: false, url: LINK } }],
    name: "fetch_url", status: "complete" }, roundIndex: 1, startedAt: new Date(), state: "complete", subagentThreadId: threadId, toolName: "fetch_url" } });
}

const finding = (rowKey: string, criterionKey: string, supersedes: string | null = null): ResearchRecordInput => ({ claim: "The X1 holds up.", criterionKey, kind: "finding", quote: QUOTE, rowKey,
  sourceClass: "independent_tests", standing: "confirmed", supersedes, url: LINK });
const notFound = (rowKey: string, criterionKey: string): ResearchRecordInput => ({ criterionKey, kind: "not_found", reason: "Nowhere.", rowKey, sourceClass: null, supersedes: null });

async function recorded(ports: ReturnType<typeof portsOf>, record: ResearchRecordInput) {
  const written = await ports.evidence.record({ author: LAB, record }, signal);
  if (written.kind !== "recorded") throw new Error(`refused: ${written.code}`);
  return written.record;
}

/** What a Continue's start does: it asks, and with something to pick up writes the row. */
async function pickUp(ports: ReturnType<typeof portsOf>, fromRunId: string) {
  const state = await ports.resume.load(fromRunId, signal);
  if (state) await ports.resume.link(state, signal);
  return state;
}

async function filled(ports: ReturnType<typeof portsOf>): Promise<readonly string[]> {
  const coverage = await ports.coverage.coverage(signal);
  return coverage ? [...researchFilledCells(coverage)].sort() : [];
}

/** A run interrupted with two of its four cells filled, a finding on a stored page and a cell recorded as nothing found. */
async function interruptedWithRecords() {
  const userId = await owner();
  const chatId = await chatOf(userId);
  const first = await runOf(userId, chatId);
  await released(first);
  await fetched(first, LAB.threadId);
  const ports = portsOf(first);
  const record = await recorded(ports, finding("x1", "firmness"));
  await recorded(ports, notFound("x1", "durability"));
  await interrupted(first);
  return { chatId, first, record, userId };
}

const noRow = async (run: Run) => expect(prisma.researchFrame.count({ where: { modelRunId: run.runId } })).resolves.toBe(0);

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("a Continue on an interrupted run", () => {
  it("loses no cell and researches none again, through a second interruption", async () => {
    const { chatId, first, record, userId } = await interruptedWithRecords();

    const second = await runOf(userId, chatId, first.answerId);
    const secondPorts = portsOf(second, [first.runId]);
    await expect(filled(secondPorts)).resolves.toEqual([]);
    await expect(pickUp(secondPorts, first.runId)).resolves.toMatchObject({ answer: { plan: { understood: PROPOSAL.understood } }, fromRunId: first.runId, goal: GOAL });
    await expect(filled(secondPorts)).resolves.toEqual(["x1/durability", "x1/firmness"]);
    const secondCoverage = await secondPorts.coverage.coverage(signal);
    expect(secondCoverage).toMatchObject({ empty: 2, filled: 2 });
    await expect(secondPorts.evidence.page(record.pageId!, signal)).resolves.toMatchObject({ text: PAGE, url: LINK });

    // Its own writes stay its own, and what it corrects is the earlier run's.
    await fetched(second, LAB.threadId);
    const correction = await recorded(secondPorts, finding("x1", "firmness", record.id));
    await recorded(secondPorts, notFound("x2", "firmness"));
    await expect(secondPorts.coverage.change({ change: "add_row", reason: "A third one turned up.", row: { key: "x3", label: "X3" } }, LAB, signal)).resolves.toMatchObject({ ok: true });
    await interrupted(second);

    const third = await runOf(userId, chatId, second.answerId);
    const thirdPorts = portsOf(third, [first.runId, second.runId]);
    await expect(pickUp(thirdPorts, second.runId)).resolves.toMatchObject({ fromRunId: second.runId, frame: { rows: [{ key: "x1" }, { key: "x2" }, { key: "x3" }] } });
    await expect(filled(thirdPorts)).resolves.toEqual(["x1/durability", "x1/firmness", "x2/firmness"]);
    await expect(thirdPorts.evidence.records(signal)).resolves.toEqual([expect.objectContaining({ kind: "not_found", rowKey: "x1", runId: first.runId }),
      expect.objectContaining({ id: correction.id, runId: second.runId }), expect.objectContaining({ kind: "not_found", rowKey: "x2", runId: second.runId })]);

    await recorded(thirdPorts, notFound("x2", "durability"));
    await expect(filled(thirdPorts)).resolves.toEqual(ALL_CELLS);
  });

  it("writes the link once, on its own row, and changes nothing of the run it continues", async () => {
    const { chatId, first, userId } = await interruptedWithRecords();
    const before = await prisma.researchFrame.findUniqueOrThrow({ where: { modelRunId: first.runId } });
    const second = await runOf(userId, chatId, first.answerId);
    const ports = portsOf(second, [first.runId]);
    const state = await ports.resume.load(first.runId, signal);
    await noRow(second);
    await expect(filled(ports)).resolves.toEqual([]);
    await ports.resume.link(state!, signal);
    await expect(prisma.researchFrame.findUniqueOrThrow({ where: { modelRunId: first.runId } })).resolves.toEqual(before);
    const row = await prisma.researchFrame.findUniqueOrThrow({ where: { modelRunId: second.runId } });
    expect(row).toMatchObject({ answer: before.answer, chatId, continuedFromRunId: first.runId, frame: before.frame, goal: GOAL, heldUntil: null, proposal: before.proposal, userId,
      version: before.version, windowEndsAt: before.windowEndsAt });
    expect(row.releasedAt!.getTime()).toBeGreaterThanOrEqual(before.releasedAt!.getTime());
    await expect(ports.resume.link(state!, signal)).rejects.toThrow();
  });

  it("is open to a run that reached its time limit, as its answer offers Continue", async () => {
    const { chatId, first, userId } = await interruptedWithRecords();
    await interrupted(first, RUN_TIME_LIMIT_FAILURE);
    const second = await runOf(userId, chatId, first.answerId);
    await expect(pickUp(portsOf(second, [first.runId]), first.runId)).resolves.toMatchObject({ fromRunId: first.runId });
  });

  it("reaches the research through an approval: the run that started it, with the last run the interrupted one", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const first = await runOf(userId, chatId);
    await released(first);
    await recorded(portsOf(first), notFound("x1", "durability"));
    const approved = await runOf(userId, chatId, first.answerId);
    await interrupted(approved);
    const second = await runOf(userId, chatId, approved.answerId);
    const ports = portsOf(second, [first.runId, approved.runId]);
    await expect(pickUp(ports, first.runId)).resolves.toMatchObject({ fromRunId: first.runId });
    await expect(filled(ports)).resolves.toEqual(["x1/durability"]);
  });

  it("is authorized only by a run of the branch admitted with Deep research, read from its frozen request alone", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const ordinary = await runOf(userId, chatId);
    const chosen = await runOf(userId, chatId, ordinary.answerId);
    await prisma.modelRun.update({ data: { normalizedRequest: json({ context: { messages: [] }, deepResearch: true }) }, where: { id: chosen.runId } });
    const later = await runOf(userId, chatId, chosen.answerId);
    const ports = portsOf(later, [ordinary.runId, chosen.runId]);
    await expect(ports.resume.sentWithDeepResearch([chosen.runId], signal)).resolves.toBe(true);
    await expect(ports.resume.sentWithDeepResearch([ordinary.runId], signal)).resolves.toBe(false);
    // Off the branch, or another user's, counts for nothing.
    await expect(portsOf(later, [ordinary.runId]).resume.sentWithDeepResearch([chosen.runId], signal)).resolves.toBe(false);
    const stranger = await owner();
    await expect(portsOf({ ...later, userId: stranger }, [chosen.runId]).resume.sentWithDeepResearch([chosen.runId], signal)).resolves.toBe(false);
  });

  it("says which run of the branch ended interrupted, so a Continue typed after a finished answer carries nothing", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const finished = await runOf(userId, chatId);
    const cut = await runOf(userId, chatId, finished.answerId);
    await interrupted(cut);
    const later = await runOf(userId, chatId, cut.answerId);
    const ports = portsOf(later, [finished.runId, cut.runId]);
    await expect(ports.resume.endedInterrupted(cut.runId, signal)).resolves.toBe(true);
    await expect(ports.resume.endedInterrupted(finished.runId, signal)).resolves.toBe(false);
    // Off the branch, or another user's, never was.
    await expect(portsOf(later, [finished.runId]).resume.endedInterrupted(cut.runId, signal)).resolves.toBe(false);
    const stranger = await owner();
    await expect(portsOf({ ...later, userId: stranger }, [cut.runId]).resume.endedInterrupted(cut.runId, signal)).resolves.toBe(false);
  });
});

describe("a Continue that gets nothing", () => {
  it("reads another user's run as one that does not exist, whatever the branch list says", async () => {
    const { first } = await interruptedWithRecords();
    const stranger = await owner();
    const theirs = await runOf(stranger, await chatOf(stranger));
    const ports = portsOf(theirs, [first.runId]);
    await expect(ports.resume.load(first.runId, signal)).resolves.toBeNull();
    await expect(ports.resume.load(randomUUID(), signal)).resolves.toBeNull();
    await noRow(theirs);
    await expect(ports.evidence.records(signal)).resolves.toEqual([]);
  });

  it("reads another branch's run the same, in the same chat", async () => {
    const { chatId, first, userId } = await interruptedWithRecords();
    const otherBranch = await runOf(userId, chatId);
    await interrupted(otherBranch);
    const continuing = await runOf(userId, chatId, otherBranch.answerId);
    const ports = portsOf(continuing, [otherBranch.runId]);
    await expect(ports.resume.load(first.runId, signal)).resolves.toBeNull();
    await noRow(continuing);
    await expect(ports.evidence.records(signal)).resolves.toEqual([]);
  });

  it("gets nothing from a completed run, a stopped one or one whose answer was published", async () => {
    const { chatId, first, userId } = await interruptedWithRecords();
    const ends: readonly Prisma.ModelRunUncheckedUpdateInput[] = [{ status: "complete" }, { status: "cancelled" }, { answerCompletedAt: new Date(), status: "error" }];
    for (const data of ends) {
      await prisma.modelRun.update({ data, where: { id: first.runId } });
      const later = await runOf(userId, chatId, first.answerId);
      await expect(portsOf(later, [first.runId]).resume.load(first.runId, signal)).resolves.toBeNull();
      await noRow(later);
    }
  });

  it("starts over on a run with no frame, on a plan still in its window and on a plan released with nothing recorded", async () => {
    const userId = await owner();
    const chatId = await chatOf(userId);
    const scoping = await runOf(userId, chatId);
    await interrupted(scoping);
    const window = await runOf(userId, chatId);
    await prisma.researchFrame.create({ data: { ...keys(window), goal: GOAL, proposal: json(researchPlanProposalDocument(PROPOSAL)), windowEndsAt: new Date() } });
    await interrupted(window);
    const empty = await runOf(userId, chatId);
    await released(empty);
    await interrupted(empty);
    for (const run of [scoping, window, empty]) {
      const later = await runOf(userId, chatId, run.answerId);
      await expect(portsOf(later, [run.runId]).resume.load(run.runId, signal)).resolves.toBeNull();
      await noRow(later);
    }
  });

  it("stops at the chain's bound, where every record can still be read", async () => {
    const { chatId, first, userId } = await interruptedWithRecords();
    const chain = [first];
    for (let link = 1; link < RESEARCH_EVIDENCE_LIMITS.continuationChain; link += 1) {
      const previous = chain.at(-1)!;
      const next = await runOf(userId, chatId, previous.answerId);
      await expect(pickUp(portsOf(next, chain.map((run) => run.runId)), previous.runId)).resolves.not.toBeNull();
      await interrupted(next);
      chain.push(next);
    }
    const last = await runOf(userId, chatId, chain.at(-1)!.answerId);
    const branch = chain.map((run) => run.runId);
    const lastPorts = portsOf(last, branch);
    await expect(pickUp(lastPorts, chain.at(-1)!.runId)).resolves.not.toBeNull();
    await expect(filled(lastPorts)).resolves.toEqual(["x1/durability", "x1/firmness"]);
    await interrupted(last);
    const past = await runOf(userId, chatId, last.answerId);
    await expect(portsOf(past, [...branch, last.runId]).resume.load(last.runId, signal)).resolves.toBeNull();
    await noRow(past);
  });
});

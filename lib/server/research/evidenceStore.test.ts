import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeResearchRecord,
  RESEARCH_EVIDENCE_LIMITS,
  RESEARCH_PAGE_LIMITS,
  type ResearchAgentRef,
  type ResearchEvidenceRecord,
  type ResearchRecordInput
} from "../../contracts/research";
import { TOOL_RESULT_LIMITS, toolOutputExcerpt } from "../engine/toolResults";
import * as observability from "../observability";
import { createResearchEvidenceRepository } from "./evidenceRepository";
import { createResearchEvidenceStore, storedPageText } from "./evidenceStore";
import type { ResearchEvidencePort, ResearchEvidenceWritten, ResearchRunScope } from "./ports";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { RESEARCH_WRITE_SOURCE_LIMITS } from "./sources";

/**
 * The evidence store over its real repository, on an in-memory client that reads as the tables do. What PostgreSQL itself holds (the lock
 * under parallel writers, keys and checks) is `evidenceRepository.prisma.test.ts`.
 */
type Row = Record<string, unknown>;

const LINK = "https://lab.example/x1";
const OTHER_LINK = "https://shop.example/x1";
const SHELL = "mcp__workspace__sandbox_shell";
const QUOTE = "held up after 10 years";
const PAGE = `The X1 ${QUOTE} of use.`;
const RESEARCHER: ResearchAgentRef = { name: "lab", threadId: "thread-lab" };
const MAIN: ResearchAgentRef = { name: null, threadId: null };
const signal = new AbortController().signal;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    if (field === "modelRun") return matches(row, wanted as Row);
    if (typeof wanted === "object" && wanted !== null && "in" in wanted) return (wanted.in as unknown[]).includes(row[field]);
    if (typeof wanted === "object" && wanted !== null && "notIn" in wanted) return !(wanted.notIn as unknown[]).includes(row[field]);
    return row[field] === wanted;
  });
}

/** The tables the store reads and writes, with a call's chat and owner on its row in place of its run's. */
function tables() {
  const evidence: Row[] = [];
  const pages: Row[] = [];
  const frames: Row[] = [];
  const calls: Row[] = [];
  const newestFirst = (rows: readonly Row[]) => [...rows].reverse();
  const taken = (rows: readonly Row[], take: unknown) => typeof take === "number" ? rows.slice(0, take) : rows;
  const client = {
    $queryRaw: vi.fn(async () => [{ lock: "" }]),
    modelRunToolCall: { findMany: vi.fn(async ({ select, take, where }: { select: Row; take?: number; where: Row }) =>
      taken(newestFirst(calls).filter((row) => matches(row, where)), take).map((row) =>
        select.result ? { ...row, observation: row.observationId ? { id: row.observationId } : null } : { arguments: row.arguments, id: row.id })) },
    researchEvidence: {
      aggregate: vi.fn(async ({ where }: { where: Row }) => {
        const rows = evidence.filter((row) => matches(row, where));
        return { _count: { _all: rows.length }, _max: { sequence: rows.length === 0 ? null : Math.max(...rows.map((row) => row.sequence as number)) } };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { claim: null, createdAt: new Date(), criterionKey: null, dataset: null, id: randomUUID(), pageId: null, publishedOn: null, quote: null, quoteCheck: null,
          quoteCheckReason: null, reason: null, registrableDomain: null, rowKey: null, sourceClass: null, standing: null, supersedesId: null, target: null, textGroupKey: null,
          url: null, ...data };
        evidence.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = evidence.find((candidate) => matches(candidate, where));
        return row ? { supersededBy: evidence.find((candidate) => candidate.supersedesId === row.id) ?? null } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Row }) => evidence.filter((row) => matches(row, where)))
    },
    researchFrame: { findFirst: vi.fn(async ({ where }: { where: Row }) => frames.find((row) => matches(row, where)) ?? null) },
    researchPage: {
      aggregate: vi.fn(async ({ where }: { where: Row }) => {
        const rows = pages.filter((row) => matches(row, where));
        return { _count: { _all: rows.length }, _sum: { sizeBytes: rows.length === 0 ? null : rows.reduce((sum, row) => sum + (row.sizeBytes as number), 0) } };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { capturedAt: new Date(), id: randomUUID(), ...data };
        pages.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Row }) => pages.find((row) => matches(row, where)) ?? null)
    }
  };
  const database = { ...client, $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
  return { calls, database, evidence, frames, pages };
}

type Tables = ReturnType<typeof tables>;

function storeOf(memory: Tables, overrides: Readonly<{ read?: (handle: string) => Promise<string | null>; run?: Partial<ResearchRunScope>; background?: readonly string[] }> = {}) {
  const repository = createResearchEvidenceRepository(memory.database as unknown as PrismaClient);
  const savedRead = vi.fn(async ({ handle }: { handle: string }) => {
    const text = await overrides.read?.(handle);
    return text ? { arguments: {}, text, toolName: "t" } : null;
  });
  const backgroundRunIds = vi.fn(async () => [...overrides.background ?? []]);
  const run = { branchRunIds: [], chatId: "chat", researchRunId: "run-1", runId: "run-1", userId: "user", ...overrides.run } as unknown as ResearchRunScope;
  const port = createResearchEvidenceStore({ repository, savedResults: { read: savedRead }, threads: { backgroundRunIds } as never })(run);
  return { backgroundRunIds, port, savedRead };
}

const finding = (quote = QUOTE, url = LINK, extra: Partial<Extract<ResearchRecordInput, { kind: "finding" }>> = {}): ResearchRecordInput => ({ claim: "The X1 holds up.",
  criterionKey: "firmness", kind: "finding", quote, rowKey: "x1", sourceClass: "independent_tests", standing: "confirmed", supersedes: null, url, ...extra });
const notFound: ResearchRecordInput = { criterionKey: "firmness", kind: "not_found", reason: "The maker's pages and two reviews say nothing.", rowKey: "x1", sourceClass: null, supersedes: null };
const unreachable: ResearchRecordInput = { criterionKey: null, kind: "unreachable", reason: "It asks to sign in.", rowKey: null, sourceClass: "action_channel", supersedes: null, target: "shop.example" };

let calls = 0;

type CallRow = Readonly<{ args?: Row; observationId?: string; result?: Row; run?: string; status?: string; thread?: string | null; tool?: string }>;

function addCall(memory: Tables, content: Row[], options: CallRow = {}) {
  calls += 1;
  const providerCallId = `call-${calls}`;
  memory.calls.push({ arguments: options.args ?? {}, chatId: "chat", id: `row-${calls}`, modelRunId: options.run ?? "run-1", observationId: options.observationId ?? null, providerCallId,
    result: { callId: providerCallId, content, name: options.tool ?? "fetch_url", status: "complete" }, state: "complete", subagentThreadId: options.thread === undefined ? "thread-lab" : options.thread,
    toolName: options.tool ?? "fetch_url", userId: "user" });
}

/** What `fetch_url` returned for a page. */
function fetched(memory: Tables, url = LINK, text = PAGE, options: CallRow & Readonly<{ finalUrl?: string; truncated?: boolean }> = {}) {
  addCall(memory, [{ type: "json", value: { contentType: "html", fetchedAt: "2026-11-01T00:00:00.000Z", finalUrl: options.finalUrl ?? url, note: "Untrusted.", text, title: null,
    truncated: options.truncated ?? false, url } }], { ...options, args: { url } });
}

/** What a browser command printed. */
function printed(memory: Tables, text: string, options: CallRow = {}) {
  addCall(memory, [{ text, type: "text" }], { ...options, args: { command: "aiqsa-browser text" }, tool: SHELL });
}

const recorded = async (port: ResearchEvidencePort, record: ResearchRecordInput, author = RESEARCHER): Promise<ResearchEvidenceRecord> => {
  const written = await port.record({ author, record }, signal);
  if (written.kind !== "recorded") throw new Error(`refused: ${written.code}`);
  return written.record;
};

const refusal = (written: ResearchEvidenceWritten) => written.kind === "refused" ? written.code : null;

afterEach(() => vi.restoreAllMocks());

describe("writing a record", () => {
  it("keeps a finding the moment it is made, with the page its writer fetched and the check's word", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const record = await recorded(port, finding());
    expect(record).toMatchObject({ author: RESEARCHER, claim: "The X1 holds up.", kind: "finding", publishedOn: null, quoteCheck: { reason: null, status: "found" }, registrableDomain: "lab.example", rowKey: "x1",
      runId: "run-1", sequence: 0, textGroupKey: expect.stringMatching(/^[0-9a-f]{1,64}$/u) });
    expect(memory.pages).toHaveLength(1);
    expect(memory.pages[0]).toMatchObject({ obtainedBy: "tool", text: PAGE, truncated: false, url: LINK });
    expect(record.pageId).toBe(memory.pages[0]!.id);
    await expect(port.page(record.pageId!, signal)).resolves.toMatchObject({ obtainedBy: "tool", text: PAGE, url: LINK });
    await expect(port.records(signal)).resolves.toEqual([expect.objectContaining({ id: record.id, sequence: 0 })]);
  });

  it("keeps a wrong quote with its word and the page, so nothing is lost and a verifier reads what the page said", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const record = await recorded(port, finding("broke after a year"));
    expect(record.quoteCheck).toEqual({ reason: null, status: "not_verbatim" });
    expect(record.pageId).toBe(memory.pages[0]!.id);
  });

  it("keeps a browser's page, which has no link of its own, under the link cited", async () => {
    const memory = tables();
    printed(memory, `[browser #2] open @ lab.example/x1\n${PAGE}`);
    const { port } = storeOf(memory);
    const record = await recorded(port, finding());
    expect(record.quoteCheck).toEqual({ reason: null, status: "found" });
    expect(memory.pages[0]).toMatchObject({ obtainedBy: "browser", text: `[browser #2] open @ lab.example/x1\n${PAGE}`, truncated: false, url: LINK });
  });

  it("says when the quote is on another page the agent read, and keeps that page under its own address", async () => {
    const memory = tables();
    fetched(memory, OTHER_LINK);
    printed(memory, "[browser #3] open @ other.example/a\nthe words of another site");
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "other_page", status: "found" } });
    expect(memory.pages[0]).toMatchObject({ obtainedBy: "tool", url: OTHER_LINK });
    await expect(recorded(port, finding("the words of another site"))).resolves.toMatchObject({ quoteCheck: { reason: "other_page", status: "found" } });
    expect(memory.pages[1]).toMatchObject({ obtainedBy: "browser", url: "https://other.example" });
  });

  it("takes a redirect's page for the link it ended at", async () => {
    const memory = tables();
    fetched(memory, "https://lab.example/short", PAGE, { finalUrl: LINK });
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { reason: null, status: "found" } });
    expect(memory.pages[0]).toMatchObject({ url: LINK });
  });

  it("reads only its writer's own results: another agent's page proves nothing for it", async () => {
    const memory = tables();
    fetched(memory, LINK, PAGE, { thread: "thread-other" });
    fetched(memory, LINK, PAGE, { thread: null });
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "not_in_opened_text", status: "unsupported" } });
    expect(memory.pages).toHaveLength(0);
    await expect(recorded(port, finding(), MAIN)).resolves.toMatchObject({ quoteCheck: { reason: null, status: "found" } });
  });

  it("calls a quote only in search results a snippet, and what the writer wrote no evidence", async () => {
    const memory = tables();
    addCall(memory, [{ text: `Lab results: ${QUOTE}`, type: "text" }], { tool: "search_engine_1" });
    addCall(memory, [{ text: `recorded: ${QUOTE}`, type: "text" }], { tool: "record_evidence" });
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "search_snippet_only", status: "unsupported" } });
    const onlyWritten = tables();
    addCall(onlyWritten, [{ text: `recorded: ${QUOTE}`, type: "text" }], { tool: "record_evidence" });
    await expect(recorded(storeOf(onlyWritten).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "not_in_opened_text", status: "unsupported" } });
  });

  it("reaches what its writer read before an approval, under the runs of this research and no others", async () => {
    const memory = tables();
    fetched(memory, LINK, PAGE, { run: "run-1" });
    fetched(memory, OTHER_LINK, "An earlier answer's page.", { run: "run-0" });
    const { port } = storeOf(memory, { run: { branchRunIds: ["run-0", "run-1", "run-2"], researchRunId: "run-1", runId: "run-3" } });
    const record = await recorded(port, finding());
    expect(record).toMatchObject({ quoteCheck: { status: "found" }, runId: "run-1" });
    await expect(recorded(port, finding("An earlier answer's page.", OTHER_LINK))).resolves.toMatchObject({ quoteCheck: { status: "unsupported" } });
  });

  it("reaches a background child's results, in a run of its own", async () => {
    const memory = tables();
    fetched(memory, LINK, PAGE, { run: "background-1" });
    const { backgroundRunIds, port } = storeOf(memory, { background: ["background-1"] });
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { status: "found" }, runId: "run-1" });
    expect(backgroundRunIds).toHaveBeenCalledWith({ chatId: "chat", parentRunIds: ["run-1"], userId: "user" });
    await recorded(port, finding(), MAIN);
    expect(backgroundRunIds).toHaveBeenCalledTimes(1);
  });

  it("reads a result too long for its row from its saved copy, and says so when that fails", async () => {
    const whole = `start ${"x".repeat(TOOL_RESULT_LIMITS.inlineChars)} ${PAGE} ${"y".repeat(TOOL_RESULT_LIMITS.inlineChars)} end`;
    const excerpt = toolOutputExcerpt(whole, { handle: `tor1_${"a".repeat(32)}` });
    const memory = tables();
    addCall(memory, [{ text: excerpt.output, type: "text" }], { args: { command: "aiqsa-browser text" }, observationId: "a".repeat(32), tool: SHELL });
    const saved = storeOf(memory, { read: async () => whole });
    await expect(recorded(saved.port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "unaddressed_page", status: "found" } });
    expect(saved.savedRead).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat", handle: `tor1_${"a".repeat(32)}`, userId: "user" }));
    expect(memory.pages[0]).toMatchObject({ obtainedBy: "browser", truncated: false });
    await expect(recorded(storeOf(memory, { read: async () => null }).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "partial_source", status: "not_checked" } });
  });

  it("calls a quote past where the reader stopped not checked, never a failure", async () => {
    const memory = tables();
    fetched(memory, LINK, "The first part of a long page.", { truncated: true });
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "partial_source", status: "not_checked" } });
    expect(memory.pages[0]).toMatchObject({ text: "The first part of a long page.", truncated: true });
  });

  it("cuts a long page to the bound on a whole character, and a quote past the cut is not checked", async () => {
    const start = "ж".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage / 2 - 1);
    const memory = tables();
    printed(memory, `${start}ж${QUOTE}`);
    const { port } = storeOf(memory);
    await expect(recorded(port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "page_truncated", status: "not_checked" } });
    expect(memory.pages[0]).toMatchObject({ sizeBytes: RESEARCH_PAGE_LIMITS.bytesPerPage, truncated: true });
    expect(memory.pages[0]!.text).toBe(`${start}ж`);
    const short = tables();
    printed(short, `${QUOTE} ${"x".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage)}`);
    await expect(recorded(storeOf(short).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "unaddressed_page", status: "found" } });
    expect(short.pages[0]).toMatchObject({ truncated: true });
  });

  it("stores no NUL, no broken character, and no page that is left empty", () => {
    expect(storedPageText("a\u0000b")).toEqual({ cut: false, text: "ab" });
    expect(storedPageText("a\ud83d")).toEqual({ cut: false, text: "a�" });
    expect(storedPageText(`${"x".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage - 1)}жж`)).toMatchObject({ cut: true });
    expect(Buffer.byteLength(storedPageText(`${"x".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage - 1)}жж`).text)).toBe(RESEARCH_PAGE_LIMITS.bytesPerPage - 1);
    expect(storedPageText("\u0000").text).toBe("");
  });

  it("keeps a page once however many records rest on it, and writes each agent's records in one order", async () => {
    const memory = tables();
    fetched(memory);
    fetched(memory, LINK, PAGE, { thread: null });
    const { port } = storeOf(memory);
    const [first, second, third] = [await recorded(port, finding()), await recorded(port, finding("10 years")), await recorded(port, finding(), MAIN)];
    expect(memory.pages).toHaveLength(1);
    expect([first.pageId, second.pageId, third.pageId]).toEqual([first.pageId, first.pageId, first.pageId]);
    expect([first.sequence, second.sequence, third.sequence]).toEqual([0, 1, 2]);
    expect(third.author).toEqual(MAIN);
  });

  it("takes every kind, with no read of anyone's results for a record that quotes nothing", async () => {
    const memory = tables();
    const { port } = storeOf(memory);
    const dataset = decodeResearchRecord({ claim: "Owners report sagging.", criterion_key: null, kind: "dataset", quote: null, reason: null, row_key: "x1", source_class: "owner_reviews", standing: "claimed",
      supersedes: null, target: null, url: LINK, dataset: { counts: [{ count: 3, label: "sagging" }], examples: [{ quote: QUOTE, url: LINK }], left_out: "Other sizes.", method: "Read every review.", sample_size: 120 } });
    if (!dataset.ok) throw new Error(dataset.message);
    await expect(recorded(port, notFound)).resolves.toMatchObject({ kind: "not_found", pageId: null, quoteCheck: null, reason: notFound.kind === "not_found" ? notFound.reason : "" });
    await expect(recorded(port, unreachable)).resolves.toMatchObject({ kind: "unreachable", pageId: null, quoteCheck: null, target: "shop.example" });
    expect(memory.database.modelRunToolCall.findMany).not.toHaveBeenCalled();
    fetched(memory);
    await expect(recorded(port, dataset.value)).resolves.toMatchObject({ dataset: { counts: [{ count: 3, label: "sagging" }], examples: [{ quote: QUOTE, url: LINK }], leftOut: "Other sizes.",
      method: "Read every review.", sampleSize: 120 }, kind: "dataset", quoteCheck: { reason: null, status: "found" } });
    await expect(port.records(signal)).resolves.toHaveLength(3);
  });

  it("gives a dataset the word of the example most in need of it", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const dataset = decodeResearchRecord({ claim: "Owners report sagging.", criterion_key: null, kind: "dataset", quote: null, reason: null, row_key: "x1", source_class: "owner_reviews", standing: "claimed",
      supersedes: null, target: null, url: LINK, dataset: { counts: [], examples: [{ quote: QUOTE, url: LINK }, { quote: "invented", url: LINK }], left_out: "None.", method: "Read.", sample_size: 2 } });
    if (!dataset.ok) throw new Error(dataset.message);
    await expect(recorded(port, dataset.value)).resolves.toMatchObject({ quoteCheck: { reason: null, status: "not_verbatim" } });
    expect(memory.pages).toHaveLength(1);
  });

  describe("a rating (operator decision 2026-11-05)", () => {
    const CARD = "https://clinic.example/doctors/ivanova";
    const CARD_PAGE = "Иванова Анна, дерматолог. Рейтинг 4,9 · 1 284 отзыва пациентов. Записаться.";
    const rating = { count: 1_284, counted: "reviews" as const, scaleMax: 5, score: 4.9, variantsMerged: false };
    const rated = (quote: string, change: Partial<typeof rating> = {}) => finding(quote, CARD, { claim: "Пациенты оценивают Иванову на 4,9 из 5 по 1 284 отзывам.",
      criterionKey: "ratings", rating: { ...rating, ...change }, rowKey: "ivanova", sourceClass: "owner_reviews" });

    it("passes when its score and number of ratings stand in a quote the page holds", async () => {
      const memory = tables();
      fetched(memory, CARD, CARD_PAGE);
      const { port } = storeOf(memory);
      const record = await recorded(port, rated("Рейтинг 4,9 · 1 284 отзыва пациентов"));
      expect(record).toMatchObject({ kind: "finding", quoteCheck: { reason: null, status: "found" }, rowKey: "ivanova" });
      expect(record.pageId).toBe(memory.pages[0]!.id);
    });

    it("is marked as a wrong quote, kept with its page, when the page does not write its count, and counts as no evidence until corrected", async () => {
      const memory = tables();
      fetched(memory, CARD, CARD_PAGE);
      const { port } = storeOf(memory);
      const wrong = await recorded(port, rated("Рейтинг 4,9 · 1 284 отзыва пациентов", { count: 1_824 }));
      expect(wrong).toMatchObject({ kind: "finding", quoteCheck: { reason: "rating_not_in_quote", status: "not_verbatim" } });
      expect(wrong.pageId).toBe(memory.pages[0]!.id);
      // A quote that leaves the count out shows nothing of it either.
      await expect(recorded(port, rated("Рейтинг 4,9"))).resolves.toMatchObject({ quoteCheck: { reason: "rating_not_in_quote", status: "not_verbatim" } });
      // A quote not on the page keeps its own word: that is what to correct first.
      await expect(recorded(port, rated("Рейтинг 4,9 · 1 824 отзыва"))).resolves.toMatchObject({ quoteCheck: { reason: null, status: "not_verbatim" } });
      await expect(port.records(signal)).resolves.toHaveLength(3);
    });

    it("leaves a finding that is no rating as its quote's check has it", async () => {
      const memory = tables();
      fetched(memory, CARD, CARD_PAGE);
      const { port } = storeOf(memory);
      const plain = await recorded(port, finding("Записаться", CARD));
      expect(plain.quoteCheck).toEqual({ reason: null, status: "found" });
      expect(plain).not.toHaveProperty("rating");
    });
  });

  it("stands when its writer's results cannot be read, marked so, and gives a stopped run's abort back", async () => {
    const memory = tables();
    memory.database.modelRunToolCall.findMany.mockRejectedValue(new Error("down"));
    const { port } = storeOf(memory);
    const log = vi.spyOn(observability, "logEvent");
    await expect(recorded(port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "sources_unreadable", status: "not_checked" } });
    expect(log).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "research_sources_unreadable" }));
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    await expect(port.record({ author: RESEARCHER, record: finding() }, stop.signal)).rejects.toThrow("stopped");
    expect(memory.evidence).toHaveLength(1);
  });
});

describe("what one write reads", () => {
  it("costs only the cited page when the quote is on it", async () => {
    const memory = tables();
    for (let index = 0; index < 20; index += 1) printed(memory, `Browser page ${index}.`);
    fetched(memory);
    const { port } = storeOf(memory);
    await recorded(port, finding());
    const reads = memory.database.modelRunToolCall.findMany.mock.calls.map(([query]) => query);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ select: { arguments: true, id: true }, take: RESEARCH_WRITE_SOURCE_LIMITS.fetchCalls, where: { subagentThreadId: "thread-lab", toolName: "fetch_url" } });
    expect(reads[0]!.select).not.toHaveProperty("result");
    expect(reads[1]).toMatchObject({ where: { id: { in: [memory.calls.at(-1)!.id] } } });
  });

  it("names the owner and the chat in every read of a call", async () => {
    const memory = tables();
    fetched(memory);
    await recorded(storeOf(memory).port, finding("not on the page"));
    for (const [query] of memory.database.modelRunToolCall.findMany.mock.calls) expect(query.where).toMatchObject({ modelRun: { chatId: "chat", userId: "user" } });
  });

  it("stops at its bound and calls a miss not checked: the page may be older than what it read", async () => {
    const memory = tables();
    fetched(memory);
    for (let index = 0; index < RESEARCH_WRITE_SOURCE_LIMITS.recentResults; index += 1) printed(memory, `Browser page ${index}.`);
    const { port } = storeOf(memory);
    await expect(recorded(port, finding("on an older browser page", "https://never.example/x"))).resolves.toMatchObject({ quoteCheck: { reason: "sources_over_limit", status: "not_checked" } });
  });

  it("stops at its characters too, on the newest results", async () => {
    const memory = tables();
    printed(memory, `On the oldest page: ${QUOTE}`);
    printed(memory, "y".repeat(RESEARCH_WRITE_SOURCE_LIMITS.characters));
    printed(memory, "z");
    const { port } = storeOf(memory);
    await expect(recorded(port, finding(QUOTE, "https://never.example/x"))).resolves.toMatchObject({ quoteCheck: { reason: "sources_over_limit", status: "not_checked" } });
  });

  it("finds a page a compaction took out of the context: the call's row stays", async () => {
    const memory = tables();
    fetched(memory);
    for (let index = 0; index < RESEARCH_WRITE_SOURCE_LIMITS.recentResults * 2; index += 1) printed(memory, `Browser page ${index}.`);
    await expect(recorded(storeOf(memory).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: null, status: "found" } });
  });
});

describe("corrections", () => {
  it("adds a record that supersedes, and what stands never falls", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const wrong = await recorded(port, finding("broke after a year"));
    const other = await recorded(port, notFound);
    const right = await recorded(port, finding(QUOTE, LINK, { supersedes: wrong.id }));
    expect(right).toMatchObject({ quoteCheck: { status: "found" }, supersedes: wrong.id });
    await expect(port.records(signal)).resolves.toEqual([expect.objectContaining({ id: other.id }), expect.objectContaining({ id: right.id })]);
    expect(memory.evidence).toHaveLength(3);
  });

  it("keeps the lineage of a correction of a correction, which records leaves out once corrected again", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const first = await recorded(port, finding("broke after a year"));
    const second = await recorded(port, finding("broke after two years", LINK, { supersedes: first.id }));
    const third = await recorded(port, finding(QUOTE, LINK, { supersedes: second.id }));
    await expect(port.records(signal)).resolves.toEqual([expect.objectContaining({ id: third.id })]);
    await expect(port.supersessions!(signal)).resolves.toEqual(new Map([[second.id, first.id], [third.id, second.id]]));
  });

  it("refuses a record that is not this research's as one that does not exist, and a second correction", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const elsewhere = await recorded(storeOf(memory, { run: { researchRunId: "run-other", runId: "run-other" } }).port, finding());
    const foreign = await recorded(storeOf(tables(), { run: { userId: "user" } }).port, notFound);
    const unknown = await port.record({ author: RESEARCHER, record: finding(QUOTE, LINK, { supersedes: elsewhere.id }) }, signal);
    const missing = await port.record({ author: RESEARCHER, record: finding(QUOTE, LINK, { supersedes: foreign.id }) }, signal);
    expect([refusal(unknown), refusal(missing)]).toEqual(["research_record_unknown", "research_record_unknown"]);
    expect(unknown).toEqual(missing);
    const first = await recorded(port, finding());
    await recorded(port, finding(QUOTE, LINK, { supersedes: first.id }));
    const again = await port.record({ author: RESEARCHER, record: finding(QUOTE, LINK, { supersedes: first.id }) }, signal);
    expect(refusal(again)).toBe("research_record_corrected");
    expect(memory.evidence.filter((row) => row.modelRunId === "run-1")).toHaveLength(2);
  });

  it("takes what the database refuses to a second correction as that refusal", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    const first = await recorded(port, finding());
    const { Prisma } = await import("@prisma/client");
    memory.database.researchEvidence.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("taken", { clientVersion: "test", code: "P2002" }));
    await expect(port.record({ author: RESEARCHER, record: finding(QUOTE, LINK, { supersedes: first.id }) }, signal)).resolves.toMatchObject({ code: "research_record_corrected", kind: "refused" });
    memory.database.researchEvidence.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("taken", { clientVersion: "test", code: "P2002" }));
    await expect(port.record({ author: RESEARCHER, record: finding() }, signal)).rejects.toThrow("taken");
  });
});

describe("limits", () => {
  it("refuses the record past the bound, visibly and in the log with its code alone", async () => {
    const memory = tables();
    fetched(memory);
    const { port } = storeOf(memory);
    for (let sequence = 0; sequence < RESEARCH_EVIDENCE_LIMITS.recordsPerRun; sequence += 1) memory.evidence.push({ chatId: "chat", modelRunId: "run-1", sequence, userId: "user" });
    const log = vi.spyOn(observability, "logEvent");
    const written = await port.record({ author: RESEARCHER, record: finding() }, signal);
    expect(written).toMatchObject({ code: "research_records_full", kind: "refused" });
    expect(memory.evidence).toHaveLength(RESEARCH_EVIDENCE_LIMITS.recordsPerRun);
    expect(log).toHaveBeenCalledWith("service_operation", { action: "degrade", code: "research_records_full", outcome: "degraded", run_id: "run-1", stage: "write", subsystem: "database" });
  });

  it.each([
    ["pages", { sizeBytes: 1 }, RESEARCH_PAGE_LIMITS.pagesPerRun],
    ["bytes", { sizeBytes: RESEARCH_PAGE_LIMITS.bytesPerPage }, Math.floor(RESEARCH_PAGE_LIMITS.bytesPerRun / RESEARCH_PAGE_LIMITS.bytesPerPage)]
  ])("keeps a finding with no room for its page, %s bound reached, not checked and saying why", async (_bound, page, rows) => {
    const memory = tables();
    fetched(memory);
    for (let index = 0; index < rows; index += 1) memory.pages.push({ chatId: "chat", contentHash: `hash-${index}`, modelRunId: "run-1", userId: "user", ...page });
    const { port } = storeOf(memory);
    const log = vi.spyOn(observability, "logEvent");
    await expect(recorded(port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "page_not_stored", status: "not_checked" } });
    expect(memory.pages).toHaveLength(rows);
    expect(log).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "page_not_stored" }));
    await expect(recorded(port, finding("broke after a year"))).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: null, status: "not_verbatim" } });
  });

  it("says the page was not kept whatever the check made of it, and only a wrong quote keeps its own word", async () => {
    const full = (memory: Tables) => {
      for (let index = 0; index < RESEARCH_PAGE_LIMITS.pagesPerRun; index += 1) memory.pages.push({ chatId: "chat", contentHash: `hash-${index}`, modelRunId: "run-1", sizeBytes: 1, userId: "user" });
    };
    const cutBeforeTheQuote = tables();
    printed(cutBeforeTheQuote, `${"ж".repeat(RESEARCH_PAGE_LIMITS.bytesPerPage / 2)}${QUOTE}`);
    full(cutBeforeTheQuote);
    await expect(recorded(storeOf(cutBeforeTheQuote).port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "page_not_stored", status: "not_checked" } });
    const readInPart = tables();
    fetched(readInPart, LINK, "The first part of a long page.", { truncated: true });
    full(readInPart);
    await expect(recorded(storeOf(readInPart).port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "page_not_stored", status: "not_checked" } });
    const noPage = tables();
    full(noPage);
    await expect(recorded(storeOf(noPage).port, finding())).resolves.toMatchObject({ pageId: null, quoteCheck: { reason: "not_in_opened_text", status: "unsupported" } });
    await expect(recorded(storeOf(noPage).port, notFound)).resolves.toMatchObject({ pageId: null, quoteCheck: null });
  });

  it("counts only its own research's rows, and a page kept already takes no room", async () => {
    const memory = tables();
    fetched(memory);
    for (let index = 0; index < RESEARCH_PAGE_LIMITS.pagesPerRun; index += 1) memory.pages.push({ chatId: "chat", contentHash: `hash-${index}`, modelRunId: "run-other", sizeBytes: 1, userId: "user" });
    const { port } = storeOf(memory);
    const first = await recorded(port, finding());
    expect(first.pageId).not.toBeNull();
    for (let index = 1; index < RESEARCH_PAGE_LIMITS.pagesPerRun; index += 1) memory.pages.push({ chatId: "chat", contentHash: `hash-${index}`, modelRunId: "run-1", sizeBytes: 1, userId: "user" });
    await expect(recorded(port, finding())).resolves.toMatchObject({ pageId: first.pageId, quoteCheck: { status: "found" } });
  });

  it("writes no page text, quote or claim to the log", async () => {
    const memory = tables();
    fetched(memory);
    const log = vi.spyOn(observability, "logEvent");
    for (let index = 0; index < RESEARCH_PAGE_LIMITS.pagesPerRun; index += 1) memory.pages.push({ chatId: "chat", contentHash: `hash-${index}`, modelRunId: "run-1", sizeBytes: 1, userId: "user" });
    await recorded(storeOf(memory).port, finding());
    const written = JSON.stringify(log.mock.calls);
    for (const content of [QUOTE, "The X1", LINK]) expect(written).not.toContain(content);
  });
});

describe("reading", () => {
  const frame = (modelRunId: string, continuedFromRunId: string | null, userId = "user") => ({ chatId: "chat", continuedFromRunId, modelRunId, userId });

  it("reads this run's records and no other run's, user's or chat's", async () => {
    const memory = tables();
    const { port } = storeOf(memory);
    const own = await recorded(port, notFound);
    await recorded(storeOf(memory, { run: { researchRunId: "run-2", runId: "run-2" } }).port, notFound);
    await recorded(storeOf(memory, { run: { userId: "someone" } }).port, notFound);
    await recorded(storeOf(memory, { run: { chatId: "another" } }).port, notFound);
    await expect(port.records(signal)).resolves.toEqual([expect.objectContaining({ id: own.id })]);
  });

  it("keeps one research across an approval: the continuation appends to the run that started it and reads what it wrote", async () => {
    const memory = tables();
    const started = storeOf(memory);
    const continued = storeOf(memory, { run: { branchRunIds: ["run-1"], researchRunId: "run-1", runId: "run-2" } });
    const first = await recorded(started.port, notFound);
    const second = await recorded(continued.port, unreachable);
    expect(second).toMatchObject({ runId: "run-1", sequence: 1 });
    await expect(continued.port.records(signal)).resolves.toEqual([expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id })]);
    await expect(started.port.records(signal)).resolves.toHaveLength(2);
  });

  it("walks a Continue back, earliest first, and a run with no frame reads its own alone", async () => {
    const memory = tables();
    fetched(memory, LINK, PAGE, { run: "run-1" });
    const earlier = await recorded(storeOf(memory).port, finding());
    memory.frames.push(frame("run-1", null), frame("run-2", "run-1"));
    const later = storeOf(memory, { run: { researchRunId: "run-2", runId: "run-2" } });
    const correction = await recorded(later.port, finding(QUOTE, LINK, { supersedes: earlier.id }));
    expect(correction).toMatchObject({ quoteCheck: { status: "found" }, runId: "run-2", sequence: 0, supersedes: earlier.id });
    const own = await recorded(later.port, notFound);
    await expect(later.port.records(signal)).resolves.toEqual([expect.objectContaining({ id: correction.id }), expect.objectContaining({ id: own.id })]);
    await expect(later.port.page(earlier.pageId!, signal)).resolves.toMatchObject({ text: PAGE });
    // The earlier run read alone still has its record: a correction of a later run is not its own.
    memory.frames.length = 0;
    await expect(storeOf(memory).port.records(signal)).resolves.toEqual([expect.objectContaining({ id: earlier.id })]);
    await expect(storeOf(memory, { run: { researchRunId: "run-9", runId: "run-9" } }).port.page(earlier.pageId!, signal)).resolves.toBeNull();
  });

  it("orders a chain by run, then by sequence", async () => {
    const memory = tables();
    const first = await recorded(storeOf(memory).port, notFound);
    const later = storeOf(memory, { run: { researchRunId: "run-2", runId: "run-2" } });
    memory.frames.push(frame("run-2", "run-1"));
    const second = await recorded(later.port, unreachable);
    const third = await recorded(storeOf(memory).port, unreachable);
    await expect(later.port.records(signal)).resolves.toEqual([first, third, second].map((record) => expect.objectContaining({ id: record.id })));
  });

  it("walks no further than its bound and never loops", async () => {
    const memory = tables();
    const hops = RESEARCH_EVIDENCE_LIMITS.continuationChain;
    for (let index = 0; index < hops + 3; index += 1) memory.frames.push(frame(`run-${index + 1}`, `run-${index}`));
    for (let index = 0; index <= hops + 3; index += 1) await recorded(storeOf(memory, { run: { researchRunId: `run-${index}`, runId: `run-${index}` } }).port, notFound);
    const { port } = storeOf(memory, { run: { researchRunId: `run-${hops + 3}`, runId: `run-${hops + 3}` } });
    const read = await port.records(signal);
    expect(read.map((record) => record.runId)).toEqual(Array.from({ length: hops + 1 }, (_, index) => `run-${index + 3}`));
    const looped = tables();
    looped.frames.push(frame("run-a", "run-b"), frame("run-b", "run-a"));
    await recorded(storeOf(looped, { run: { researchRunId: "run-a", runId: "run-a" } }).port, notFound);
    await expect(storeOf(looped, { run: { researchRunId: "run-a", runId: "run-a" } }).port.records(signal)).resolves.toHaveLength(1);
    expect(looped.database.researchFrame.findFirst.mock.calls.length).toBeLessThan(hops * 2);
  });

  it("does not follow a link another owner's frame holds", async () => {
    const memory = tables();
    await recorded(storeOf(memory, { run: { researchRunId: "run-old", runId: "run-old" } }).port, notFound);
    memory.frames.push(frame("run-1", "run-old", "someone"));
    await expect(storeOf(memory).port.records(signal)).resolves.toEqual([]);
  });

  it("gives a stopped run's abort back on a read", async () => {
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    const { port } = storeOf(tables());
    await expect(port.records(stop.signal)).rejects.toThrow("stopped");
    await expect(port.page("page", stop.signal)).rejects.toThrow("stopped");
  });
});

describe("what a closed site needs (operator decision 2026-11-05)", () => {
  const EXEC = namespacedWorkspaceToolName("sandbox_exec");
  const command = (memory: Tables, args: Row, stdout: string, thread: string | null = "thread-lab") =>
    addCall(memory, [{ text: JSON.stringify({ data: { exitCode: 0, stderr: "", stdout, success: true }, ok: true }), type: "text" }], { args, thread, tool: EXEC });

  it("keeps a quote found in browser output an address only where a step line shows the cited host", async () => {
    const shown = tables();
    printed(shown, `[browser #2 · lab] text @ lab.example/x1\n${PAGE}`);
    await expect(recorded(storeOf(shown).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: null, status: "found" } });
    const bare = tables();
    printed(bare, PAGE);
    await expect(recorded(storeOf(bare).port, finding())).resolves.toMatchObject({ quoteCheck: { reason: "unaddressed_page", status: "found" } });
  });

  it("knows the hosts an agent's own browser navigations tried, from its call rows alone", async () => {
    const memory = tables();
    command(memory, { args: ["open", "https://www.shop.example/card"], command: "aiqsa-browser" }, "");
    command(memory, { args: ["proxied", "curl", "https://proxied.example/"], command: "aiqsa-browser" }, "HTTP/2 403");
    command(memory, { args: ["open", "https://main.example/"], command: "aiqsa-browser" }, "", null);
    const { port } = storeOf(memory);
    await expect(port.browsed!(RESEARCHER, "shop.example", signal)).resolves.toBe(true);
    await expect(port.browsed!(RESEARCHER, "proxied.example", signal)).resolves.toBe(false);
    await expect(port.browsed!(RESEARCHER, "main.example", signal)).resolves.toBe(false);
    await expect(port.browsed!(MAIN, "main.example", signal)).resolves.toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  RESEARCH_FRAME_LIMITS,
  RESEARCH_ROUND_LIMITS,
  type ResearchEvidenceRecord,
  type ResearchFrame,
  type ResearchFrameChangeRequest,
  type ResearchQuoteCheckStatus
} from "../../contracts/research";
import { SUBAGENT_LIMITS } from "../../contracts/subagents";
import {
  changedResearchFrame,
  createResearchCoverage,
  createResearchFrameStore,
  createResearchRounds,
  RESEARCH_WHOLE_QUESTION_ROW,
  researchEmptyByRow,
  researchFilledCells,
  researchKeyCells,
  researchLeadingRows,
  researchMatrix,
  researchMatrixCoverage,
  researchProgressCells,
  researchUnconfirmedKeyCells,
  type ResearchFrameStore
} from "./matrix";
import { NOOP_RESEARCH_PORTS, type ResearchPorts, type ResearchRunScope } from "./ports";

const FRAME: ResearchFrame = {
  branches: [],
  changes: [],
  criteria: [{ criterion: "Durability", key: "durability", why: "It is bought for years." }, { criterion: "Firmness", key: "firmness", why: "It decides comfort." }],
  rows: [{ key: "x1", label: "Lonax X1" }, { key: "y2", label: "Dreamline Y2" }]
};
const STAMP = { at: "2026-11-02T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" } };

let ids = 0;
const base = (rowKey: string | null, criterionKey: string | null) => ({ author: { name: null, threadId: null }, createdAt: "", criterionKey, id: `record-${ids += 1}`, pageId: null, publishedOn: null,
  registrableDomain: null, rowKey, runId: "run", sequence: ids, supersedes: null, textGroupKey: null });
const finding = (rowKey: string | null, criterionKey: string | null, status: ResearchQuoteCheckStatus | null = "found"): ResearchEvidenceRecord => ({ ...base(rowKey, criterionKey), claim: "c", kind: "finding", quote: "q",
  quoteCheck: status && { reason: null, status }, sourceClass: "owner_reviews", standing: "claimed", url: "https://a.example" });
const notFound = (rowKey: string, criterionKey: string): ResearchEvidenceRecord => ({ ...base(rowKey, criterionKey), criterionKey, kind: "not_found", quoteCheck: null, reason: "Nowhere.", rowKey, sourceClass: null });
const dataset = (rowKey: string, criterionKey: string | null, status: ResearchQuoteCheckStatus): ResearchEvidenceRecord => ({ ...base(rowKey, criterionKey), claim: "c",
  dataset: { counts: [], examples: [{ quote: "q", url: "https://a.example" }], leftOut: "None.", method: "Read them.", sampleSize: 10 }, kind: "dataset", quoteCheck: { reason: null, status }, rowKey,
  sourceClass: "owner_reviews", standing: "claimed", url: "https://a.example" });
const unreachable = (rowKey: string, criterionKey: string): ResearchEvidenceRecord => ({ ...base(rowKey, criterionKey), kind: "unreachable", quoteCheck: null, reason: "Blocked.", sourceClass: null, target: "shop.example" });

const stateOf = (records: readonly ResearchEvidenceRecord[], rowKey = "x1", criterionKey = "durability", frame = FRAME) =>
  researchMatrixCoverage(frame, records).cells.find((cell) => cell.rowKey === rowKey && cell.criterionKey === criterionKey);

describe("what fills a cell", () => {
  it("is empty with no record, cell by cell, row by criterion", () => {
    const coverage = researchMatrixCoverage(FRAME, []);
    expect(coverage.cells.map(({ criterionKey, rowKey, state }) => [rowKey, criterionKey, state])).toEqual([["x1", "durability", "empty"], ["x1", "firmness", "empty"], ["y2", "durability", "empty"], ["y2", "firmness", "empty"]]);
    expect(coverage).toMatchObject({ empty: 4, filled: 0 });
  });

  it("takes a live finding or dataset whose quote was found or could not be checked", () => {
    for (const record of [finding("x1", "durability", "found"), finding("x1", "durability", "not_checked"), dataset("x1", "durability", "found"), dataset("x1", "durability", "not_checked")]) {
      expect(stateOf([record])).toEqual({ criterionKey: "durability", recordIds: [record.id], rowKey: "x1", state: "filled" });
    }
  });

  it("does not take a quote known to be bad, until a correction replaces it among the live records", () => {
    const wrong = finding("x1", "durability", "not_verbatim");
    expect(stateOf([wrong])).toMatchObject({ recordIds: [], state: "empty" });
    expect(stateOf([finding("x1", "durability", "unsupported")])).toMatchObject({ state: "empty" });
    expect(stateOf([dataset("x1", "durability", "not_verbatim")])).toMatchObject({ state: "empty" });
    const correction = { ...finding("x1", "durability", "found"), supersedes: wrong.id };
    expect(stateOf([correction])).toMatchObject({ recordIds: [correction.id], state: "filled" });
  });

  it("takes neither a finding that has no quote check nor an unreachable site", () => {
    expect(stateOf([finding("x1", "durability", null)])).toMatchObject({ state: "empty" });
    expect(stateOf([unreachable("x1", "durability")])).toMatchObject({ state: "empty" });
  });

  it("counts a cell recorded as not found as filled, and evidence outranks it", () => {
    const none = notFound("x1", "durability");
    expect(stateOf([none])).toMatchObject({ recordIds: [none.id], state: "not_found" });
    expect(researchMatrixCoverage(FRAME, [none])).toMatchObject({ empty: 3, filled: 1 });
    const found = finding("x1", "durability");
    expect(stateOf([none, found])).toMatchObject({ recordIds: [found.id], state: "filled" });
  });

  it("keeps a record under a key the frame does not know out of every cell, and counts it as it stands once the key is added", () => {
    const stray = finding("z9", "durability");
    expect(researchMatrixCoverage(FRAME, [stray, finding("x1", "price")])).toMatchObject({ empty: 4, filled: 0 });
    const grown = { ...FRAME, rows: [...FRAME.rows, { key: "z9", label: "New" }] };
    expect(stateOf([stray], "z9", "durability", grown)).toMatchObject({ recordIds: [stray.id], state: "filled" });
  });

  it("needs a row and a criterion: a record with neither stands, and fills nothing while rows exist", () => {
    expect(researchMatrixCoverage(FRAME, [finding(null, "durability"), finding("x1", null), dataset("x1", null, "found")])).toMatchObject({ empty: 4, filled: 0 });
  });

  it("treats a frame with no rows as one cell per criterion, whatever row a record names, so a knowledge question has cells and a sub-question nothing was found for is filled", () => {
    const rowless = { ...FRAME, rows: [] };
    const covered = researchMatrixCoverage(rowless, [finding(null, "durability"), notFound("all", "firmness")]);
    expect(covered).toMatchObject({ empty: 0, filled: 2 });
    expect(covered.cells).toMatchObject([{ criterionKey: "durability", rowKey: RESEARCH_WHOLE_QUESTION_ROW, state: "filled" }, { criterionKey: "firmness", rowKey: RESEARCH_WHOLE_QUESTION_ROW, state: "not_found" }]);
    expect(researchMatrixCoverage(rowless, [finding("z9", "durability")])).toMatchObject({ empty: 1, filled: 1 });
    expect(researchMatrixCoverage(rowless, [finding(null, null), finding(null, "price")])).toMatchObject({ empty: 2, filled: 0 });
  });

  it("gives way to rows once they exist: only a record at a row counts then", () => {
    const rowed = { ...FRAME, rows: [{ key: "x1", label: "X1" }] };
    expect(researchMatrixCoverage(rowed, [finding(null, "durability"), finding("all", "firmness")])).toMatchObject({ empty: 2, filled: 0 });
    expect(researchMatrixCoverage(rowed, [finding("x1", "durability")])).toMatchObject({ empty: 1, filled: 1 });
  });

  it("lists the empty cells by row with their words", () => {
    const coverage = researchMatrixCoverage(FRAME, [finding("x1", "durability"), finding("y2", "durability"), notFound("y2", "firmness")]);
    expect(researchEmptyByRow({ coverage, frame: FRAME })).toEqual([{ criteria: [FRAME.criteria[1]], row: FRAME.rows[0] }]);
    const rowless = { ...FRAME, rows: [] };
    expect(researchEmptyByRow({ coverage: researchMatrixCoverage(rowless, []), frame: rowless })).toEqual([{ criteria: FRAME.criteria, row: null }]);
  });
});

describe("the key specifications of the options a draft leads with", () => {
  const KEYED: ResearchFrame = { ...FRAME, criteria: [{ ...FRAME.criteria[0]!, decisive: true }, FRAME.criteria[1]!] };
  const on = (rowKey: string, criterionKey: string, link: string, claim = "c") => ({ ...finding(rowKey, criterionKey), claim, url: link }) as ResearchEvidenceRecord;
  const cellsOf = (records: readonly ResearchEvidenceRecord[], rowKeys: readonly string[] = ["x1"], frame = KEYED) =>
    researchKeyCells({ coverage: researchMatrixCoverage(frame, records), frame }, records, rowKeys);

  it("leads with the pick, each case's pick and the summary's options, in that order, once each", () => {
    expect(researchLeadingRows({ branchPicks: [{ branchKey: "w", caseKey: "heavy", rowKey: "y2" }], pickRowKey: "x1", summary: { rowKeys: ["x1", "z3", "y2"], text: "t" } }))
      .toEqual(["x1", "y2", "z3"]);
    expect(researchLeadingRows(undefined)).toEqual([]);
  });

  it("counts sites, not pages, and takes a cell as confirmed by a second site or by not_found", () => {
    const [one] = cellsOf([on("x1", "durability", "https://maker.example/a"), on("x1", "durability", "https://www.maker.example/b"), on("x1", "firmness", "https://maker.example/a")]);
    expect(one).toMatchObject({ confirmed: false, criterion: { key: "durability" }, row: { key: "x1" }, sites: ["maker.example"] });
    expect(cellsOf([on("x1", "durability", "https://maker.example/a"), on("x1", "durability", "https://shop.example/b")])[0]).toMatchObject({ confirmed: true });
    expect(cellsOf([on("x1", "durability", "https://maker.example/a"), notFound("x1", "durability")])[0]).toMatchObject({ confirmed: true });
  });

  it("takes no site from a record whose quote was found only on another page, since its link's site did not show it", () => {
    const elsewhere = { ...on("x1", "durability", "https://shop.example/b"), quoteCheck: { reason: "other_page", status: "found" } } as ResearchEvidenceRecord;
    expect(cellsOf([on("x1", "durability", "https://maker.example/a"), elsewhere])[0]).toMatchObject({ confirmed: false, sites: ["maker.example"] });
  });

  it("takes a not_found as a second site looked for only when written after the cell's last record", () => {
    // Written before the finding, it says only that the first site was not found yet.
    expect(cellsOf([notFound("x1", "durability"), on("x1", "durability", "https://maker.example/a")])[0]).toMatchObject({ confirmed: false });
    const first = on("x1", "durability", "https://maker.example/a");
    const after = notFound("x1", "durability");
    expect(cellsOf([first, after, on("x1", "durability", "https://www.maker.example/c")])[0]).toMatchObject({ confirmed: false });
    expect(cellsOf([{ ...after, createdAt: "2026-11-02T10:05:00.000Z" }, { ...first, createdAt: "2026-11-02T10:00:00.000Z" } as ResearchEvidenceRecord])[0]).toMatchObject({ confirmed: true });
  });

  it("has none for a criterion not marked decisive, an empty cell, a quote that failed, a row no draft leads with, or a frame that marks none", () => {
    expect(cellsOf([on("x1", "firmness", "https://maker.example/a")])).toEqual([]);
    expect(cellsOf([{ ...on("x1", "durability", "https://maker.example/a"), quoteCheck: { reason: null, status: "not_verbatim" } } as ResearchEvidenceRecord])).toEqual([]);
    expect(cellsOf([on("y2", "durability", "https://maker.example/a")])).toEqual([]);
    expect(cellsOf([on("x1", "durability", "https://maker.example/a")], ["x1"], FRAME)).toEqual([]);
  });

  it("finds two sites whose figures each say what the other does not, and none in a figure one of them only adds to", () => {
    const [cell] = cellsOf([on("x1", "durability", "https://maker.example/a", "Load up to 130 kg per side."), on("x1", "durability", "https://shop.example/b", "Load up to 140 kg per side."),
      on("x1", "durability", "https://dealer.example/c", "Load up to 130 kg per side, 22 cm high.")]);
    expect(cell!.disagreements.map(({ figures, records }) => [records.map(({ url }) => url), figures.map((side) => side.map(({ text }) => text))])).toEqual([
      [["https://maker.example/a", "https://shop.example/b"], [["130 kg"], ["140 kg"]]],
      [["https://shop.example/b", "https://dealer.example/c"], [["140 kg"], ["130 kg", "22 cm"]]]
    ]);
    expect(cellsOf([on("x1", "durability", "https://maker.example/a", "Load 130 kg."), on("x1", "durability", "https://maker.example/b", "Load 140 kg.")])[0]!.disagreements).toEqual([]);
  });

  it("counts a confirmation of what the last draft recommends as progress for the rounds, and nothing else of a filled cell", () => {
    const records = [on("x1", "durability", "https://maker.example/a"), on("y2", "durability", "https://maker.example/c")];
    const matrix = { coverage: researchMatrixCoverage(KEYED, records), frame: KEYED };
    const draft = { pickRowKey: "x1", summary: { rowKeys: ["x1"], text: "t" } };
    const before = researchProgressCells(matrix, records, draft);
    const more = [...records, on("x1", "durability", "https://shop.example/b"), on("y2", "durability", "https://shop.example/d")];
    const after = researchProgressCells({ coverage: researchMatrixCoverage(KEYED, more), frame: KEYED }, more, draft);
    expect([...after].filter((cell) => !before.has(cell))).toEqual(["x1/durability#confirmed"]);
    expect(researchUnconfirmedKeyCells(matrix, records, draft).map(({ row }) => row.key)).toEqual(["x1"]);
  });
});

describe("what may change the frame", () => {
  const addRow = (key = "z9"): ResearchFrameChangeRequest => ({ change: "add_row", reason: "A shop sells it.", row: { key, label: "Z9" } });
  const addCriterion = (key = "price"): ResearchFrameChangeRequest => ({ change: "add_criterion", criterion: { criterion: "Price", key, why: "It decides the budget." }, reason: "Prices differ by half." });
  const addBranch = (key = "weight"): ResearchFrameChangeRequest => ({ branch: { cases: [{ key: "light", label: "Up to 70 kg" }, { key: "heavy", label: "Heavier" }], key, unknown: "The sleeper's weight" },
    change: "add_branch", reason: "Firmness depends on weight." });

  it("adds with who, when and why in the log, and changes nothing that was there", () => {
    const rowed = changedResearchFrame(FRAME, addRow(), STAMP);
    expect(rowed).toMatchObject({ ok: true, value: { criteria: FRAME.criteria, rows: [...FRAME.rows, { key: "z9", label: "Z9" }] } });
    const criterion = changedResearchFrame(FRAME, addCriterion(), STAMP);
    expect(criterion).toMatchObject({ ok: true, value: { changes: [{ ...STAMP, change: "add_criterion", key: "price", reason: "Prices differ by half." }], rows: FRAME.rows } });
    expect(changedResearchFrame(FRAME, addBranch(), STAMP)).toMatchObject({ ok: true, value: { branches: [{ key: "weight" }], changes: [{ change: "add_branch", key: "weight" }] } });
    expect(FRAME.changes).toEqual([]);
  });

  it("refuses a key it holds, naming it, since a key once used stays what it was", () => {
    expect(changedResearchFrame(FRAME, addRow("x1"), STAMP)).toMatchObject({ message: expect.stringContaining("x1"), ok: false });
    expect(changedResearchFrame(FRAME, addCriterion("durability"), STAMP)).toMatchObject({ message: expect.stringContaining("durability"), ok: false });
    const branched = changedResearchFrame(FRAME, addBranch(), STAMP);
    if (!branched.ok) throw new Error("Expected a change");
    expect(changedResearchFrame(branched.value, addBranch(), STAMP)).toMatchObject({ message: expect.stringContaining("weight"), ok: false });
  });

  it("refuses past the frame's bounds", () => {
    const limits = RESEARCH_FRAME_LIMITS;
    const numbered = <T,>(count: number, entry: (index: number) => T) => Array.from({ length: count }, (_value, index) => entry(index));
    expect(changedResearchFrame({ ...FRAME, rows: numbered(limits.rows, (index) => ({ key: `r${index}`, label: "R" })) }, addRow(), STAMP)).toMatchObject({ ok: false });
    expect(changedResearchFrame({ ...FRAME, criteria: numbered(limits.criteria, (index) => ({ criterion: "C", key: `c${index}`, why: "W" })) }, addCriterion(), STAMP)).toMatchObject({ ok: false });
    expect(changedResearchFrame({ ...FRAME, branches: numbered(limits.branches, (index) => ({ cases: [], key: `b${index}`, unknown: "U" })) }, addBranch(), STAMP)).toMatchObject({ ok: false });
    expect(changedResearchFrame({ ...FRAME, changes: numbered(limits.changes, () => ({ ...STAMP, change: "add_row" as const, key: "r", reason: "R" })) }, addRow(), STAMP)).toMatchObject({ ok: false });
  });
});

describe("the coverage port", () => {
  const signal = new AbortController().signal;
  const scope = { chatId: "chat", now: () => Date.parse(STAMP.at), researchRunId: "run-1", runId: "run-c", userId: "user" } as unknown as ResearchRunScope;

  /** A row in memory that yields between read and write, as a database does, so parallel writers really collide. */
  function memoryStore(frame: unknown = FRAME) {
    const held = { frame, version: 1 };
    const conflicts = { count: 0 };
    const store: ResearchFrameStore = {
      read: async () => {
        await Promise.resolve();
        return { ...held };
      },
      swap: async (_key, version, written) => {
        await Promise.resolve();
        if (version !== held.version) {
          conflicts.count += 1;
          return false;
        }
        held.frame = written;
        held.version += 1;
        return true;
      }
    };
    return { conflicts, held, store };
  }

  const portOf = (store: ResearchFrameStore, records: readonly ResearchEvidenceRecord[] = []) => {
    const parts: Pick<ResearchPorts, "evidence"> = { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: async () => records } };
    return createResearchCoverage({ store })(scope, parts);
  };
  const addRow = (index: number): ResearchFrameChangeRequest => ({ change: "add_row", reason: `Found ${index}.`, row: { key: `row-${index}`, label: `Row ${index}` } });

  it("reads the frame and the matrix against the records", async () => {
    const port = portOf(memoryStore().store, [finding("x1", "durability")]);
    await expect(port.frame(signal)).resolves.toEqual(FRAME);
    await expect(port.coverage(signal)).resolves.toMatchObject({ empty: 3, filled: 1 });
  });

  it("reads null for a run with no row, for one still scoping, and for a row no writer could have made", async () => {
    const none: ResearchFrameStore = { read: async () => null, swap: async () => false };
    await expect(portOf(none).frame(signal)).resolves.toBeNull();
    await expect(portOf(none).coverage(signal)).resolves.toBeNull();
    await expect(portOf(memoryStore(null).store).frame(signal)).resolves.toBeNull();
    await expect(portOf(memoryStore({ criteria: [] }).store).coverage(signal)).resolves.toBeNull();
    await expect(portOf(none).change(addRow(1), STAMP.by, signal)).resolves.toMatchObject({ ok: false });
  });

  it("stamps a change itself and writes it over the version it read", async () => {
    const memory = memoryStore();
    await expect(portOf(memory.store).change(addRow(1), STAMP.by, signal)).resolves.toMatchObject({ ok: true });
    expect(memory.held.version).toBe(2);
    expect((memory.held.frame as ResearchFrame).changes).toEqual([{ at: STAMP.at, by: STAMP.by, change: "add_row", key: "row-1", reason: "Found 1." }]);
  });

  it("loses nothing to parallel changes: as many writers as a chat can run all land, each with its reason", async () => {
    const memory = memoryStore();
    const writers = SUBAGENT_LIMITS.runningPerChat + 1;
    const results = await Promise.all(Array.from({ length: writers }, (_value, index) => portOf(memory.store).change(addRow(index), { name: `agent-${index}`, threadId: `thread-${index}` }, signal)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(memory.conflicts.count).toBeGreaterThan(0);
    const frame = memory.held.frame as ResearchFrame;
    expect(frame.rows).toHaveLength(FRAME.rows.length + writers);
    expect(new Set(frame.changes.map(({ reason }) => reason)).size).toBe(writers);
    expect(memory.held.version).toBe(1 + writers);
  });

  it("refuses visibly when a write keeps losing, and tells a stopped run so", async () => {
    const swap = vi.fn(async () => false);
    const port = portOf({ ...memoryStore().store, swap });
    await expect(port.change(addRow(1), STAMP.by, signal)).resolves.toMatchObject({ message: expect.stringContaining("Call this again"), ok: false });
    expect(swap.mock.calls.length).toBeLessThanOrEqual(SUBAGENT_LIMITS.runningPerChat + 1);
    await expect(port.change(addRow(1), STAMP.by, AbortSignal.abort(new Error("stopped")))).rejects.toThrow("stopped");
  });

  it("does not retry a refusal", async () => {
    const memory = memoryStore();
    const swap = vi.fn(memory.store.swap);
    await expect(portOf({ ...memory.store, swap }).change({ change: "add_row", reason: "R", row: { key: "x1", label: "X" } }, STAMP.by, signal)).resolves.toMatchObject({ ok: false });
    expect(swap).not.toHaveBeenCalled();
  });
});

describe("the frame's row", () => {
  const key = { chatId: "chat", researchRunId: "run-1", userId: "user" };
  const where = { chatId: "chat", modelRunId: "run-1", userId: "user" };

  it("is always read and written under its owner and chat, and a write only over the version read", async () => {
    const findFirst = vi.fn(async () => ({ frame: FRAME, version: 4 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const store = createResearchFrameStore({ researchFrame: { findFirst, updateMany } } as never);
    await expect(store.read(key)).resolves.toEqual({ frame: FRAME, version: 4 });
    expect(findFirst).toHaveBeenCalledWith({ select: { frame: true, version: true }, where });
    await expect(store.swap(key, 4, FRAME)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({ data: { frame: FRAME, version: { increment: 1 } }, where: { ...where, version: 4 } });
  });

  it("says when another writer won", async () => {
    const store = createResearchFrameStore({ researchFrame: { updateMany: async () => ({ count: 0 }) } } as never);
    await expect(store.swap(key, 4, FRAME)).resolves.toBe(false);
  });
});

describe("reading the matrix as a run goes", () => {
  const signal = new AbortController().signal;

  it("gives the frame with its coverage, and null for a run with no frame", async () => {
    await expect(researchMatrix(NOOP_RESEARCH_PORTS.coverage, signal)).resolves.toBeNull();
    const coverage = researchMatrixCoverage(FRAME, []);
    await expect(researchMatrix({ coverage: async () => coverage, frame: async () => FRAME }, signal)).resolves.toEqual({ coverage, frame: FRAME });
  });

  it("reads a failure as no frame: a matrix that cannot be read never costs the answer", async () => {
    const down = async () => { throw new Error("down"); };
    await expect(researchMatrix({ coverage: down, frame: down }, signal)).resolves.toBeNull();
    await expect(researchMatrix({ coverage: down, frame: down }, AbortSignal.abort())).resolves.toBeNull();
  });
});

describe("rounds", () => {
  const signal = new AbortController().signal;
  const limit = RESEARCH_ROUND_LIMITS.noNewCellRounds;

  /** Rounds over a list of what each read finds, the last one standing for all later reads. */
  function roundsOver(reads: readonly (readonly string[] | null)[]) {
    let at = 0;
    const read = vi.fn(async () => {
      const found = reads[Math.min(at, reads.length - 1)]!;
      at += 1;
      return found && new Set(found);
    });
    return { read, rounds: createResearchRounds(read) };
  }

  const roundOf = async (rounds: ReturnType<typeof createResearchRounds>, response: number) => {
    await rounds.enter(response, signal);
    rounds.ran(response);
  };

  it("stops after the limit of rounds in a row with no new cell, and not before", async () => {
    const { rounds } = roundsOver([[]]);
    await roundOf(rounds, 2);
    await roundOf(rounds, 3);
    expect(rounds.stopped()).toBe(false);
    await rounds.enter(4, signal);
    expect(rounds.stopped()).toBe(limit === 2);
  });

  it("counts from the cells a round found: a new one starts the count again", async () => {
    const { rounds } = roundsOver([[], [], ["a"], ["a"], ["a"]]);
    await roundOf(rounds, 2);
    await roundOf(rounds, 3);
    await roundOf(rounds, 4);
    await roundOf(rounds, 5);
    expect(rounds.stopped()).toBe(false);
    await rounds.enter(6, signal);
    expect(rounds.stopped()).toBe(true);
  });

  it("takes every call of one response as one round, reading once", async () => {
    const { read, rounds } = roundsOver([[]]);
    await Promise.all([roundOf(rounds, 2), roundOf(rounds, 2), roundOf(rounds, 2)]);
    expect(read).toHaveBeenCalledOnce();
    await roundOf(rounds, 3);
    await rounds.enter(4, signal);
    expect(rounds.stopped()).toBe(true);
  });

  it("counts for nothing a round in which no researcher ran", async () => {
    const { rounds } = roundsOver([[]]);
    await rounds.enter(2, signal);
    await rounds.enter(3, signal);
    await rounds.enter(4, signal);
    expect(rounds.stopped()).toBe(false);
  });

  it("settles what ran when a draft asks, and counts it once", async () => {
    const { rounds } = roundsOver([[]]);
    await roundOf(rounds, 2);
    await rounds.settle(signal);
    await rounds.settle(signal);
    expect(rounds.stopped()).toBe(false);
    await roundOf(rounds, 3);
    await rounds.settle(signal);
    expect(rounds.stopped()).toBe(true);
  });

  it("counts nothing it cannot read: with no matrix no run stops here, and a failed read neither stops nor resets", async () => {
    const none = roundsOver([null]);
    for (const response of [2, 3, 4, 5]) await roundOf(none.rounds, response);
    expect(none.rounds.stopped()).toBe(false);
    const flaky = roundsOver([[], [], null, [], []]);
    await roundOf(flaky.rounds, 2);
    await roundOf(flaky.rounds, 3);
    await roundOf(flaky.rounds, 4);
    await roundOf(flaky.rounds, 5);
    expect(flaky.rounds.stopped()).toBe(false);
    await flaky.rounds.enter(6, signal);
    expect(flaky.rounds.stopped()).toBe(true);
  });

  it("says how many cells this round has filled so far", async () => {
    const { rounds } = roundsOver([["a"]]);
    await expect(rounds.newCells(new Set(["a"]))).resolves.toBeNull();
    await roundOf(rounds, 2);
    await expect(rounds.newCells(new Set(["a", "b", "c"]))).resolves.toBe(2);
  });

  it("measures a filled cell as researchFilledCells does: not found counts", () => {
    expect(researchFilledCells(researchMatrixCoverage(FRAME, [notFound("x1", "firmness"), finding("y2", "firmness"), finding("y2", "durability", "not_verbatim")])).size).toBe(2);
  });
});

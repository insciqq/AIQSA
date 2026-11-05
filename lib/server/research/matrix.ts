import type { Prisma, PrismaClient } from "@prisma/client";
import {
  decodeResearchFrame,
  RESEARCH_FRAME_LIMITS,
  RESEARCH_ROUND_LIMITS,
  type DecodedResearch,
  type ResearchCriterion,
  type ResearchDraft,
  type ResearchEvidenceRecord,
  type ResearchFrame,
  type ResearchFrameChange,
  type ResearchFrameChangeRequest,
  type ResearchMatrixCoverage,
  type ResearchMatrixRow
} from "../../contracts/research";
import { SUBAGENT_LIMITS } from "../../contracts/subagents";
import { logEvent } from "../observability";
import { researchFrameEntries, researchFrameWithNote, researchFrameWithSetAside } from "./candidates";
import { RESEARCH_CHECK_REASONS } from "./evidenceStore";
import type { ResearchCoveragePort, ResearchPorts, ResearchRunScope } from "./ports";
import { claimFigures, figuresNotIn, type ClaimFigure } from "./quoteCheck";
import { researchRegistrableDomain } from "./sourceQuality";

/**
 * The matrix (`ResearchCoveragePort`): rows by criteria, the holes of which plan each round of researchers. A cell's state always comes
 * from the live records, so a correction moves it and nothing else has to; `ResearchFrame.frame` holds only the rows, the criteria,
 * why they changed and the candidates noted beside them (`candidates.ts`). It only grows, and parallel researchers change it, so a write
 * is a compare and swap on `version`.
 */

/**
 * The row of a frame with none, such as a knowledge question's: each criterion is one cell, under this key, which no row can have, and a
 * record at a criterion is at it whatever row it names, as `not_found` and `dataset` must name one. Rows take over once they exist.
 */
export const RESEARCH_WHOLE_QUESTION_ROW = "";

const cellId = (rowKey: string, criterionKey: string) => `${rowKey}/${criterionKey}`;

/** Why a record stands at its cell, or null when it fills none: a quote known to be bad fills nothing until a correction replaces it. */
function cellWord(record: ResearchEvidenceRecord): "filled" | "not_found" | null {
  if (record.kind === "not_found") return "not_found";
  if (record.kind !== "finding" && record.kind !== "dataset") return null;
  const check = record.quoteCheck?.status;
  return check === "found" || check === "not_checked" ? "filled" : null;
}

/**
 * The matrix against the live records (`ResearchEvidencePort.records`): what a correction superseded is not among them. A record whose
 * row or criterion the frame does not know fills no cell, and fills one as it stands once that key is added.
 */
export function researchMatrixCoverage(frame: ResearchFrame, records: readonly ResearchEvidenceRecord[]): ResearchMatrixCoverage {
  const rowless = frame.rows.length === 0;
  const held = new Map<string, Record<"filled" | "not_found", string[]>>();
  for (const record of records) {
    const word = cellWord(record);
    const rowKey = rowless ? RESEARCH_WHOLE_QUESTION_ROW : record.rowKey;
    if (word === null || rowKey === null || record.criterionKey === null) continue;
    const id = cellId(rowKey, record.criterionKey);
    const at = held.get(id) ?? { filled: [], not_found: [] };
    at[word].push(record.id);
    held.set(id, at);
  }
  const rowKeys = rowless ? [RESEARCH_WHOLE_QUESTION_ROW] : frame.rows.map((row) => row.key);
  const cells = rowKeys.flatMap((rowKey) => frame.criteria.map(({ key: criterionKey }) => {
    const at = held.get(cellId(rowKey, criterionKey));
    if (at && at.filled.length > 0) return { criterionKey, recordIds: at.filled, rowKey, state: "filled" as const };
    if (at && at.not_found.length > 0) return { criterionKey, recordIds: at.not_found, rowKey, state: "not_found" as const };
    return { criterionKey, recordIds: [], rowKey, state: "empty" as const };
  }));
  const empty = cells.filter((cell) => cell.state === "empty").length;
  return { cells, empty, filled: cells.length - empty };
}

/** The cells a round is measured by: a cell recorded as not found counts as filled. */
export function researchFilledCells(coverage: ResearchMatrixCoverage): ReadonlySet<string> {
  return new Set(coverage.cells.filter((cell) => cell.state !== "empty").map((cell) => cellId(cell.rowKey, cell.criterionKey)));
}

/** What a row still lacks. `row` is null on a frame with no rows. */
export type ResearchEmptyRow = Readonly<{ criteria: readonly ResearchCriterion[]; row: ResearchMatrixRow | null }>;

/** The empty cells by row, in the frame's order, with their words for a reader and their keys for a researcher. */
export function researchEmptyByRow({ coverage, frame }: ResearchMatrix): readonly ResearchEmptyRow[] {
  const empty = new Set(coverage.cells.filter((cell) => cell.state === "empty").map((cell) => cellId(cell.rowKey, cell.criterionKey)));
  const rows: readonly (ResearchMatrixRow | null)[] = frame.rows.length > 0 ? frame.rows : [null];
  return rows.flatMap((row) => {
    const criteria = frame.criteria.filter(({ key }) => empty.has(cellId(row?.key ?? RESEARCH_WHOLE_QUESTION_ROW, key)));
    return criteria.length > 0 ? [{ criteria, row }] : [];
  });
}

/** The criteria the plan marked decisive: the key specifications a pick depends on (`RESEARCH_FRAME_LIMITS.decisiveCriteria`). */
export const researchKeySpecs = (frame: ResearchFrame): readonly ResearchCriterion[] => frame.criteria.filter(({ decisive }) => decisive === true);

type LeadingDraft = Pick<ResearchDraft, "branchPicks" | "pickRowKey" | "summary"> | null | undefined;

/** The options a draft leads with, in its order: its pick, each case's pick and the options its summary recommends. None before a first draft. */
export function researchLeadingRows(draft: LeadingDraft): readonly string[] {
  if (!draft) return [];
  return [...new Set([...draft.pickRowKey ? [draft.pickRowKey] : [], ...draft.branchPicks?.map(({ rowKey }) => rowKey) ?? [], ...draft.summary?.rowKeys ?? []])];
}

export type ResearchClaimRecord = Extract<ResearchEvidenceRecord, Readonly<{ kind: "dataset" | "finding" }>>;

/**
 * A record's site, from its link where the store has none: two pages of one site are one source. None for a record whose quote was found only on another page
 * than the one it cites (`RESEARCH_CHECK_REASONS.otherPage`): its link's site is not what showed it, so it confirms no site.
 */
export const researchRecordSite = (record: ResearchClaimRecord): string | null => record.quoteCheck?.reason === RESEARCH_CHECK_REASONS.otherPage ? null
  : record.registrableDomain ?? researchRegistrableDomain(record.url);

/** Whether a record came after another, by the clock and within a run by its sequence; records of two runs at one instant are in no order. */
function later(one: ResearchEvidenceRecord, other: ResearchEvidenceRecord): boolean {
  const [at, otherAt] = [Date.parse(one.createdAt), Date.parse(other.createdAt)];
  if (Number.isFinite(at) && Number.isFinite(otherAt) && at !== otherAt) return at > otherAt;
  return one.runId === other.runId && one.sequence > other.sequence;
}

/** Two records of one key specification from different sites, with the figures each gives that the other does not, in the same order. */
export type ResearchDisagreement = Readonly<{ figures: readonly [readonly ClaimFigure[], readonly ClaimFigure[]]; records: readonly [ResearchClaimRecord, ResearchClaimRecord] }>;

/** A key specification of an option as its live records fill it. */
export type ResearchKeyCell = Readonly<{
  /** Two sites hold it, or an agent recorded that no further one shows it (`not_found` in a filled cell): nothing more is asked of it. */
  confirmed: boolean;
  criterion: ResearchCriterion;
  disagreements: readonly ResearchDisagreement[];
  records: readonly ResearchClaimRecord[];
  row: ResearchMatrixRow;
  sites: readonly string[];
}>;

/** A cell's records compared pairwise for disagreements: past this a cell is no specification any more, and the first ones written stand for it. */
const KEY_CELL_RECORDS = 12;

/**
 * The pairs of sites whose figures differ within a shared dimension, as two shops stating a load of 130 and of 140 kg do. Figures with no known dimension compare
 * only with others with none; different dimensions in one cell are no disagreement. Which figure is right stays the report's to say.
 */
function disagreementsOf(records: readonly ResearchClaimRecord[]): readonly ResearchDisagreement[] {
  const read = records.slice(0, KEY_CELL_RECORDS).map((record) => ({ figures: claimFigures(record.claim), record, site: researchRecordSite(record) }));
  return read.flatMap((one, index) => read.slice(index + 1).flatMap((other): ResearchDisagreement[] => {
    if (one.site === null || other.site === null || one.site === other.site) return [];
    const oneMissing = figuresNotIn(one.figures, other.record.claim);
    const otherMissing = figuresNotIn(other.figures, one.record.claim);
    const figures = [
      oneMissing.filter(({ scale }) => otherMissing.some((figure) => figure.scale?.dimension === scale?.dimension)),
      otherMissing.filter(({ scale }) => oneMissing.some((figure) => figure.scale?.dimension === scale?.dimension))
    ] as const;
    return figures[0].length > 0 && figures[1].length > 0 ? [{ figures, records: [one.record, other.record] }] : [];
  }));
}

/**
 * The key specifications of these rows that hold evidence, row by row in their order (operator decision 2026-11-02): a real run's pick rested on one seller's figures
 * while sellers disagreed on its load and height, so a leading option's key specifications rest on two sites, and only theirs: the 70-minute loop of one more detail of
 * a filled cell cannot come back. A row the matrix lacks has none.
 */
export function researchKeyCells(matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], rowKeys: readonly string[]): readonly ResearchKeyCell[] {
  const keySpecs = researchKeySpecs(matrix.frame);
  if (keySpecs.length === 0 || rowKeys.length === 0) return [];
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const cells = new Map(matrix.coverage.cells.map((cell) => [cellId(cell.rowKey, cell.criterionKey), cell] as const));
  return rowKeys.flatMap((rowKey) => {
    const row = matrix.frame.rows.find(({ key }) => key === rowKey);
    return row ? keySpecs.flatMap((criterion): ResearchKeyCell[] => {
      const cell = cells.get(cellId(rowKey, criterion.key));
      if (cell?.state !== "filled") return [];
      const held = cell.recordIds.flatMap((id) => {
        const record = byId.get(id);
        return record && (record.kind === "finding" || record.kind === "dataset") ? [record] : [];
      });
      // Records that could not be read say nothing of the cell, so nothing is asked of it.
      if (held.length === 0) return [];
      const sites = [...new Set(held.flatMap((record) => researchRecordSite(record) ?? []))];
      // Only a not_found written after the cell's last record says a further site was looked for: one written before says only that the first was not found yet.
      const sought = records.some((record) => record.kind === "not_found" && record.rowKey === rowKey && record.criterionKey === criterion.key &&
        held.every((claim) => later(record, claim)));
      return [{ confirmed: sites.length >= 2 || sought, criterion, disagreements: disagreementsOf(held), records: held, row, sites }];
    }) : [];
  });
}

/** The key specifications of the options a draft leads with that one site alone holds: what the coverage line and the gap check ask a second site for. */
export const researchUnconfirmedKeyCells = (matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], draft: LeadingDraft): readonly ResearchKeyCell[] =>
  researchKeyCells(matrix, records, researchLeadingRows(draft)).filter(({ confirmed }) => !confirmed);

/**
 * What a round is measured by: the cells filled, and the key specifications of the last draft's options confirmed, since a round that confirmed what was asked of it
 * found something. Only those options': a confirmation nobody asked for buys no further round.
 */
export function researchProgressCells(matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], draft: LeadingDraft): ReadonlySet<string> {
  const confirmed = researchKeyCells(matrix, records, researchLeadingRows(draft)).filter((cell) => cell.confirmed).map((cell) => `${cellId(cell.row.key, cell.criterion.key)}#confirmed`);
  return new Set([...researchFilledCells(matrix.coverage), ...confirmed]);
}

const refused = (message: string) => ({ message, ok: false as const });
const known = (what: string, key: string) => refused(`Nothing was changed: ${key} is already a ${what} of the matrix, so use that key.`);
const full = (what: string, limit: number) => refused(`Nothing was changed: the matrix holds its ${limit} ${what}. Work with what it has.`);

/**
 * The frame with one addition and its reason in the log, or with a candidate noted or set aside beside the matrix (`candidates.ts`), which counts toward
 * the same bound. Nothing is changed or removed, and a key once used stays what it was.
 */
export function changedResearchFrame(frame: ResearchFrame, request: ResearchFrameChangeRequest, stamp: Pick<ResearchFrameChange, "at" | "by">): DecodedResearch<ResearchFrame> {
  const limits = RESEARCH_FRAME_LIMITS;
  if (researchFrameEntries(frame) >= limits.changes) return full("changes", limits.changes);
  const logged = (change: ResearchFrameChange["change"], key: string): readonly ResearchFrameChange[] => [...frame.changes, { ...stamp, change, key, reason: request.reason }];
  switch (request.change) {
    case "add_row": {
      const { row } = request;
      if (frame.rows.some(({ key }) => key === row.key)) return known("row", row.key);
      if (frame.rows.length >= limits.rows) return full("rows", limits.rows);
      return { ok: true, value: { ...frame, changes: logged("add_row", row.key), rows: [...frame.rows, row] } };
    }
    case "add_criterion": {
      const { criterion } = request;
      if (frame.criteria.some(({ key }) => key === criterion.key)) return known("criterion", criterion.key);
      if (frame.criteria.length >= limits.criteria) return full("criteria", limits.criteria);
      return { ok: true, value: { ...frame, changes: logged("add_criterion", criterion.key), criteria: [...frame.criteria, criterion] } };
    }
    case "add_branch": {
      const { branch } = request;
      if (frame.branches.some(({ key }) => key === branch.key)) return known("branch", branch.key);
      if (frame.branches.length >= limits.branches) return full("branches", limits.branches);
      return { ok: true, value: { ...frame, branches: [...frame.branches, branch], changes: logged("add_branch", branch.key) } };
    }
    case "note_candidate": return researchFrameWithNote(frame, request, stamp);
    case "set_aside": return researchFrameWithSetAside(frame, request, stamp);
  }
}

export type ResearchFrameKey = Readonly<{ chatId: string; researchRunId: string; userId: string }>;

/** The `ResearchFrame` row's frame, always under the owner and chat of its key. */
export type ResearchFrameStore = Readonly<{
  read(key: ResearchFrameKey): Promise<Readonly<{ frame: unknown; version: number }> | null>;
  /** Writes only over `version`, and says whether it did. */
  swap(key: ResearchFrameKey, version: number, frame: ResearchFrame): Promise<boolean>;
}>;

export function createResearchFrameStore(client: Pick<PrismaClient, "researchFrame">): ResearchFrameStore {
  const row = ({ chatId, researchRunId, userId }: ResearchFrameKey) => ({ chatId, modelRunId: researchRunId, userId });
  return {
    read: (key) => client.researchFrame.findFirst({ select: { frame: true, version: true }, where: row(key) }),
    async swap(key, version, frame) {
      const { count } = await client.researchFrame.updateMany({ data: { frame: frame as unknown as Prisma.InputJsonValue, version: { increment: 1 } }, where: { ...row(key), version } });
      return count === 1;
    }
  };
}

const NO_FRAME = "Nothing was changed: this research has no matrix yet.";
const FRAME_BUSY = "Nothing was changed: other agents kept changing the matrix. Call this again.";

/**
 * Each write lost means another agent's won, and at most this many write at once, so a burst of parallel changes all land. Past it
 * the agent is told, never left thinking a row or a reason was kept.
 */
const FRAME_WRITE_ATTEMPTS = SUBAGENT_LIMITS.runningPerChat + 1;

/** One port per run (`ResearchPortFactories.coverage`), on the frame of the research run. */
export function createResearchCoverage(deps: Readonly<{ store: ResearchFrameStore }>) {
  return (run: ResearchRunScope, parts: Pick<ResearchPorts, "evidence">): ResearchCoveragePort => {
    const key = { chatId: run.chatId, researchRunId: run.researchRunId, userId: run.userId };

    /** A row no writer here could have made reads as no frame: the run goes on as one with none, which is what such a run can do. */
    async function current() {
      const row = await deps.store.read(key);
      if (row === null || row.frame === null) return null;
      const decoded = decodeResearchFrame(row.frame);
      if (decoded.ok) return { frame: decoded.value, version: row.version };
      logEvent("service_operation", { action: "degrade", code: "research_frame_invalid", outcome: "degraded", run_id: run.runId, stage: "read", subsystem: "database" });
      return null;
    }

    async function frame(signal: AbortSignal) {
      signal.throwIfAborted();
      return (await current())?.frame ?? null;
    }

    return {
      async change(request, by, signal) {
        for (let attempt = 0; attempt < FRAME_WRITE_ATTEMPTS; attempt += 1) {
          signal.throwIfAborted();
          const stored = await current();
          if (!stored) return refused(NO_FRAME);
          const changed = changedResearchFrame(stored.frame, request, { at: new Date(run.now()).toISOString(), by });
          if (!changed.ok || await deps.store.swap(key, stored.version, changed.value)) return changed;
        }
        return refused(FRAME_BUSY);
      },
      async coverage(signal) {
        const stands = await frame(signal);
        return stands && researchMatrixCoverage(stands, await parts.evidence.records(signal));
      },
      frame
    };
  };
}

export type ResearchMatrix = Readonly<{ coverage: ResearchMatrixCoverage; frame: ResearchFrame }>;

/**
 * The frame and its coverage, for what a run reads as it goes. Null for a run with no frame, and for a read that failed, Stop included:
 * what reads this goes on as a run with no frame does, since a matrix that could not be read never costs the answer.
 */
export async function researchMatrix(port: Pick<ResearchCoveragePort, "coverage" | "frame">, signal: AbortSignal): Promise<ResearchMatrix | null> {
  try {
    const [frame, coverage] = await Promise.all([port.frame(signal), port.coverage(signal)]);
    return frame && coverage ? { coverage, frame } : null;
  } catch (error) {
    if (!signal.aborted) logEvent("service_operation", { action: "degrade", code: "research_matrix_unreadable", error, outcome: "degraded", stage: "read", subsystem: "database" });
    return null;
  }
}

type ResearchRound = { before: Promise<ReadonlySet<string> | null>; ran: boolean; response: number };

export type ResearchRounds = ReturnType<typeof createResearchRounds>;

/**
 * The rounds of one run. A round is the researcher calls of one response, whatever each came to, and it filled a new cell if the matrix holds
 * one it did not when the round started. A batch runs only a few at once and starts the rest as those end, so no count of running calls
 * says a round is over: it is counted when the next one starts, or when a draft asks. A round whose turns all failed counts like any other. One
 * in which no turn ran counts for nothing, and with no matrix to read neither does one that did, so a run with no frame never stops here.
 */
export function createResearchRounds(read: (signal: AbortSignal) => Promise<ReadonlySet<string> | null>) {
  let round: ResearchRound | null = null;
  /** Rounds in a row that filled no new cell. */
  let barren = 0;
  const counted = (before: ReadonlySet<string> | null, after: ReadonlySet<string> | null) => {
    if (before && after) barren = [...after].some((cell) => !before.has(cell)) ? 0 : barren + 1;
  };
  return {
    /** What a researcher's call of this response awaits before it starts: the first opens the round, and closes the one before. */
    enter(response: number, signal: AbortSignal): Promise<unknown> {
      if (round?.response !== response) {
        const ended = round;
        round = { before: read(signal).then(async (filled) => {
          if (ended?.ran) counted(await ended.before, filled);
          return filled;
        }), ran: false, response };
      }
      return round.before;
    },
    /** A researcher's turn of this response ran to its end, however that went. */
    ran(response: number): void {
      if (round?.response === response) round.ran = true;
    },
    /** How many cells this round has filled so far; null with nothing to compare. */
    async newCells(filled: ReadonlySet<string>): Promise<number | null> {
      const before = await round?.before;
      return before ? [...filled].filter((cell) => !before.has(cell)).length : null;
    },
    /** A draft arrived: what ran so far is a round, so what the gates read of it is settled. */
    async settle(signal: AbortSignal): Promise<void> {
      const ended = round;
      if (!ended?.ran) return;
      round = null;
      counted(await ended.before, await read(signal));
    },
    /** No further researcher starts, and nothing sends a draft back for research. */
    stopped: () => barren >= RESEARCH_ROUND_LIMITS.noNewCellRounds
  };
}

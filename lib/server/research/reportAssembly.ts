import {
  RESEARCH_LIMITS, type ResearchCriterion, type ResearchDataset, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFinding, type ResearchMatrixCell, type ResearchUnreachable
} from "../../contracts/research";
import { researchDatasetWords } from "./dataCollection";
import { RESEARCH_WHOLE_QUESTION_ROW, researchMatrix, type ResearchMatrix } from "./matrix";
import { researchAnswerText, researchNote, type ResearchNoteKey } from "./notes";
import type { ResearchPorts, ResearchReportEnding, ResearchReportPort, ResearchRunScope } from "./ports";
import { reportCheckGate } from "./reportCheck";
import { researchSourceAgeMonths, researchSourceClass, researchSourceCounts, researchSourceStanding, researchRegistrableDomain } from "./sourceQuality";

/**
 * What the server makes of the records for a report: a draft's findings from its ids, the list of ids the main agent cites from, and the answer it
 * builds when no draft can be finished (`ResearchReportPort.compose`). The answer states what records hold and nothing else, so it picks nothing: a
 * conclusion is the model's to draw, and the note says so.
 */

type ClaimRecord = Extract<ResearchEvidenceRecord, Readonly<{ kind: "dataset" | "finding" }>>;

const isClaim = (record: ResearchEvidenceRecord): record is ClaimRecord => record.kind === "finding" || record.kind === "dataset";

/** A quote known to be bad stays out, as it fills no cell (`researchMatrixCoverage`): it stands until a correction replaces it, and no reader should take it for evidence. */
const quoteHolds = (record: ClaimRecord) => record.quoteCheck?.status === "found" || record.quoteCheck?.status === "not_checked";

const cut = (text: string, max: number) => {
  if (max <= 0) return "";
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
};

/**
 * A dataset as a claim a gate can judge: what it found, how, and what it left out, with one example the quote check can find. The example's own link, since
 * that is the page its quote is on (`quotesOf`, `evidenceStore.ts`). A count is more than one review shows, so the claim says it was counted.
 */
function datasetFinding(record: Extract<ClaimRecord, { kind: "dataset" }>): Pick<ResearchFinding, "claim" | "quote" | "url"> {
  const { dataset } = record;
  const found = cut(`${record.claim} Counted by script: ${researchDatasetWords(dataset)}`, RESEARCH_LIMITS.claimCharacters);
  const how = ` Method: ${dataset.method} Left out: ${dataset.leftOut}`;
  const example = dataset.examples[0]!;
  return { claim: `${found}${cut(how, RESEARCH_LIMITS.claimCharacters - Array.from(found).length)}`, quote: example.quote, url: example.url };
}

/**
 * What `researchSourceClass` and `researchSourceStanding` need of a run's records: they read all they are given on every call, and work that never yields cannot be stopped at a run's end. At
 * the limits that held the server for seconds. They read only a record's site, class and text group, so one record for each gives the same answer at the cost of the run's sites, not its records.
 */
function sourceWitnesses(records: readonly ResearchEvidenceRecord[]): readonly ResearchEvidenceRecord[] {
  const site = (record: ResearchEvidenceRecord) => record.registrableDomain ?? (record.kind === "unreachable" ? record.target : record.kind === "not_found" ? null : record.url);
  return [...new Map(records.map((record) => [JSON.stringify([site(record), record.sourceClass, record.textGroupKey]), record] as const)).values()];
}

/** A record as the gates read a finding, under its effective class and standing: a seller's own "test" is a party's claim whoever filed it. `not_found` and `unreachable` claim nothing. */
function findingOf(record: ResearchEvidenceRecord, witnesses: readonly ResearchEvidenceRecord[]): ResearchFinding | null {
  if (!isClaim(record)) return null;
  const words = record.kind === "finding" ? { claim: record.claim, quote: record.quote, url: record.url } : datasetFinding(record);
  return { ...words, recordId: record.id, sourceClass: researchSourceClass(record, witnesses) ?? record.sourceClass, standing: researchSourceStanding(record, witnesses) ?? record.standing };
}

/**
 * A draft with its findings filled from the records its ids name, so every gate goes on reading `draft.findings`. A corrected id reads as its correction. The rows it picks
 * come first, because a check that cannot read everything reads from the top. `not_found` claims nothing. Cited `unreachable` records make the list only when the draft has none:
 * the model's is curated and in the report's language, and joining a record to it repeats a site under another target in a researcher's words. The same ids and records give
 * the same list, since a send back names findings by position (`verifier.ts`) and an approval rebuilds this from the transcript's ids.
 */
export function researchDraftWithRecords(draft: ResearchDraft, records: readonly ResearchEvidenceRecord[]): ResearchDraft {
  if (!draft.recordIds) return draft;
  const live = new Map(records.map((record) => [record.id, record] as const));
  const corrections = new Map(records.flatMap((record) => record.supersedes === null ? [] : [[record.supersedes, record] as const]));
  const cited = [...new Map(draft.recordIds.flatMap((id) => {
    const record = live.get(id) ?? corrections.get(id);
    return record ? [[record.id, record] as const] : [];
  })).values()];
  const picked = new Set([...draft.pickRowKey ? [draft.pickRowKey] : [], ...draft.branchPicks?.map(({ rowKey }) => rowKey) ?? []]);
  const first = (record: ResearchEvidenceRecord) => record.rowKey !== null && picked.has(record.rowKey) ? 0 : 1;
  const witnesses = sourceWitnesses(records);
  const findings = [...cited].sort((one, other) => first(one) - first(other)).flatMap((record) => findingOf(record, witnesses) ?? []);
  if (draft.unreachable.length > 0) return { ...draft, findings };
  const unreachable: readonly ResearchUnreachable[] = cited.flatMap((record) => record.kind === "unreachable" ? [{ reason: record.reason, sourceClass: record.sourceClass, target: record.target }] : []);
  return { ...draft, findings, unreachable: unreachable.slice(0, RESEARCH_LIMITS.unreachable) };
}

/** A line the model reads, one record to it: no text of a record may read as another record. */
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();

const RECORD_LIST_CHARACTERS = 8_000;
const LISTED_CLAIM_CHARACTERS = 120;
/**
 * The list a Continue's start hands over at once: no researcher need follow, so no next result can be counted on, and it holds as many of the longest lines as a draft may cite.
 * It stands after the start's own fields, so past what one result shows inline the model reads the rest by the result's reference, and those fields stay where `researchOfTurn` finds them.
 */
export const PICKED_UP_RECORD_LIST_CHARACTERS = RESEARCH_LIMITS.findings * 300;

/**
 * What the main agent cites from: `record_evidence` gives a record's id only to the agent that wrote it, so without this list it has no ids of its researchers' records.
 * It gives the records not listed yet, moving them to `listed`, as many as its bound holds: the next result takes the rest, and a send back names what a draft needs.
 */
export function researchRecordList(records: readonly ResearchEvidenceRecord[], listed: Set<string>, characters = RECORD_LIST_CHARACTERS): string | null {
  const lines: string[] = [];
  let size = 0;
  let left = 0;
  for (const record of records) {
    if (!isClaim(record) || listed.has(record.id)) continue;
    const cell = [record.rowKey, record.criterionKey].filter((key) => key !== null).join(" / ") || "no cell";
    const line = `${record.id} | ${cell} | ${cut(oneLine(record.claim), LISTED_CLAIM_CHARACTERS)}${quoteHolds(record) ? "" : " | its quote did not check out"}`;
    if (size + line.length + 1 > characters) {
      left += 1;
      continue;
    }
    size += line.length + 1;
    lines.push(line);
    listed.add(record.id);
  }
  if (lines.length === 0) return null;
  return [`Records to cite by id in record_ids (from the server)${left > 0 ? `, and ${left} more with the next report` : ""}:`, ...lines].join("\n");
}

/** The composed report's own words; like every word of the product's own, they are English (operator decision 2026-11-02). */
const WORDS = { added: "added during research", asOf: "Data as of", claimed: "claimed", criteria: "What was compared and why it matters", criterion: "Criterion",
  classes: { action_channel: "sellers", independent_tests: "tests", owner_reviews: "owners", primary_official: "official" },
  found: "What was found", independent: "Independent sources", leftOut: (count: number) => `Left out, as their quotes did not check out: ${count}.`,
  months: (count: number) => `${count} mo. old`, more: (count: number) => `and ${count} more`,
  noData: "no data", notFound: "not found", notVerified: "not verified", option: "Option", other: "Other records", recorded: "What was recorded",
  sources: "Sources", title: "What research recorded", unreachable: "Could not be reached" } as const;

/** Text of a record inside the answer: it came off web pages, so nothing in it may become a link, an image, a table cell or markup. */
const safe = (text: string) => oneLine(text).replace(/[|*`[\]<>\\]+/gu, " ").replace(/\s+/gu, " ").trim();

/** A link Markdown and a table cell both keep whole. */
const linkTarget = (url: string) => url.replace(/[()|<>\s]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

type Composing = Readonly<{ now: Date; records: readonly ResearchEvidenceRecord[]; witnesses: readonly ResearchEvidenceRecord[] }>;

const CELL_CHARACTERS = 140;
const LINE_CHARACTERS = 300;
const STANDING_ORDER = { claimed: 1, confirmed: 0, not_verified: 2 } as const;

/** Its source, as a link with the page's own age where it gave a date. */
function sourceLink(record: ClaimRecord, { now }: Composing): string {
  const age = researchSourceAgeMonths(record, now);
  const site = safe(record.registrableDomain ?? researchRegistrableDomain(record.url) ?? WORDS.sources);
  return `[${site}${age === null || age === 0 ? "" : `, ${WORDS.months(age)}`}](${linkTarget(record.url)})`;
}

/** A claim in a few words, with its standing kept apart and its source. */
function claimWords(record: ClaimRecord, composing: Composing, characters: number): string {
  const standing = researchSourceStanding(record, composing.witnesses);
  const mark = standing === "claimed" ? ` (${WORDS.claimed})` : standing === "not_verified" ? ` (${WORDS.notVerified})` : "";
  const tally = record.kind === "dataset" ? ` ${safe(researchDatasetWords(record.dataset))}` : "";
  return `${cut(safe(record.claim), characters)}${tally}${mark} ${sourceLink(record, composing)}`;
}

function cellWords(cell: ResearchMatrixCell | undefined, composing: Composing): string {
  const { records, witnesses } = composing;
  const words = WORDS;
  if (!cell || cell.state === "empty") return words.noData;
  const held = cell.recordIds.flatMap((id) => records.find((record) => record.id === id) ?? []);
  if (cell.state === "not_found") {
    const [record] = held;
    return record?.kind === "not_found" ? `${words.notFound}: ${cut(safe(record.reason), CELL_CHARACTERS / 2)}` : words.notFound;
  }
  const claims = held.filter(isClaim).map((record) => ({ rank: STANDING_ORDER[researchSourceStanding(record, witnesses) ?? "not_verified"], record }));
  const [first, ...rest] = claims;
  if (!first) return words.noData;
  const best = rest.reduce((one, other) => other.rank < one.rank ? other : one, first);
  return `${claimWords(best.record, composing, CELL_CHARACTERS)}${rest.length > 0 ? ` (+${rest.length})` : ""}`;
}

/** As many lines as a section's share of the bound holds, and how many it left. */
function within(lines: readonly string[], characters: number): Readonly<{ kept: readonly string[]; left: number }> {
  let size = 0;
  const kept = lines.filter((line) => {
    size += line.length + 1;
    return size <= characters;
  });
  return { kept, left: lines.length - kept.length };
}

/** Of the bound on a report: a table with the matrix's limits and full-length links could pass it alone. */
const TABLE_CHARACTERS = Math.floor(RESEARCH_LIMITS.reportCharacters * 0.6);
const LIST_CHARACTERS = Math.floor(RESEARCH_LIMITS.reportCharacters * 0.15);

function criteriaSection({ frame }: ResearchMatrix): string {
  const words = WORDS;
  const added = new Map(frame.changes.filter(({ change }) => change === "add_criterion").map(({ key, reason }) => [key, reason] as const));
  const line = ({ criterion, key, why }: ResearchCriterion) => {
    const reason = added.get(key);
    return `- **${safe(criterion)}**: ${cut(safe(why), LINE_CHARACTERS)}${reason === undefined ? "" : ` (${words.added}: ${cut(safe(reason), LINE_CHARACTERS)})`}`;
  };
  return [`### ${words.criteria}`, ...frame.criteria.map(line)].join("\n");
}

const tableRow = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;

function tableSection({ coverage, frame }: ResearchMatrix, composing: Composing): string {
  const words = WORDS;
  const cellAt = (rowKey: string, criterionKey: string) => coverage.cells.find((cell) => cell.rowKey === rowKey && cell.criterionKey === criterionKey);
  if (frame.rows.length === 0) {
    return [tableRow([words.criterion, words.found]), tableRow(["---", "---"]),
      ...frame.criteria.map(({ criterion, key }) => tableRow([safe(criterion), cellWords(cellAt(RESEARCH_WHOLE_QUESTION_ROW, key), composing)]))].join("\n");
  }
  const lines = frame.rows.map(({ key, label }) => tableRow([safe(label), ...frame.criteria.map((criterion) => cellWords(cellAt(key, criterion.key), composing))]));
  const { kept, left } = within(lines, TABLE_CHARACTERS);
  return [tableRow([words.option, ...frame.criteria.map(({ criterion }) => safe(criterion))]), tableRow(["---", ...frame.criteria.map(() => "---")]), ...kept,
    ...left > 0 ? ["", words.more(left)] : []].join("\n");
}

/** What holds no place in the table, or everything when no matrix could be read. */
function otherRecords(matrix: ResearchMatrix | null, composing: Composing): string | null {
  const { records } = composing;
  const words = WORDS;
  const placed = new Set(matrix?.coverage.cells.flatMap(({ recordIds }) => recordIds) ?? []);
  const lines = records.flatMap((record) => {
    if (placed.has(record.id)) return [];
    if (isClaim(record)) return quoteHolds(record) ? [`- ${claimWords(record, composing, LINE_CHARACTERS)}`] : [];
    return record.kind === "not_found" ? [`- ${words.notFound}: ${cut(safe(`${record.rowKey} / ${record.criterionKey}: ${record.reason}`), LINE_CHARACTERS)}`] : [];
  });
  if (lines.length === 0) return null;
  const { kept, left } = within(lines, LIST_CHARACTERS);
  return [`### ${matrix ? words.other : words.recorded}`, ...kept, ...left > 0 ? [`- ${words.more(left)}`] : []].join("\n");
}

function unreachableSection({ records }: Composing): string | null {
  const lines = records.flatMap((record) => record.kind === "unreachable" ? [`- ${cut(safe(record.target), LINE_CHARACTERS)}: ${cut(safe(record.reason), LINE_CHARACTERS)}`] : []);
  if (lines.length === 0) return null;
  const { kept, left } = within(lines, LIST_CHARACTERS);
  return [`### ${WORDS.unreachable}`, ...kept, ...left > 0 ? [`- ${WORDS.more(left)}`] : []].join("\n");
}

function sourcesLine({ now, records }: Composing): string {
  const words = WORDS;
  const { byClass, independent } = researchSourceCounts(records.filter((record) => isClaim(record) && quoteHolds(record)), records);
  const classes = Object.entries(byClass).filter(([, count]) => count > 0).map(([name, count]) => `${words.classes[name as keyof typeof byClass]}: ${count}`);
  return `${words.asOf} ${now.toISOString().slice(0, 10)}. ${words.independent}: ${independent}${classes.length > 0 ? ` (${classes.join(", ")})` : ""}.`;
}

const ENDING_NOTES: Readonly<Record<ResearchReportEnding, ResearchNoteKey>> = { failed: "composed_failed", no_report: "composed_no_report", timed_out: "composed_timed_out" };

/** The answer from the records, with its note. Null when nothing was recorded. */
export function composeResearchReport(input: Readonly<{ ended: ResearchReportEnding; matrix: ResearchMatrix | null; now: Date; records: readonly ResearchEvidenceRecord[] }>): string | null {
  const { ended, matrix, now, records } = input;
  if (records.length === 0) return null;
  const composing: Composing = { now, records, witnesses: sourceWitnesses(records) };
  const leftOut = records.filter((record) => isClaim(record) && !quoteHolds(record)).length;
  const body = [`## ${WORDS.title}`, sourcesLine(composing), ...matrix ? [criteriaSection(matrix), tableSection(matrix, composing)] : [],
    otherRecords(matrix, composing), unreachableSection(composing), leftOut > 0 ? WORDS.leftOut(leftOut) : null].filter((part) => part !== null).join("\n\n");
  return researchAnswerText(body, [researchNote(ENDING_NOTES[ended])]);
}

/** The port of one run (`ResearchPortFactories.report`). */
export function createResearchReport(run: ResearchRunScope, parts: Pick<ResearchPorts, "coverage" | "evidence">): ResearchReportPort {
  return {
    async compose({ ended, signal }) {
      const records = await parts.evidence.records(signal);
      if (records.length === 0) return null;
      const matrix = await researchMatrix(parts.coverage, signal);
      return composeResearchReport({ ended, matrix, now: new Date(run.now()), records });
    },
    gates: [reportCheckGate]
  };
}

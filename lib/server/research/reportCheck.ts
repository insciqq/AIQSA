import type { ResearchDraft, ResearchEvidenceRecord, ResearchFrame } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchGate } from "./gates";
import { researchMatrix, type ResearchMatrix } from "./matrix";
import { researchNote } from "./notes";
import { researchGatePorts } from "./ports";
import { researchRegistrableDomain } from "./sourceQuality";

/**
 * A draft against the records and the matrix (`agent_docs/RUN_CONTRACTS.md`, Research), the first gate a draft meets. It reads only fields, so it
 * says only what those can prove:
 * - every id names a live record or one corrected by a live one, and a pick, a branch's pick and rows called inseparable are rows of the matrix;
 * - a row the draft leans on has a record cited in each cell that holds evidence, which is what makes the prices, sellers and reviews behind a pick
 *   reach the checks after it: a real run cited 9 of 56 records, and three checks read the maker's specifications while the pick went unread;
 * - a link in the report is a record the draft cites, since a link is what a report's prose claims to rest on that a field can show;
 * - a report resting on several pages links at least half of them, so its reader can trace what it says;
 * - a comparison has its table, naming every criterion, and a criterion added on the way is named.
 *
 * What stays the model's word: that the prose says what the cited records say (the verifier reads the records, not the prose), that the pick follows
 * from the comparison, why each criterion matters, a statement that rows do not separate, and any pick written only in prose. Advice that cites nothing,
 * picks nothing and links nothing passes, as does a text draft, which has no ids. Names are matched generously: a false alarm costs a paid rewrite of the
 * whole report, a missed one a table column, so only a report that holds no word of a criterion goes back.
 */
export const REPORT_CHECK_GATE = "report_check";

/** Past this a list of what to correct gives its length: the model acts on the first ones, and a send back rides on the follow-up store's bound. */
const LISTED = 24;
const IDS_PER_CELL = 3;
const LINKS_READ = 200;
/** Cited pages from which a report must link its sources: under this there is too little to tell a habit by. */
const TRACEABLE_PAGES = 4;
/** A claim beside its page in a send back: enough to find it in the report. */
const CLAIM_WORDS_CHARACTERS = 80;

/** What is wrong: what the model reads, and what the answer says when it cannot go back. */
type Trouble = Readonly<{ message: string; note: string }>;

/** A label or a model's words in a note, which sits in the answer: nothing of it may become a link, an image or markup. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}*`[\]<>]+/gu, " ").replace(/\s+/gu, " ").trim();

const listed = (entries: readonly string[], separator = ", ") => entries.length > LISTED
  ? `${entries.slice(0, LISTED).join(separator)}${separator}and ${entries.length - LISTED} more` : entries.join(separator);

/** Lowercased with the variants of a letter folded, so a heading and a label compare. */
const folded = (text: string) => text.normalize("NFKC").toLowerCase().replaceAll("ё", "е");

/** Each longer word cut before its ending, so another case of a word still matches. */
const stems = (label: string) => (folded(label).match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((word) => word.slice(0, Math.max(3, word.length - 2)));

/** What is left of a one-word label under a shortened heading: its root, as Шум is of Шумность. It has no other word to be found by. */
const ONE_WORD_ROOT = 3;

/** Whether folded text holds any longer word of a label: a shortened heading names a criterion, and no word of it does not. */
function namesLabel(text: string, label: string): boolean {
  const words = folded(label).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 1) return text.includes(words[0]!.slice(0, ONE_WORD_ROOT));
  const wanted = stems(label);
  return wanted.length > 0 ? wanted.some((stem) => text.includes(stem)) : text.includes(folded(label).trim());
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Whether folded text names a criterion. One in another script than the report's is translated there, which no word match can see: a real run sent a good draft back twice over one
 * English label, and the model pasted the English into its Russian report. A row is a name and stays as it is written, so a row's label goes to `namesLabel` alone.
 */
function namesCriterion(text: string, criterion: string, report: string): boolean {
  const otherScript = CYRILLIC.test(report) ? !CYRILLIC.test(criterion) && LATIN.test(criterion) : CYRILLIC.test(criterion);
  return otherScript || namesLabel(text, criterion);
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

/** The lines of the report's Markdown tables, header included; empty when it has none. */
function tableText(report: string): string {
  const lines = report.split("\n");
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes("|") || !TABLE_DELIMITER.test(line) || !lines[index - 1]?.includes("|")) continue;
    kept.push(lines[index - 1]!);
    for (let next = index + 1; next < lines.length && lines[next]!.includes("|"); next += 1) kept.push(lines[next]!);
  }
  return kept.join("\n");
}

const LINK = /https?:\/\/[^\s<>"'`|\\^{}[\]]+/giu;
const LINK_END = /[.,;:!?»…*_~]+$/u;
const count = (text: string, character: string) => text.split(character).length - 1;

/** A link as written, without the Markdown or the sentence around it: a closing bracket stays only when the link opened one. */
function bareLink(raw: string): string {
  let link = raw.replace(LINK_END, "");
  while (link.endsWith(")") && count(link, "(") < count(link, ")")) link = link.slice(0, -1).replace(LINK_END, "");
  return link;
}

/** One page however a link spells it: a query or a scheme is no other source. */
function pageOf(link: string): string | null {
  const normalized = normalizeFetchUrl(link);
  if (normalized === null) return null;
  const { hostname, pathname } = new URL(normalized);
  return `${hostname.replace(/^www\./u, "")}${pathname.replace(/\/+$/u, "")}`;
}

/** Whether a link goes to a site's front door, which says nothing and backs nothing. */
function isSiteRoot(link: string): boolean {
  const normalized = normalizeFetchUrl(link);
  if (normalized === null) return false;
  const { pathname, search } = new URL(normalized);
  return pathname === "/" && search === "";
}

const reportLinks = (report: string) => [...new Set((report.match(LINK) ?? []).map(bareLink))].slice(0, LINKS_READ);

/** The links a record stands for, a dataset's examples included. */
const linksOf = (record: ResearchEvidenceRecord): readonly string[] => record.kind === "finding" ? [record.url]
  : record.kind === "dataset" ? [record.url, ...record.dataset.examples.map(({ url }) => url)] : record.kind === "unreachable" ? [record.target] : [];

const pagesOf = (record: ResearchEvidenceRecord) => linksOf(record).flatMap((link) => pageOf(link) ?? []);

type ClaimRecord = Extract<ResearchEvidenceRecord, Readonly<{ kind: "dataset" | "finding" }>>;

const isClaim = (record: ResearchEvidenceRecord): record is ClaimRecord => record.kind === "finding" || record.kind === "dataset";

/**
 * The ids as the records they stand for. A corrected id reads as its correction, as it does in `researchDraftWithRecords`: the checks read that record, so it is cited, and
 * nothing goes back or is said of it.
 */
function citedRecords(named: readonly string[], records: readonly ResearchEvidenceRecord[]): ReadonlySet<string> {
  const corrections = new Map(records.flatMap(({ id, supersedes }) => supersedes === null ? [] : [[supersedes, id] as const]));
  return new Set(named.map((id) => corrections.get(id) ?? id));
}

/** The ids that stand for no live record. */
function unknownRecords(ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const live = new Set(records.map(({ id }) => id));
  const unknown = [...ids].filter((id) => !live.has(id));
  if (unknown.length === 0) return null;
  return { message: `These record_ids name no live record of this research: ${listed(unknown)}. Use the record's id as it was listed after a researcher's report or returned by ` +
    "record_evidence. Where no record holds what you wrote, take it out of the report, or record it first.", note: researchNote("report_unknown_records") };
}

const rowLabel = (frame: ResearchFrame, key: string) => frame.rows.find((row) => row.key === key)?.label ?? key;

/** What the draft picks or calls inseparable, row by row. */
const leanedOn = ({ branchPicks, doesNotSeparate, pickRowKey }: ResearchDraft) => [...new Set([...pickRowKey ? [pickRowKey] : [], ...branchPicks?.map(({ rowKey }) => rowKey) ?? [],
  ...doesNotSeparate?.rowKeys ?? []])];

const MATRIX_RULE = "The pick is a row of the matrix: name one of its keys, add the row with change_research_frame and record its evidence, or pass null and say in does_not_separate that the data does not tell the rows apart.";

/** Picks and rows that are not in the matrix. */
function outsideMatrix(draft: ResearchDraft, frame: ResearchFrame, report: string): Trouble | null {
  const rows = new Set(frame.rows.map(({ key }) => key));
  const unknownRows = leanedOn(draft).filter((key) => !rows.has(key));
  const wrongPicks = (draft.branchPicks ?? []).flatMap(({ branchKey, caseKey }) => {
    const branch = frame.branches.find(({ key }) => key === branchKey);
    if (!branch) return [`branch ${branchKey}`];
    return branch.cases.some(({ key }) => key === caseKey) ? [] : [`case ${caseKey} of ${branchKey}`];
  });
  const twice = (draft.branchPicks ?? []).filter(({ branchKey, caseKey, rowKey }, index, picks) =>
    picks.some((other, earlier) => earlier < index && other.branchKey === branchKey && other.caseKey === caseKey && other.rowKey !== rowKey))
    .map(({ branchKey, caseKey }) => `case ${caseKey} of ${branchKey} has two rows`);
  const wrong = [...unknownRows.map((key) => `row ${key}`), ...wrongPicks, ...twice];
  if (wrong.length === 0) return null;
  const known = frame.rows.length > 0 ? `Rows: ${listed(frame.rows.map(({ key }) => key))}.` : "The matrix has no rows yet.";
  return { message: `Outside the matrix: ${listed([...new Set(wrong)])}. ${known} ${MATRIX_RULE}`, note: researchNote("report_pick_outside") };
}

/** The cases of each branch with no pick, once the draft picks at all: what is unknown about the user changes the result. */
function openBranches(draft: ResearchDraft, frame: ResearchFrame, report: string): Trouble | null {
  const picks = draft.branchPicks ?? [];
  if (!draft.pickRowKey && picks.length === 0) return null;
  const open = frame.branches.flatMap((branch) => branch.cases.filter(({ key }) => !picks.some((pick) => pick.branchKey === branch.key && pick.caseKey === key))
    .map(({ key, label }) => ({ key: `${branch.key}/${key}`, words: `${plain(branch.unknown)}: ${plain(label)}` })));
  if (open.length === 0) return null;
  return { message: `branch_picks leaves these cases of what is unknown about the user without a row: ${listed(open.map(({ key }) => key))}. Give each case its row in branch_picks, the same row ` +
    "where the case changes nothing, and say in the report who each pick is for.", note: `${researchNote("report_branches_open")} ${listed(open.map(({ words }) => words), "; ")}.` };
}

/** Cells of the rows the draft leans on whose evidence it does not cite, which is how a pick's prices and reviews stayed out of a real run's checks. */
function uncitedRows(draft: ResearchDraft, ids: ReadonlySet<string>, matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const rows = new Set(matrix.frame.rows.map(({ key }) => key));
  const leaning = leanedOn(draft).filter((key) => rows.has(key));
  const bare = leaning.filter((key) => !records.some((record) => isClaim(record) && record.rowKey === key));
  const cells = matrix.coverage.cells.filter((cell) => cell.state === "filled" && leaning.includes(cell.rowKey) && !cell.recordIds.some((id) => ids.has(id)));
  if (bare.length === 0 && cells.length === 0) return null;
  const criterionOf = (key: string) => plain(matrix.frame.criteria.find((criterion) => criterion.key === key)?.criterion ?? key);
  const missing = cells.map((cell) => `${cell.rowKey} / ${cell.criterionKey}: ${cell.recordIds.slice(0, IDS_PER_CELL).join(", ")}`);
  const noEvidence = bare.length > 0 ? `No record holds evidence for ${listed(bare)}, so nothing can stand behind it: send a researcher for it, or pick another row. ` : "";
  const uncited = cells.length > 0 ? `The checks read only what record_ids names, and your pick rests on these cells: add at least one id of each. ${listed(missing, "; ")}.` : "";
  const named = [...bare.map((key) => plain(rowLabel(matrix.frame, key))), ...new Set(cells.map((cell) => `${plain(rowLabel(matrix.frame, cell.rowKey))}: ${criterionOf(cell.criterionKey)}`))];
  return { message: `${noEvidence}${uncited}`.trim(), note: `${researchNote("report_pick_unbacked")} ${listed(named, "; ")}.` };
}

/**
 * Links of the report that no cited record stands behind: a live record's id goes back with it, and for the rest it is a record or no link. A link to the root of a site
 * a cited record is on passes: it claims nothing to rest on.
 */
function unbackedLinks(draft: ResearchDraft, ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const allowed = new Set([...records.filter(({ id, kind }) => ids.has(id) || kind === "unreachable").flatMap(pagesOf),
    ...draft.unreachable.flatMap(({ target }) => pageOf(target) ?? [])]);
  const citedSites = new Set(records.filter((record) => isClaim(record) && ids.has(record.id)).flatMap(linksOf).flatMap((link) => researchRegistrableDomain(link) ?? []));
  const links = reportLinks(draft.report).filter((link) => {
    const page = pageOf(link);
    if (page === null || allowed.has(page)) return false;
    return !isSiteRoot(link) || !citedSites.has(researchRegistrableDomain(link) ?? "");
  });
  if (links.length === 0) return null;
  const holders = new Map(records.filter(isClaim).flatMap((record) => pagesOf(record).map((page) => [page, record.id] as const)));
  const uncited = links.flatMap((link) => {
    const id = holders.get(pageOf(link)!);
    return id === undefined ? [] : [`${link} (record ${id})`];
  });
  const unrecorded = links.filter((link) => !holders.has(pageOf(link)!));
  const parts = [...uncited.length > 0 ? [`These links of the report are records you did not cite: add their ids to record_ids. ${listed(uncited)}.`] : [],
    ...unrecorded.length > 0 ? [`These links of the report are no record of this research: record what they show with record_evidence, then cite it, or take them out. ${listed(unrecorded)}.`] : []];
  return { message: parts.join(" "), note: researchNote("report_links_unrecorded") };
}

/**
 * Whether its reader can trace a report: a real one cited 30 records and carried two links, so no figure could be followed though every fact was recorded. A page counts as linked from
 * anywhere in the report, a list at the end included, since the point is that the reader can reach it, and a record is reached through any page it stands for. Pages, not records, so
 * many records on one page count once.
 */
function unlinkedPages(draft: ResearchDraft, ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const pages = new Map<string, ClaimRecord[]>();
  for (const record of records.filter(isClaim)) {
    const page = pagesOf(record)[0];
    if (ids.has(record.id) && page !== undefined) pages.set(page, [...pages.get(page) ?? [], record]);
  }
  const linked = new Set(reportLinks(draft.report).flatMap((link) => pageOf(link) ?? []));
  const unlinked = [...pages.values()].filter((held) => !held.some((record) => pagesOf(record).some((page) => linked.has(page))));
  const reached = pages.size - unlinked.length;
  if (pages.size < TRACEABLE_PAGES || reached * 2 >= pages.size) return null;
  const entries = unlinked.map(([first, ...rest]) => `${first!.url} (${bounded(plain(first!.claim), CLAIM_WORDS_CHARACTERS)}${rest.length > 0 ? `, and ${rest.length} more` : ""})`);
  return { message: `The report links ${reached} of the ${pages.size} pages it rests on, so its reader cannot trace what it says. Link each figure, price, study and named claim to the page it ` +
    `came from, where it is stated. Not linked: ${listed(entries, "; ")}.`, note: researchNote("report_unlinked_sources") };
}

/** A comparison's table and its criteria. Only where there is a comparison: rows with evidence to compare, and a draft that states something. */
function comparison(draft: ResearchDraft, matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], report: string): readonly Trouble[] {
  const { frame } = matrix;
  const added = frame.changes.filter(({ change }) => change === "add_criterion").flatMap(({ key, reason }) => {
    const criterion = frame.criteria.find((entry) => entry.key === key);
    return criterion ? [{ criterion, reason }] : [];
  });
  const text = folded(draft.report);
  const unnamed = added.filter(({ criterion }) => !namesCriterion(text, criterion.criterion, report));
  const troubles: Trouble[] = unnamed.length > 0 ? [{
    message: `Criteria were added during research, and the report must name each with its reason. Name: ${listed(unnamed.map(({ criterion, reason }) => `${plain(criterion.criterion)} (${plain(reason)})`), "; ")}.`,
    note: `${researchNote("report_added_criteria")} ${listed(unnamed.map(({ criterion, reason }) => `${plain(criterion.criterion)}: ${plain(reason)}`), "; ")}.` }] : [];
  const held = new Set(records.filter(isClaim).flatMap(({ rowKey }) => rowKey ?? []));
  if (frame.rows.filter(({ key }) => held.has(key)).length < 2) return troubles;
  const table = folded(tableText(draft.report));
  const wanted = "Put one comparison table in the report, as a Markdown table with the rows against all of the matrix's criteria, and write no data for a cell nothing filled.";
  if (!table) return [...troubles, { message: `The report has no comparison table. ${wanted}`, note: researchNote("report_no_table") }];
  const leftOut = frame.criteria.filter(({ criterion }) => !namesCriterion(table, criterion, report)).map(({ criterion, why }) => ({ criterion: plain(criterion), why: plain(why) }));
  const picks = leanedOn(draft).filter((key) => !namesLabel(table, rowLabel(frame, key))).map((key) => plain(rowLabel(frame, key)));
  if (leftOut.length === 0 && picks.length === 0) return troubles;
  const message = [...leftOut.length > 0 ? [`The comparison table leaves out these criteria of the matrix: ${listed(leftOut.map(({ criterion, why }) => `${criterion} (${why})`), "; ")}.`] : [],
    ...picks.length > 0 ? [`The comparison table leaves out what you pick: ${listed(picks)}.`] : []];
  return [...troubles, { message: `${message.join(" ")} ${wanted}`, note: `${researchNote("report_criteria_missing")} ${listed([...leftOut.map(({ criterion }) => criterion), ...picks])}.` }];
}

/** A statement that rows do not separate reaches the user: the server's words carry it when the report's own do not. It costs no rewrite. */
function separationNotes(draft: ResearchDraft, frame: ResearchFrame | null, report: string): readonly string[] {
  const stated = draft.doesNotSeparate;
  if (!stated) return [];
  const text = folded(draft.report).replace(/\s+/gu, " ");
  const said = (words: string) => text.includes(folded(words).replace(/\s+/gu, " ").trim());
  if (said(stated.statement) && said(stated.wouldDecide)) return [];
  const rows = stated.rowKeys.map((key) => plain(frame ? rowLabel(frame, key) : key));
  return [`${researchNote("report_not_separated")} ${listed(rows)}. ${plain(stated.statement)} ${researchNote("report_would_decide")} ${plain(stated.wouldDecide)}`];
}

export type ResearchReportFindings = Readonly<{ notes: readonly string[]; troubles: readonly Trouble[] }>;

/** The whole check, with no port: what goes back, and what the answer says either way. */
export function researchReportFindings(draft: ResearchDraft, records: readonly ResearchEvidenceRecord[], matrix: ResearchMatrix | null): ResearchReportFindings {
  const report = draft.report;
  if (draft.origin === "plain_text" || (records.length === 0 && !matrix)) return { notes: [], troubles: [] };
  if (draft.invalidReferences !== undefined) return { notes: [], troubles: [{ message: `${draft.invalidReferences} Nothing else of this draft was checked.`, note: researchNote("report_unreadable_references") }] };
  if (draft.recordIds === undefined && draft.findings.length > 0) {
    return { notes: [], troubles: [{ message: "findings are no longer taken: the checks read each claim from its record. Pass record_ids, the ids listed after each researcher's report and " +
      "returned by record_evidence.", note: researchNote("report_typed_findings") }] };
  }
  const named = draft.recordIds ?? [];
  const ids = citedRecords(named, records);
  const notes = separationNotes(draft, matrix?.frame ?? null, report);
  const unknown = unknownRecords(ids, records, report);
  const links = unbackedLinks(draft, ids, records, report);
  const rows = matrix && [outsideMatrix(draft, matrix.frame, report), openBranches(draft, matrix.frame, report), uncitedRows(draft, ids, matrix, records, report)];
  const states = named.length > 0 || leanedOn(draft).length > 0;
  const table = matrix && states ? comparison(draft, matrix, records, report) : [];
  return { notes, troubles: [unknown, ...rows ?? [], links, unlinkedPages(draft, ids, records, report), ...table].flatMap((trouble) => trouble ?? []) };
}

const bounded = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Bounded as every send back is, each part represented however long the first. */
function sendBackMessage(troubles: readonly Trouble[]): string {
  const room = Math.floor(RUN_FOLLOWUP_MAX_CHARS / Math.max(1, troubles.length)) - 2;
  return troubles.map(({ message }) => bounded(message, room)).join("\n\n");
}

export const reportCheckGate: ResearchGate = {
  name: REPORT_CHECK_GATE,
  async run(draft, context) {
    if (draft.origin === "plain_text") return { kind: "pass" };
    const { coverage, evidence } = researchGatePorts(context);
    const [records, matrix] = await Promise.all([evidence.records(context.signal), researchMatrix(coverage, context.signal)]);
    const { notes, troubles } = researchReportFindings(draft, records, matrix);
    if (troubles.length === 0) return { kind: "pass", notes };
    return { kind: "send_back", message: sendBackMessage(troubles), notes, unresolvedNote: bounded(troubles.map(({ note }) => note).join(" "), RUN_FOLLOWUP_MAX_CHARS) };
  }
};

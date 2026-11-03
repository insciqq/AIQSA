import { researchDraftText, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFrame } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchGate } from "./gates";
import { researchKeyCells, researchLeadingRows, researchMatrix, researchRecordSite, type ResearchMatrix } from "./matrix";
import { researchGatePorts } from "./ports";
import { figuresNotIn, type ClaimFigure } from "./quoteCheck";
import { researchRejectedRecords } from "./verifier";
import { researchRegistrableDomain } from "./sourceQuality";

/**
 * A draft against the records and the matrix (`agent_docs/RUN_CONTRACTS.md`, Research), the first gate a draft meets. It reads only fields, so it
 * says only what those can prove:
 * - every id names a live record or one corrected by a live one, and a pick, a branch's pick, the summary's rows and rows called inseparable are rows of the matrix;
 * - a row the draft leans on has a record cited in each cell that holds evidence, which is what makes the prices, sellers and reviews behind a pick
 *   reach the checks after it: a real run cited 9 of 56 records, and three checks read the maker's specifications while the pick went unread;
 * - a link in the report is a record the draft cites, since a link is what a report's prose claims to rest on that a field can show;
 * - a report resting on several pages links at least half of them, so its reader can trace what it says;
 * - a comparison has its table, naming every criterion, and a criterion added on the way is named;
 * - the summary the reader reads first is there, starts with the pick, names in its text the rows it lists, and the offers of the options it recommends are cited;
 * - a key specification of an option it leads with is cited from two sites where two hold it, and where they disagree both are cited and both figures stated.
 *
 * What stays the model's word: that the prose says what the cited records say (the verifier reads the records, not the prose), that the pick follows
 * from the comparison, why each criterion matters, a statement that rows do not separate, any pick written only in prose, and the summary's prices, shops and
 * length. Advice with its summary that cites nothing, picks nothing and links nothing passes where the plan marked no key specification, as does a text draft, which has no ids. Names are matched
 * generously: a false alarm costs a paid rewrite of the whole report, a missed one a table column, so only a report that holds no word of a criterion goes back.
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

/**
 * What is wrong, as the model reads it. Nothing of it reaches the answer, even when it cannot go back (operator decision 2026-11-02: the answer carries no process
 * notes): a report that misses its form says what it says, and a note that it missed its form tells the reader nothing they can act on.
 */
type Trouble = Readonly<{ message: string }>;

/** A label or a model's words in a send back: nothing of it may become a link, an image or markup. */
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

/** Exact fetch_url identities only: a query, scheme or subdomain may select different evidence. One record can name the same URL more than once. */
function recordsByUrl(records: readonly ResearchEvidenceRecord[]): ReadonlyMap<string, ReadonlySet<string>> {
  const holders = new Map<string, Set<string>>();
  for (const record of records.filter(isClaim)) {
    for (const link of linksOf(record)) {
      const url = normalizeFetchUrl(link);
      if (url === null) continue;
      const ids = holders.get(url) ?? new Set<string>();
      ids.add(record.id);
      holders.set(url, ids);
    }
  }
  return holders;
}

/** Assemble citations before any gate reads the draft, so the verifier sees the newly cited claims too. Ambiguous URLs still need the model's choice. */
export function researchDraftWithLinkedRecords(draft: ResearchDraft, records: readonly ResearchEvidenceRecord[]): ResearchDraft {
  if (draft.origin === "plain_text" || draft.recordIds === undefined || draft.invalidReferences !== undefined) return draft;
  const holders = recordsByUrl(records);
  const cited = citedRecords(draft.recordIds, records);
  const added = new Set<string>();
  for (const link of reportLinks(researchDraftText(draft))) {
    const matches = holders.get(normalizeFetchUrl(link) ?? "");
    if (matches?.size !== 1) continue;
    for (const id of matches) if (!cited.has(id)) added.add(id);
  }
  return added.size === 0 ? draft : { ...draft, recordIds: [...draft.recordIds, ...added] };
}

/** The ids that stand for no live record. */
function unknownRecords(ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const live = new Set(records.map(({ id }) => id));
  const unknown = [...ids].filter((id) => !live.has(id));
  if (unknown.length === 0) return null;
  return { message: `These record_ids name no live record of this research: ${listed(unknown)}. Use the record's id as it was listed after a researcher's report or returned by ` +
    "record_evidence. Where no record holds what you wrote, take it out of the report, or record it first." };
}

const rowLabel = (frame: ResearchFrame, key: string) => frame.rows.find((row) => row.key === key)?.label ?? key;

/** The rows the draft picks: its pick and each case's. */
const pickedRows = ({ branchPicks, pickRowKey }: ResearchDraft) => [...new Set([...pickRowKey ? [pickRowKey] : [], ...branchPicks?.map(({ rowKey }) => rowKey) ?? []])];

/** What the draft picks, recommends in its summary or calls inseparable, row by row. */
const leanedOn = (draft: ResearchDraft) => [...new Set([...pickedRows(draft), ...draft.summary?.rowKeys ?? [], ...draft.doesNotSeparate?.rowKeys ?? []])];

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
  return { message: `Outside the matrix: ${listed([...new Set(wrong)])}. ${known} ${MATRIX_RULE}` };
}

/** The cases of each branch with no pick, once the draft picks at all: what is unknown about the user changes the result. */
function openBranches(draft: ResearchDraft, frame: ResearchFrame, report: string): Trouble | null {
  const picks = draft.branchPicks ?? [];
  if (!draft.pickRowKey && picks.length === 0) return null;
  const open = frame.branches.flatMap((branch) => branch.cases.filter(({ key }) => !picks.some((pick) => pick.branchKey === branch.key && pick.caseKey === key))
    .map(({ key }) => `${branch.key}/${key}`));
  if (open.length === 0) return null;
  return { message: `branch_picks leaves these cases of what is unknown about the user without a row: ${listed(open)}. Give each case its row in branch_picks, the same row ` +
    "where the case changes nothing, and say in the report who each pick is for." };
}

/** Cells of the rows the draft leans on whose evidence it does not cite, which is how a pick's prices and reviews stayed out of a real run's checks. */
function uncitedRows(draft: ResearchDraft, ids: ReadonlySet<string>, matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const rows = new Set(matrix.frame.rows.map(({ key }) => key));
  const leaning = leanedOn(draft).filter((key) => rows.has(key));
  const bare = leaning.filter((key) => !records.some((record) => isClaim(record) && record.rowKey === key));
  const cells = matrix.coverage.cells.filter((cell) => cell.state === "filled" && leaning.includes(cell.rowKey) && !cell.recordIds.some((id) => ids.has(id)));
  if (bare.length === 0 && cells.length === 0) return null;
  const missing = cells.map((cell) => `${cell.rowKey} / ${cell.criterionKey}: ${cell.recordIds.slice(0, IDS_PER_CELL).join(", ")}`);
  const noEvidence = bare.length > 0 ? `No record holds evidence for ${listed(bare)}, so nothing can stand behind it: send a researcher for it, or pick another row. ` : "";
  const uncited = cells.length > 0 ? `The checks read only what record_ids names, and your pick rests on these cells: add at least one id of each. ${listed(missing, "; ")}.` : "";
  return { message: `${noEvidence}${uncited}`.trim() };
}

/**
 * The key specifications of the options the draft leads with (`researchKeyCells`, operator decisions 2026-11-02): held on two sites, a record of each is cited, so the
 * checks read both; where two sites give different figures, both records are cited and the report states each figure, since a real run's pick rested on one seller's
 * figure while sellers disagreed on its load and height. Which figure is right stays the report's to say, and where it says so stays the model's word: only that both
 * are stated somewhere is checked, so records that describe different parts of one cell pass once the report states both.
 */
function keySpecTrouble(draft: ResearchDraft, ids: ReadonlySet<string>, matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], report: string,
  rejected: ReadonlySet<string>): Trouble | null {
  const rows = new Set(matrix.frame.rows.map(({ key }) => key));
  const secondSites: string[] = [];
  const pairs: string[] = [];
  const unnamed: string[] = [];
  for (const cell of researchKeyCells(matrix, records, researchLeadingRows(draft).filter((key) => rows.has(key)))) {
    const where = `${cell.row.key} / ${cell.criterion.key}`;
    // A site whose records of the cell the checks all rejected is no site to cite: the verifier tells the model what to do with those.
    const usable = cell.records.filter(({ id }) => !rejected.has(id));
    const sites = [...new Set(usable.flatMap((record) => researchRecordSite(record) ?? []))];
    const citedSites = new Set(usable.filter(({ id }) => ids.has(id)).flatMap((record) => researchRecordSite(record) ?? []));
    if (sites.length >= 2 && citedSites.size < 2) {
      // One record of each site not cited yet, so any id taken adds a site.
      const others = sites.filter((site) => !citedSites.has(site)).flatMap((site) => usable.find((record) => researchRecordSite(record) === site) ?? []);
      secondSites.push(`${where}: ${others.slice(0, IDS_PER_CELL).map(({ id }) => id).join(", ")}`);
    }
    const disagreements = cell.disagreements.filter(({ records: pair }) => pair.every(({ id }) => !rejected.has(id)));
    if (disagreements.length === 0) continue;
    const cited = disagreements.filter(({ records: pair }) => pair.every(({ id }) => ids.has(id)));
    if (cited.length === 0) {
      const pair = disagreements.find(({ records: both }) => both.some(({ id }) => ids.has(id))) ?? disagreements[0]!;
      pairs.push(`${where}: ${pair.records.map(({ id }) => id).join(", ")}`);
    } else if (!cited.some(({ figures }) => figures.every((side) => figuresNotIn(side, report).length === 0))) {
      const { figures, records: [one, other] } = cited[0]!;
      const side = (shown: readonly ClaimFigure[], record: ClaimRecord) => `${shown.map(({ text }) => plain(text)).join(", ")} (${researchRecordSite(record) ?? record.id})`;
      unnamed.push(`${plain(cell.row.label)} — ${plain(cell.criterion.criterion)}: ${side(figures[0], one)} against ${side(figures[1], other)}`);
    }
  }
  const parts = [
    ...secondSites.length > 0 ? [`A key specification of an option you recommend rests on two sites, and the checks read only what record_ids names: cite records of two sites for each of ` +
      `these, from the ids of sites you do not cite yet. ${listed(secondSites, "; ")}.`] : [],
    ...pairs.length > 0 ? [`Two sites give different figures for a key specification of an option you recommend: cite both records, so the checks read both, and name the disagreement in the report. ${listed(pairs, "; ")}.`] : [],
    ...unnamed.length > 0 ? [`Two sites disagree on a key specification of an option you recommend, and the report does not state both figures: name the disagreement for that option, each figure with the site that gives it, instead of one figure. ${listed(unnamed, "; ")}.`] : []
  ];
  return parts.length > 0 ? { message: parts.join(" ") } : null;
}

const SUMMARY_FORM = "Pass summary with its text, two to four short paragraphs in the user's language that the server puts above the report: the option to take for the user's " +
  "criteria, then the alternatives for their other likely priorities, each named as the matrix names it and, for a purchase, with its price and where to buy it; and its row_keys, " +
  "the rows it recommends in that order, the pick first.";

/**
 * What a draft that chooses no option hears where the plan marked key specifications, the decisions it depends on, and the matrix holds options. On acceptance
 * run 3 (2026-11-03) a purchase answer said it named no winner and advised paying for none, because no option had passed every check: the reader had asked for
 * models and could act on nothing. Checks that could not confirm everything are the report's limits, not a reason to choose nothing.
 */
const DEFAULT_PICK = "The plan marked key specifications, so the user chooses among the matrix's options, yet the draft picks none: name in pick_row_key, and first " +
  "in the summary, the option you would take by default today for the user's stated priorities, marked plainly as a default with what is not confirmed. What the " +
  "checks could not confirm goes in the report's limits and is never a reason to name no option; where rows do not separate, say so in does_not_separate and still " +
  "name the default.";

/**
 * The summary the reader reads first, and most readers stop at (operator decision 2026-11-02). It goes back missing, naming no row while the draft picks one, not
 * starting with the pick or leaving out a case's pick, or with a text that does not name a row it lists, since a reader sees its words and not its keys. Names are
 * matched as generously as the table's, so only a text holding no word of a row's label goes back. A draft that picks nothing goes back where the user chooses
 * among the matrix's options (`DEFAULT_PICK`).
 */
function summaryTrouble(draft: ResearchDraft, frame: ResearchFrame | null): Trouble | null {
  const { summary } = draft;
  if (!summary) return { message: `${draft.invalidSummary ?? "The draft has no summary."} ${SUMMARY_FORM}` };
  const problems: string[] = draft.invalidSummary === undefined ? [] : [draft.invalidSummary];
  const picked = pickedRows(draft);
  const inseparable = (draft.doesNotSeparate?.rowKeys ?? []).filter((key) => !picked.includes(key));
  if (picked.length === 0 && frame && frame.rows.length >= 2 && frame.criteria.some((criterion) => criterion.decisive)) problems.push(DEFAULT_PICK);
  if (summary.rowKeys.length === 0 && picked.length + inseparable.length > 0) {
    const leaning = [...picked.length > 0 ? [`picks ${listed(picked)}`] : [], ...inseparable.length > 0 ? [`calls ${listed(inseparable)} inseparable`] : []].join(" and ");
    problems.push(`The summary names no row of the matrix while the draft ${leaning}: list in row_keys the rows it recommends, the pick first, and name each in its text.`);
  } else if (summary.rowKeys.length > 0) {
    if (draft.pickRowKey && summary.rowKeys[0] !== draft.pickRowKey) {
      problems.push(`The summary starts with ${summary.rowKeys[0]}, while pick_row_key is ${draft.pickRowKey}: the pick comes first, in row_keys and in its text.`);
    }
    const left = picked.filter((key) => key !== draft.pickRowKey && !summary.rowKeys.includes(key));
    if (left.length > 0) problems.push(`The summary leaves out rows branch_picks chooses: ${listed(left)}. Name each case's pick in it and say who it is for.`);
  }
  const text = folded(summary.text);
  const unnamed = frame ? summary.rowKeys.filter((key) => frame.rows.some((row) => row.key === key) && !namesLabel(text, rowLabel(frame, key))) : [];
  if (unnamed.length > 0) {
    problems.push(`The summary's text does not name ${listed(unnamed.map((key) => `${plain(rowLabel(frame!, key))} (${key})`))}: its reader sees its words, not its keys, so name each option as the matrix names it.`);
  }
  return problems.length > 0 ? { message: `${problems.join(" ")} ${SUMMARY_FORM}` } : null;
}

const quoteHolds = (record: ClaimRecord) => record.quoteCheck?.status === "found" || record.quoteCheck?.status === "not_checked";

/**
 * The options the summary recommends whose recorded offers the draft cites none of: an offer is what a purchase is bought by, and the checks read only cited records.
 * An offer named under a cell the pick's check already lists (`uncitedRows`) is asked for there. An option with no offer recorded is not this check's to send back,
 * since only the report can say no shop was reached: the gap judge asks for one.
 */
function uncitedOffers(draft: ResearchDraft, ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], matrix: ResearchMatrix | null): Trouble | null {
  const asked = new Set(matrix?.coverage.cells.filter((cell) => cell.state === "filled" && !cell.recordIds.some((id) => ids.has(id))).flatMap(({ recordIds }) => recordIds.slice(0, IDS_PER_CELL)) ?? []);
  const missing = (draft.summary?.rowKeys ?? []).flatMap((rowKey) => {
    const offers = records.filter((record): record is ClaimRecord => isClaim(record) && record.rowKey === rowKey && record.sourceClass === "action_channel" && quoteHolds(record));
    if (offers.length === 0 || offers.some(({ id }) => ids.has(id) || asked.has(id))) return [];
    return [`${rowKey}: ${offers.slice(0, IDS_PER_CELL).map(({ id }) => id).join(", ")}`];
  });
  if (missing.length === 0) return null;
  return { message: `The summary recommends options whose current offers you did not cite: add at least one id of each, so the checks read the price and the seller you state. ${listed(missing, "; ")}.` };
}

/**
 * Links of the report that no cited record stands behind: a live record's id goes back with it, and for the rest it is a record or no link. A link to the root of a site
 * a cited record is on passes: it claims nothing to rest on.
 */
function unbackedLinks(draft: ResearchDraft, ids: ReadonlySet<string>, records: readonly ResearchEvidenceRecord[], report: string): Trouble | null {
  const allowed = new Set([...records.filter(({ id, kind }) => ids.has(id) || kind === "unreachable").flatMap(pagesOf),
    ...draft.unreachable.flatMap(({ target }) => pageOf(target) ?? [])]);
  const citedSites = new Set(records.filter((record) => isClaim(record) && ids.has(record.id)).flatMap(linksOf).flatMap((link) => researchRegistrableDomain(link) ?? []));
  const links = reportLinks(report).filter((link) => {
    const page = pageOf(link);
    if (page === null || allowed.has(page)) return false;
    return !isSiteRoot(link) || !citedSites.has(researchRegistrableDomain(link) ?? "");
  });
  if (links.length === 0) return null;
  const holders = recordsByUrl(records);
  const uncited = links.flatMap((link) => {
    const ids = holders.get(normalizeFetchUrl(link)!);
    return ids === undefined ? [] : [`${link} (records ${listed([...ids])})`];
  });
  const unrecorded = links.filter((link) => !holders.has(normalizeFetchUrl(link)!));
  const parts = [...uncited.length > 0 ? [`These links of the report are records you did not cite: add the matching ids your claims rest on to record_ids. ${listed(uncited)}.`] : [],
    ...unrecorded.length > 0 ? [`These links of the report are no record of this research: record what they show with record_evidence, then cite it, or take them out. ${listed(unrecorded)}.`] : []];
  return { message: parts.join(" ") };
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
  const linked = new Set(reportLinks(report).flatMap((link) => pageOf(link) ?? []));
  const unlinked = [...pages.values()].filter((held) => !held.some((record) => pagesOf(record).some((page) => linked.has(page))));
  const reached = pages.size - unlinked.length;
  if (pages.size < TRACEABLE_PAGES || reached * 2 >= pages.size) return null;
  const entries = unlinked.map(([first, ...rest]) => `${first!.url} (${bounded(plain(first!.claim), CLAIM_WORDS_CHARACTERS)}${rest.length > 0 ? `, and ${rest.length} more` : ""})`);
  return { message: `The report links ${reached} of the ${pages.size} pages it rests on, so its reader cannot trace what it says. Link each figure, price, study and named claim to the page it ` +
    `came from, where it is stated. Not linked: ${listed(entries, "; ")}.` };
}

/** A comparison's table and its criteria. Only where there is a comparison: rows with evidence to compare, and a draft that states something. */
function comparison(draft: ResearchDraft, matrix: ResearchMatrix, records: readonly ResearchEvidenceRecord[], report: string): readonly Trouble[] {
  const { frame } = matrix;
  const added = frame.changes.filter(({ change }) => change === "add_criterion").flatMap(({ key, reason }) => {
    const criterion = frame.criteria.find((entry) => entry.key === key);
    return criterion ? [{ criterion, reason }] : [];
  });
  const text = folded(report);
  const unnamed = added.filter(({ criterion }) => !namesCriterion(text, criterion.criterion, report));
  const troubles: Trouble[] = unnamed.length > 0 ? [{
    message: `Criteria were added during research, and the report must name each with its reason. Name: ${listed(unnamed.map(({ criterion, reason }) => `${plain(criterion.criterion)} (${plain(reason)})`), "; ")}.` }] : [];
  const held = new Set(records.filter(isClaim).flatMap(({ rowKey }) => rowKey ?? []));
  if (frame.rows.filter(({ key }) => held.has(key)).length < 2) return troubles;
  const table = folded(tableText(report));
  const wanted = "Put one comparison table in the report, as a Markdown table with the rows against all of the matrix's criteria, and write no data for a cell nothing filled.";
  if (!table) return [...troubles, { message: `The report has no comparison table. ${wanted}` }];
  const leftOut = frame.criteria.filter(({ criterion }) => !namesCriterion(table, criterion, report)).map(({ criterion, why }) => ({ criterion: plain(criterion), why: plain(why) }));
  const picks = leanedOn(draft).filter((key) => !namesLabel(table, rowLabel(frame, key))).map((key) => plain(rowLabel(frame, key)));
  if (leftOut.length === 0 && picks.length === 0) return troubles;
  const message = [...leftOut.length > 0 ? [`The comparison table leaves out these criteria of the matrix: ${listed(leftOut.map(({ criterion, why }) => `${criterion} (${why})`), "; ")}.`] : [],
    ...picks.length > 0 ? [`The comparison table leaves out what you pick: ${listed(picks)}.`] : []];
  return [...troubles, { message: `${message.join(" ")} ${wanted}` }];
}

export type ResearchReportFindings = Readonly<{ troubles: readonly Trouble[] }>;

/**
 * The whole check, with no port: what goes back. A statement that the rows do not separate, with what would decide, is the report's own to make, and the
 * server adds it nowhere.
 */
export function researchReportFindings(draft: ResearchDraft, records: readonly ResearchEvidenceRecord[], matrix: ResearchMatrix | null,
  rejected: ReadonlySet<string> = new Set()): ResearchReportFindings {
  /** What the reader reads, the summary above the report: its links are the report's too. */
  const report = researchDraftText(draft);
  if (draft.origin === "plain_text" || (records.length === 0 && !matrix)) return { troubles: [] };
  if (draft.invalidReferences !== undefined) return { troubles: [{ message: `${draft.invalidReferences} Nothing else of this draft was checked.` }] };
  if (draft.recordIds === undefined && draft.findings.length > 0) {
    return { troubles: [{ message: "findings are no longer taken: the checks read each claim from its record. Pass record_ids, the ids listed after each researcher's report and " +
      "returned by record_evidence." }] };
  }
  const named = draft.recordIds ?? [];
  const ids = citedRecords(named, records);
  const unknown = unknownRecords(ids, records, report);
  const links = unbackedLinks(draft, ids, records, report);
  const rows = matrix && [outsideMatrix(draft, matrix.frame, report), openBranches(draft, matrix.frame, report), uncitedRows(draft, ids, matrix, records, report),
    keySpecTrouble(draft, ids, matrix, records, report, rejected)];
  const states = named.length > 0 || leanedOn(draft).length > 0;
  const table = matrix && states ? comparison(draft, matrix, records, report) : [];
  const summary = [summaryTrouble(draft, matrix?.frame ?? null), uncitedOffers(draft, ids, records, matrix)];
  return { troubles: [unknown, ...summary, ...rows ?? [], links, unlinkedPages(draft, ids, records, report), ...table].flatMap((trouble) => trouble ?? []) };
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
    const { troubles } = researchReportFindings(draft, records, matrix, researchRejectedRecords(context.earlier));
    return troubles.length === 0 ? { kind: "pass" } : { kind: "send_back", message: sendBackMessage(troubles) };
  }
};

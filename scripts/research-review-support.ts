/**
 * Pure parts of the review evidence `scripts/smoke-subagents-paid.ts` gathers for the research decisions of 2026-11-05: T's same-chat steps
 * (`AIQSA_SUBAGENTS_T_STEPS_FILE`) and their oracle, each research run's page, bot checks, closed sites, ratings, priorities, send-backs,
 * earlier options and cost, and U's answer race read from the run's stream. Every function takes rows the harness read and gives a `full`
 * projection for the private answers directory beside `counts` of numbers and booleans for stdout: no page, answer or chat text, host, key or
 * label reaches `counts`.
 */
import {
  CHANGE_RESEARCH_FRAME_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME
} from "../lib/contracts/research";
import { decodeThreadGeneratedArtifact } from "../lib/contracts/chats";
import { researchCandidateKey, researchCandidateRow } from "../lib/server/research/candidates";
import { researchRegistrableDomain, researchSiteHost } from "../lib/server/research/sourceQuality";

const fail = (code: string): never => { throw new Error(code); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type Instant = Date | string;
const time = (value: Instant | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};

// T's same-chat steps ----------------------------------------------------------------

/** The steps file is private as the question file is (`readPrivateFile`), with the same bound. */
export const RESEARCH_STEPS_MAX_BYTES = 16_384;
export const RESEARCH_STEPS_MAX = 10;
export const RESEARCH_STEP_TEXT_MAX = 8_000;

export type ResearchStep = Readonly<{ deepResearch: boolean; text: string }>;

/**
 * `AIQSA_SUBAGENTS_T_STEPS_FILE`'s JSON: a list of 1 to `RESEARCH_STEPS_MAX` objects with exactly `text` (1 to `RESEARCH_STEP_TEXT_MAX`
 * characters, not blank) and `deepResearch` (a boolean). Refusals are codes; the text never leaves.
 */
export function parseResearchSteps(raw: string): ResearchStep[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("research_steps_invalid"); }
  if (!Array.isArray(value) || value.length === 0) return fail("research_steps_invalid");
  if (value.length > RESEARCH_STEPS_MAX) fail("research_steps_too_many");
  return value.map((entry) => {
    if (!record(entry) || Object.keys(entry).length !== 2 || typeof entry.deepResearch !== "boolean" || typeof entry.text !== "string" ||
      !entry.text.trim() || entry.text.length > RESEARCH_STEP_TEXT_MAX) return fail("research_steps_invalid");
    return { deepResearch: entry.deepResearch, text: entry.text };
  });
}

/** The tools that ride only on a research run (`lib/contracts/research.ts`). */
export const RESEARCH_TOOL_NAMES: readonly string[] = Object.freeze([START_RESEARCH_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME, CHANGE_RESEARCH_FRAME_TOOL_NAME]);

/**
 * What one run shows of research: `offered`, the run was admitted with Deep research (`normalizedRequest.deepResearch`, the only thing that puts
 * the research tools on a run); `researchCalls`, calls of those tools in the run's scope; `started`, a `start_research` call; `frame`, a research
 * frame row for the run.
 */
export type ResearchRunObserved = Readonly<{ frame: boolean; offered: boolean; researchCalls: number; started: boolean; status: string }>;

/**
 * A step's oracle. With Deep research: research ran (offered, started, a frame) and the run completed. Without it: no research tool was offered
 * or called, no frame, and the run ended as an ordinary answer (`complete`).
 */
export function researchStepVerdict(step: Pick<ResearchStep, "deepResearch">, observed: ResearchRunObserved): Readonly<{ failed: string[]; ok: boolean }> {
  const failed: string[] = [];
  if (step.deepResearch) {
    if (!observed.offered) failed.push("research_not_offered");
    if (!observed.started) failed.push("research_not_started");
    if (!observed.frame) failed.push("research_frame_missing");
  } else {
    if (observed.offered) failed.push("research_offered");
    if (observed.researchCalls > 0) failed.push("research_tool_called");
    if (observed.frame) failed.push("research_frame_written");
  }
  if (observed.status !== "complete") failed.push(`run_${/^[a-z_]{1,32}$/u.test(observed.status) ? observed.status : "other"}`);
  return { failed, ok: failed.length === 0 };
}

// The page --------------------------------------------------------------------------

export type ResearchPageCard = Readonly<{ artifactId: string; entrypoint: string | null; notesStart: number | null; summaryEnd: number | null;
  title: string; versionId: string }>;

/**
 * The answer's research page from its run's `generated_artifact` event payloads (`ModelRunEvent.payload`, `{ artifactType, payload }`), read
 * as the chat reads them (`decodeThreadGeneratedArtifact`); the last card that carries the marker. Null when the answer has none.
 */
export function researchPageCard(payloads: readonly unknown[]): ResearchPageCard | null {
  let found: ResearchPageCard | null = null;
  for (const payload of payloads) {
    if (!record(payload) || payload.artifactType !== "generated_artifact") continue;
    const card = decodeThreadGeneratedArtifact(payload.payload);
    if (!card?.researchPage) continue;
    found = { artifactId: card.artifactId, entrypoint: card.entrypoint, notesStart: card.researchPage.notesStart, summaryEnd: card.researchPage.summaryEnd,
      title: card.title, versionId: card.versionId };
  }
  return found;
}

/** The entry page's HTML from the user's artifact source route (`/api/artifacts/:id/versions/:versionId/source`): the entrypoint, else the first HTML file. */
export function researchPageEntry(source: unknown, entrypoint: string | null): Readonly<{ html: string; path: string; paths: string[] }> | null {
  if (!record(source) || !Array.isArray(source.files)) return null;
  const files = source.files.filter(record).filter((file): file is Record<string, unknown> & { path: string } => typeof file.path === "string");
  const entry = files.find((file) => file.path === (entrypoint ?? "index.html")) ?? files.find((file) => /\.html?$/iu.test(file.path));
  if (!entry || typeof entry.text !== "string") return null;
  return { html: entry.text, path: entry.path, paths: files.map((file) => file.path) };
}

// Fetches, bot checks and closed sites ----------------------------------------------------

/**
 * A `fetch_url` call of the research's scope, as the harness reads it: its agent (`threadId`, null for the main agent), its time, the link it
 * asked for, its error code and HTTP status, whether it read, and whether it was refused because research had closed the site
 * (`closedRefusal`, matched on the server's refusal inside SQL).
 */
export type ResearchFetchRow = Readonly<{ at: Instant | null; closedRefusal: boolean; error: string | null; httpStatus: number | null; id: string;
  read: boolean; threadId: string | null; url: string | null }>;

/** A record of the research's run: what the review reads of it. */
export type ResearchRecordRow = Readonly<{ at: Instant | null; criterionKey: string | null; id: string; kind: string; rating: unknown; reason: string | null;
  rowKey: string | null; target: string | null; url: string | null }>;

const hostOf = (link: string | null) => link ? researchSiteHost(link) : null;

/** A bot check `fetch_url` met: a 200 answer the server read as a challenge, refused as `fetch_http_status` (`lib/server/tools/botCheckPage.ts`). */
export type ResearchBotCheck = Readonly<{ at: number | null; callId: string; host: string; threadId: string | null }>;

export function researchBotChecks(fetches: readonly ResearchFetchRow[]): ResearchBotCheck[] {
  return fetches.flatMap((call) => {
    const host = hostOf(call.url);
    return call.error === "fetch_http_status" && call.httpStatus === 200 && host ? [{ at: time(call.at), callId: call.id, host, threadId: call.threadId }] : [];
  });
}

/**
 * Per bot check: whether the same agent then tried the host in its browser (`browserAfter`, by call id, read by the harness from that agent's
 * later Workspace command calls), and whether the host was later recorded unreachable or read (a `fetch_url` read or a finding on it).
 */
export function researchBotCheckOutcomes(checks: readonly ResearchBotCheck[], browserAfter: ReadonlyMap<string, boolean>, records: readonly ResearchRecordRow[],
  fetches: readonly ResearchFetchRow[]) {
  const after = (at: Instant | null, since: number | null) => since === null || (time(at) ?? 0) >= since;
  const full = checks.map((check) => {
    const unreachable = records.some((entry) => entry.kind === "unreachable" && hostOf(entry.target) === check.host && after(entry.at, check.at));
    const read = fetches.some((call) => call.read && hostOf(call.url) === check.host && after(call.at, check.at)) ||
      records.some((entry) => entry.kind === "finding" && hostOf(entry.url) === check.host && after(entry.at, check.at));
    return { agent: check.threadId === null ? "main" : "subagent", browserAfter: browserAfter.get(check.callId) === true, host: check.host,
      laterRead: read, laterUnreachable: unreachable };
  });
  return { full, counts: { botChecks: full.length, hosts: new Set(full.map((entry) => entry.host)).size, browserAfter: full.filter((entry) => entry.browserAfter).length,
    laterUnreachable: full.filter((entry) => entry.laterUnreachable).length, laterRead: full.filter((entry) => entry.laterRead).length,
    neither: full.filter((entry) => !entry.laterRead && !entry.laterUnreachable).length } };
}

/**
 * Unreachable records with their site and reason, and whether `fetch_url` then refused another host of the same registrable domain as closed:
 * since 2026-11-05 a site is its host, so a sibling refused as closed is the old portal-wide closing.
 */
export function researchUnreachableEvidence(records: readonly ResearchRecordRow[], fetches: readonly ResearchFetchRow[]) {
  const full = records.filter((entry) => entry.kind === "unreachable").map((entry) => {
    const host = hostOf(entry.target);
    const domain = host ? researchRegistrableDomain(`https://${host}/`) : null;
    const since = time(entry.at);
    const siblings = fetches.filter((call) => {
      const other = hostOf(call.url);
      return call.closedRefusal && other !== null && other !== host && domain !== null && researchRegistrableDomain(`https://${other}/`) === domain &&
        (since === null || (time(call.at) ?? 0) >= since);
    });
    return { host, reason: entry.reason, siblingRefusedAsClosed: siblings.length > 0, siblingHosts: [...new Set(siblings.map((call) => hostOf(call.url)!))] };
  });
  return { full, counts: { unreachable: full.length, hosts: new Set(full.map((entry) => entry.host)).size,
    siblingRefusedAsClosed: full.filter((entry) => entry.siblingRefusedAsClosed).length,
    closedRefusals: fetches.filter((call) => call.closedRefusal).length } };
}

// The final draft, ratings and priorities --------------------------------------------

export type ResearchPriorityLine = Readonly<{ criterionKey: string; text: string }>;
export type ResearchFinalSummary = Readonly<{ pickRowKey: string | null; priorities: readonly ResearchPriorityLine[]; rowKeys: readonly string[]; text: string }>;

/**
 * The final draft's summary from the run's `submit_research_draft` arguments in call order: the last call's, or the latest earlier one's where an
 * edit left it out (an edit keeps the previous summary). The pick is `pick_row_key`, else the summary's first row. Null with no summary.
 */
export function researchFinalSummary(drafts: readonly unknown[]): ResearchFinalSummary | null {
  let summary: ResearchFinalSummary | null = null;
  let pick: string | null = null;
  for (const draft of drafts) {
    if (!record(draft)) continue;
    if (Object.hasOwn(draft, "pick_row_key")) pick = typeof draft.pick_row_key === "string" ? draft.pick_row_key : null;
    const raw = draft.summary;
    if (raw === undefined) continue;
    const entry: Readonly<Record<string, unknown>> | null = typeof raw === "string" ? { text: raw } : record(raw) ? raw : null;
    if (!entry || typeof entry.text !== "string") { summary = null; continue; }
    const rowKeys = Array.isArray(entry.row_keys) ? entry.row_keys.filter((key): key is string => typeof key === "string") : [];
    const priorities = Array.isArray(entry.priorities) ? entry.priorities.flatMap((line) => record(line) && typeof line.criterion_key === "string" &&
      typeof line.text === "string" ? [{ criterionKey: line.criterion_key, text: line.text }] : []) : [];
    summary = { pickRowKey: null, priorities, rowKeys, text: entry.text };
  }
  return summary ? { ...summary, pickRowKey: pick ?? summary.rowKeys[0] ?? null } : null;
}

/** The numbers a text writes, each as written with its separators: `4,8`, `1 234`, `12.5`. */
function numbersIn(text: string): string[] {
  return [...text.normalize("NFKC").matchAll(/\d(?:[\d   ,.']*\d)?/gu)].map((match) => match[0]);
}

/** Whether a text names a score: the same value with a point or a comma. */
export function textNamesScore(text: string, score: number): boolean {
  return numbersIn(text).some((written) => {
    const value = Number(written.replace(/[\s  ']/gu, "").replace(",", "."));
    return Number.isFinite(value) && Math.abs(value - score) < 1e-9;
  });
}

/** Whether a text names a count of ratings: its digits, whatever groups them (`12 345`, `12,345`, `12345`). */
export function textNamesCount(text: string, count: number): boolean {
  const digits = String(count);
  return numbersIn(text).some((written) => /^\d{1,3}(?:[\s  ,.']\d{3})*$|^\d+$/u.test(written) && written.replace(/\D/gu, "") === digits);
}

type Rating = Readonly<{ count: number; counted: string; scaleMax: number; score: number; variantsMerged: boolean }>;
const ratingOf = (value: unknown): Rating | null => record(value) && typeof value.score === "number" && typeof value.count === "number" &&
  typeof value.scaleMax === "number" ? { count: value.count, counted: typeof value.counted === "string" ? value.counted : "ratings", scaleMax: value.scaleMax,
    score: value.score, variantsMerged: value.variantsMerged === true } : null;

/** Findings with a `rating` (`ResearchEvidence.rating`): row, score, count and platform (the link's site), and whether the summary names the pick's. */
export function researchRatingsEvidence(records: readonly ResearchRecordRow[], summary: ResearchFinalSummary | null) {
  const full = records.flatMap((entry) => {
    const rating = entry.kind === "finding" ? ratingOf(entry.rating) : null;
    return rating ? [{ ...rating, platform: entry.url ? researchRegistrableDomain(entry.url) : null, rowKey: entry.rowKey }] : [];
  });
  const pick = summary?.pickRowKey ?? null;
  const own = pick === null ? [] : full.filter((entry) => entry.rowKey === pick);
  const text = summary ? [summary.text, ...summary.priorities.map((line) => line.text)].join("\n") : "";
  const namesScore = own.some((entry) => textNamesScore(text, entry.score));
  const namesCount = own.some((entry) => textNamesCount(text, entry.count));
  return { full: { pick, ratings: full, summaryNamesPickScore: namesScore, summaryNamesPickCount: namesCount },
    counts: { ratings: full.length, rows: new Set(full.map((entry) => entry.rowKey)).size, platforms: new Set(full.map((entry) => entry.platform)).size,
      pickRatings: own.length, summaryNamesPickScore: namesScore, summaryNamesPickCount: namesCount } };
}

/** The plan's priority criteria (the frame's `priority: true`) against the criteria the final summary's `priorities` answer. */
export function researchPriorityEvidence(frame: unknown, summary: ResearchFinalSummary | null) {
  const criteria = record(frame) && Array.isArray(frame.criteria) ? frame.criteria.filter(record) : [];
  const priorities = criteria.filter((entry) => entry.priority === true && typeof entry.key === "string")
    .map((entry) => ({ criterion: typeof entry.criterion === "string" ? entry.criterion : null, key: entry.key as string }));
  const answered = [...new Set((summary?.priorities ?? []).map((line) => line.criterionKey))];
  const keys = new Set(priorities.map((entry) => entry.key));
  return { full: { answered, priorities, unanswered: priorities.filter((entry) => !answered.includes(entry.key)).map((entry) => entry.key) },
    counts: { priorities: priorities.length, answered: answered.filter((key) => keys.has(key)).length, answeredOther: answered.filter((key) => !keys.has(key)).length,
      allAnswered: priorities.every((entry) => answered.includes(entry.key)), ratingsCriterion: criteria.some((entry) => entry.ratings === true) } };
}

/** A draft call's result value (`submit_research_draft`'s `{ status, gate, message }`). */
const DISAGREEING = /disagree|different figures|расход|разн(?:ые|ятся)/iu;

/** The report check's and the verifier's send-backs, in order, and how many name disagreeing sites. */
export function researchSendBacks(results: readonly unknown[]) {
  const full = results.flatMap((value) => record(value) && value.status === "sent_back"
    ? [{ gate: typeof value.gate === "string" ? value.gate : null, message: typeof value.message === "string" ? value.message : "" }] : []);
  const byGate: Record<string, number> = {};
  for (const entry of full) {
    const gate = entry.gate && /^[a-z_]{1,32}$/u.test(entry.gate) ? entry.gate : "other";
    byGate[gate] = (byGate[gate] ?? 0) + 1;
  }
  return { full, counts: { sentBack: full.length, byGate, mentioningDisagreement: full.filter((entry) => DISAGREEING.test(entry.message)).length } };
}

/** The options earlier research seeded (`ResearchCandidate.earlier`) and what became of each: a row, a set-aside with its reason, or open. */
export function researchEarlierOutcomes(frame: unknown) {
  const value = record(frame) ? frame : {};
  const rows = Array.isArray(value.rows) ? value.rows.filter(record).flatMap((row) => typeof row.key === "string" && typeof row.label === "string"
    ? [{ key: row.key, label: row.label }] : []) : [];
  const aside = Array.isArray(value.setAside) ? value.setAside.filter(record) : [];
  const spelling = (key: string) => researchCandidateKey(key).replace(/-/gu, "");
  const full = (Array.isArray(value.candidates) ? value.candidates.filter(record) : []).flatMap((candidate) => {
    if (!record(candidate.earlier) || typeof candidate.key !== "string" || typeof candidate.label !== "string") return [];
    const on = typeof candidate.earlier.on === "string" ? candidate.earlier.on : null;
    const row = researchCandidateRow({ rows }, candidate.key, candidate.label);
    const set = aside.find((entry) => typeof entry.key === "string" && spelling(entry.key) === spelling(candidate.key as string));
    const became = row ? "row" as const : set ? "set_aside" as const : "open" as const;
    return [{ became, key: candidate.key, label: candidate.label, on, pick: candidate.earlier.pick === true, reason: set && typeof set.reason === "string" ? set.reason : null,
      rowKey: row?.key ?? null }];
  });
  return { full, counts: { earlier: full.length, earlierPick: full.filter((entry) => entry.pick).length, rows: full.filter((entry) => entry.became === "row").length,
    setAside: full.filter((entry) => entry.became === "set_aside").length, open: full.filter((entry) => entry.became === "open").length } };
}

/** The provider-reported cost the usage rows hold (`UsageEvent.estimatedCostMicros`): summed where every row has one, else what is known and how many lack it. */
export function researchCost(rows: readonly Readonly<{ costReported: boolean; estimatedCostMicros: number | null }>[]) {
  const known = rows.filter((row) => row.estimatedCostMicros !== null);
  const micros = known.reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0);
  return { status: rows.length === 0 || known.length === 0 ? "not_available" as const : known.length === rows.length ? "available" as const : "partial" as const,
    micros: known.length > 0 ? micros : null, rows: rows.length, withCost: known.length, reported: rows.filter((row) => row.costReported).length };
}

// U: the answer race ----------------------------------------------------------------------

export type SseEvent = Readonly<{ at: number; data: unknown; type: string }>;

/** An SSE reader for a run's stream (`encodeSseEvent`): events as they complete, comments and keepalives skipped. */
export function createSseReader(now: () => number = Date.now) {
  let rest = "";
  return {
    push(chunk: string): SseEvent[] {
      rest += chunk;
      const events: SseEvent[] = [];
      let end: number;
      while ((end = rest.indexOf("\n\n")) >= 0) {
        const block = rest.slice(0, end);
        rest = rest.slice(end + 2);
        let type = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
        }
        if (data.length === 0) continue;
        let parsed: unknown = null;
        try { parsed = JSON.parse(data.join("\n")); } catch { parsed = null; }
        events.push({ at: now(), data: parsed, type });
      }
      // A runaway block without an end is no event.
      if (rest.length > 4 * 1024 * 1024) rest = "";
      return events;
    }
  };
}

/** U's long text begins with a paragraph of its own: the first one of at least this many characters that is no heading, cut to the match bound. */
const PARAGRAPH_MIN = 120;
const PARAGRAPH_MATCH = 300;

export function answerFirstParagraph(text: string): string | null {
  const paragraph = text.split(/\n\s*\n/u).map((part) => part.trim()).find((part) => part.length >= PARAGRAPH_MIN && !part.startsWith("#"));
  return paragraph ? paragraph.slice(0, PARAGRAPH_MATCH) : null;
}

/**
 * What a run's stream showed of its answer, in memory: when text first streamed and when the answer completed, each text event's time (all on the
 * harness's clock), each `message_reset` sent after text had streamed and whether the text after it still began with the text before it
 * (`rewritten` when not), and the long text's first paragraph as streamed before any reset.
 */
export function answerStreamFacts(events: readonly SseEvent[]) {
  let visible = "";
  let endAt: number | null = null;
  const tokenTimes: number[] = [];
  const segments: string[] = [];
  let resets = 0;
  for (const event of events) {
    if (event.type === "token" && record(event.data) && typeof event.data.delta === "string") {
      visible += event.data.delta;
      if (event.data.delta.trim()) tokenTimes.push(event.at);
    } else if (event.type === "message_reset") {
      segments.push(visible);
      if (visible.trim()) resets += 1;
      visible = "";
    } else if ((event.type === "answer_complete" || event.type === "done") && endAt === null) endAt = event.at;
  }
  segments.push(visible);
  // A reset that resends the same text (masking, a retried attempt) keeps it; one after which the text no longer begins with it rewrote the answer.
  const kept = (index: number) => {
    const next = segments.slice(index + 1).find((segment) => segment.trim()) ?? "";
    return next.trimStart().startsWith(segments[index]!.trim().slice(0, PARAGRAPH_MATCH));
  };
  const rewritten = segments.slice(0, -1).filter((segment, index) => segment.trim() && !kept(index)).length;
  const firstText = segments.find((segment) => segment.trim()) ?? "";
  return { endAt, firstParagraph: answerFirstParagraph(firstText), firstTokenAt: tokenTimes[0] ?? null, resetsAfterText: resets, rewritten, tokenTimes };
}

/** Where U's callback landed against the answer: into its text while it streamed, before any text, after the text ended, or nowhere. */
export type AnswerRaceLanding = "after_answer" | "before_answer" | "during_answer" | "none";

/** Text events this close on either side of the callback mean the answer was streaming when it came; a new round starts after a model call's wait. */
export const ANSWER_STREAMING_GAP_MS = 2_000;

/**
 * `callbackAt` is when the callback reached the run (its follow-up row, else the turn's end) and `tokenTimes` the text events, both on one clock;
 * `intoRun`, the callback went into this run rather than a wake-up turn.
 */
export function answerRaceLanding(input: Readonly<{ callbackAt: number | null; intoRun: boolean; tokenTimes: readonly number[] }>): AnswerRaceLanding {
  const { callbackAt } = input;
  if (callbackAt === null) return "none";
  if (!input.intoRun) return "after_answer";
  const before = input.tokenTimes.filter((at) => at <= callbackAt);
  const after = input.tokenTimes.filter((at) => at > callbackAt);
  if (before.length === 0) return "before_answer";
  if (after.length === 0) return "after_answer";
  return Math.min(...after) - Math.max(...before) <= ANSWER_STREAMING_GAP_MS ? "during_answer" : "after_answer";
}

export type AnswerRaceEvidence = Readonly<{
  landing: AnswerRaceLanding;
  paragraphKept: boolean | null;
  resetsAfterText: number;
  rewritten: number;
  status: string;
  /** Where the sub-agent's word stands in the saved answer against the first paragraph: absent (no addition), after it, or before it. */
  word: "absent" | "after" | "before";
}>;

/**
 * U's verdict: the run completed, the saved answer keeps the long text's first paragraph, and whatever came after the callback stands after it;
 * a reset after text streamed counts only when it rewrote the answer. `order_not_reached` (not a failure) when the callback did not land during it.
 */
export function oracleU(input: AnswerRaceEvidence) {
  const failed: string[] = [];
  if (input.status !== "complete") failed.push("run_not_complete");
  if (input.paragraphKept === null) failed.push("paragraph_not_streamed");
  else if (!input.paragraphKept) failed.push("paragraph_lost");
  if (input.rewritten > 0) failed.push("answer_rewritten");
  if (input.word === "before") failed.push("addition_before_answer");
  return { failed, orderNotReached: input.landing !== "during_answer" };
}

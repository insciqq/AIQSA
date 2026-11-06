import { researchDraftText, researchSummaryText, type ResearchDraft } from "../../contracts/research";

/**
 * What the answer says of research that did not fully finish. The server writes these in English, as all of the product's own words are (operator
 * decision 2026-11-02: no other interface language yet), and they are never left to the model: "the answer still arrives, with a visible note"
 * (`agent_docs/RUN_CONTRACTS.md`, Answer first).
 *
 * The reader gets no process notes (operator decision 2026-11-02): no counts, no model names, no remark that a check ran on the report's own model,
 * no check that found nothing, no list of what could not be reached and nothing that only says a send back was missed. Each note here says in one
 * plain sentence that the answer is incomplete or not fully checked, and only when it is. Content notes name rejected facts and the narrower support for
 * claims behind recommendations (`verifier.ts`), and evidence against the conclusion (`researchCounterEvidenceNote`).
 */
export type ResearchNoteKey = "before_plan" | "composed_failed" | "composed_no_report" | "composed_timed_out" | "followup_not_applied" | "gate_failed" | "incomplete" |
  "no_findings" | "not_submitted" | "run_failed" | "stopped" | "time_out";

const NOTES: Readonly<Record<ResearchNoteKey, string>> = {
  before_plan: "Research ended before its plan stood, so this is only what was written by then, and it is not checked.",
  composed_failed: "The answer failed before a report was written, so this is built from what research recorded: it draws no conclusion, picks nothing and is not checked.",
  composed_no_report: "No report was handed in, so this is built from what research recorded: it draws no conclusion, picks nothing and is not checked.",
  composed_timed_out: "Time ran out before a report was written, so this is built from what research recorded: it draws no conclusion, picks nothing and is not checked.",
  followup_not_applied: "What you wrote last arrived after this report was written and could not be taken into it.",
  gate_failed: "A check of this report could not be completed, so it is not fully checked.",
  incomplete: "The answer failed while this report was being written, so it is incomplete and not checked.",
  no_findings: "This report's claims could not be checked against their sources.",
  not_submitted: "Research ended before the report was handed in for checking, so this is its last text and it is not checked.",
  run_failed: "The answer failed while this report was being checked, so it is not fully checked.",
  stopped: "Stopped before the check of this report finished, so it is not fully checked.",
  time_out: "Time ran out before the checks of this report finished, so it is not fully checked."
};

export function researchNote(key: ResearchNoteKey): string {
  return NOTES[key];
}

const PROCESS_NOTES: ReadonlySet<string> = new Set(Object.values(NOTES));

/**
 * The notes of an answer that say something about its content, each once: the facts the checks rejected, the narrower support behind recommendations and the
 * evidence against the conclusion. The plain words that the answer is incomplete or not fully checked are about how it was made, so a research's page leaves them out.
 */
export function researchContentNotes(notes: readonly string[]): readonly string[] {
  return [...new Set(notes.map((note) => note.trim()).filter((note) => note && !PROCESS_NOTES.has(note)))];
}

/** What the check that tries to refute a report found. `quote` only where the quote check found it on an opened page: the gate's memory keeps it, the reader never sees it. */
export type ResearchCounterEvidence = Readonly<{ claim: string; quote: string | null; url: string }>;

/**
 * The evidence against the conclusion in one line, each piece with its link and nothing of its quote. Its words hold whether or not the report has since weighed
 * it, since only the same check can clear it and the server does not read prose to guess.
 */
export function researchCounterEvidenceNote(found: readonly ResearchCounterEvidence[]): string | null {
  if (found.length === 0) return null;
  const items = found.map(({ claim, url }) => `${claim.trim().replace(/[.!?…]+$/u, "")} (${url})`);
  return `Evidence against this conclusion, if the report above does not weigh it: ${items.join("; ")}.`;
}

/**
 * The one line the reader gets when sources establish only part of claims behind the options the report recommends and the draft went out unchanged past its cap:
 * the facts by option and criterion, as the server labels them (`verifier.ts`), never the claim's or the checker's words, since the checker read untrusted pages.
 */
export function researchPartialClaimsNote(labels: readonly (string | null)[], shown: number): string | null {
  if (labels.length === 0) return null;
  const named = [...new Set(labels.flatMap((label) => label ?? []))];
  if (named.length === 0) return "The sources establish only part of some facts behind the options this report recommends, so rely only on what they state.";
  const others = named.length > shown || labels.some((label) => label === null);
  return `The sources establish only part of what this report says about these facts, so rely only on what they state: ${named.slice(0, shown).join("; ")}${others ? "; and others" : ""}.`;
}

/**
 * Where the summary of an answer's text ends and its notes start, read from the draft the text was made of (`researchDraftText`, then
 * `researchAnswerText`), never from its prose. `shown` gives a part as the text shows it, so a masked secret moves no offset. Null offsets where the
 * text is not that draft's, has no summary or no notes, and the chat then shows what the offsets cannot mark.
 */
export function researchAnswerLayout(text: string, draft: Pick<ResearchDraft, "report" | "summary">, shown: (part: string) => string = (part) => part):
  Readonly<{ notesStart: number | null; summaryEnd: number | null }> {
  const body = shown(researchDraftText(draft).trimEnd());
  if (!body || !text.startsWith(body)) return { notesStart: null, summaryEnd: null };
  const summary = draft.summary ? shown(researchSummaryText(draft.summary)) : "";
  const summaryEnd = summary && summary.length < body.length && body.startsWith(summary) ? summary.length : null;
  return { notesStart: text.slice(body.length).trim() ? body.length : null, summaryEnd };
}

/** The answer the user reads: the report as written, then the notes, each once. */
export function researchAnswerText(report: string, notes: readonly string[]): string {
  const shown = [...new Set(notes.map((note) => note.trim()).filter(Boolean))];
  return shown.length > 0 ? `${report.trimEnd()}\n\n---\n\n${shown.map((note) => `*${note}*`).join("\n\n")}` : report;
}

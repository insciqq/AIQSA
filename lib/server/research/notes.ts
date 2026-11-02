/**
 * What the answer says of research that did not fully finish. The server
 * writes these in English, as all of the product's own words are (operator decision 2026-11-02: no other
 * interface language yet), and they are never left to the model: "the answer still arrives, with a visible
 * note" (`agent_docs/RUN_CONTRACTS.md`, Answer first).
 */
export type ResearchNoteKey = "before_plan" | "composed_failed" | "composed_no_report" | "composed_timed_out" | "followup_not_applied" | "gap_judge_unfinished" | "gate_failed" | "incomplete" | "no_findings" |
  "not_submitted" | "report_added_criteria" | "report_branches_open" | "report_criteria_missing" | "report_links_unrecorded" | "report_no_table" | "report_not_separated" | "report_pick_outside" |
  "report_pick_unbacked" | "report_typed_findings" | "report_unknown_records" | "report_unlinked_sources" | "report_unreadable_references" | "report_would_decide" | "run_failed" | "stopped" | "time_out" | "unresolved";

const NOTES: Readonly<Record<ResearchNoteKey, string>> = {
  before_plan: "Research ended before its plan stood, so this is only what was written by then, and it is not checked.",
  composed_failed: "The answer failed before a report was written, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
  composed_no_report: "No report was handed in, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
  composed_timed_out: "Time ran out before a report was written, so the server built this from what research recorded. It draws no conclusion and picks nothing, and no check read it.",
  followup_not_applied: "What you wrote last arrived after this report was written and could not be taken into it.",
  gap_judge_unfinished: "The check for open questions could not be finished.",
  gate_failed: "A check of this report could not be completed, so it is not fully checked.",
  incomplete: "The answer failed while this report was being written, so it is incomplete and not checked.",
  no_findings: "This report came without a list of findings, so its claims could not be checked against their sources.",
  not_submitted: "Research ended before the report was handed in for checking, so this is its last text and it is not checked.",
  report_added_criteria: "Criteria added during research, which this report does not name:",
  report_branches_open: "This report gives no pick for these cases, though they change the result:",
  report_criteria_missing: "The comparison in this report leaves out:",
  report_links_unrecorded: "Some links in this report have no research record cited behind them, so what they back was not checked.",
  report_no_table: "This report has no comparison table on the research's criteria.",
  report_not_separated: "The data does not separate these options:",
  report_pick_outside: "This report's pick is not among the options research compared, so it does not follow from that comparison.",
  report_pick_unbacked: "The records behind this report's pick were not handed in with it, so the checks did not read them:",
  report_typed_findings: "This report's findings were not tied to research records, so they were not checked against them.",
  report_unknown_records: "This report refers to research records that do not stand, so what rests on them was not checked.",
  report_unlinked_sources: "Some sources of this report are not linked in its text.",
  report_unreadable_references: "The references of this report could not be read, so the checks did not read the records behind it.",
  report_would_decide: "What would decide:",
  run_failed: "The answer failed while this report was being checked, so it is not fully checked.",
  stopped: "Stopped before the check of this report finished, so it is not fully checked.",
  time_out: "Time ran out before the checks of this report finished, so it is not fully checked.",
  unresolved: "Research ended with remarks of its last check still open, so this report is not fully checked."
};

export function researchNote(key: ResearchNoteKey): string {
  return NOTES[key];
}

/** What the check that tries to refute a report found. `quote` only where the quote check found it on an opened page. */
export type ResearchCounterEvidence = Readonly<{ claim: string; quote: string | null; url: string }>;

/** How that check ended when it has no such finding to name. */
export type ResearchSkepticOutcome = "busy" | "failed" | "no_time" | "none_found" | "timed_out" | "unavailable" | "unbacked";

const SKEPTIC_NOTES: Readonly<Record<ResearchSkepticOutcome, string>> = {
  busy: "The check that looks for evidence against the conclusion could not start, as this chat is running as many sub-agents as it may.",
  failed: "The check that looks for evidence against the conclusion failed.",
  no_time: "The check that looks for evidence against the conclusion did not run, as too little time was left for it.",
  none_found: "The check that looks for evidence against the conclusion found nothing that outweighs it.",
  timed_out: "Time ran out during the check that looks for evidence against the conclusion.",
  unavailable: "The check that looks for evidence against the conclusion did not run: the model chosen for it is not available to this answer.",
  unbacked: "The check that looks for evidence against the conclusion named something it could not show on a page it opened, so that is left out."
};

/** `mainModel`: it found nothing on the model that wrote the report, which the answer must say (`agent_docs/RUN_CONTRACTS.md`, Research). */
export function researchSkepticNote(outcome: ResearchSkepticOutcome, mainModel: string | null = null): string {
  const note = SKEPTIC_NOTES[outcome];
  return mainModel === null ? note : `${note} It ran on the main model (${mainModel}), which also wrote this report, so it is not independent.`;
}

/** Names what that check found, in words true whether or not the report still holds or has since weighed it: only the same check can clear it. */
export function researchCounterEvidenceNote(found: readonly ResearchCounterEvidence[]): string {
  const items = found.map(({ claim, quote, url }, index) => `${found.length > 1 ? `${index + 1}) ` : ""}${claim}${quote ? ` ("${quote}")` : ""}, ${url}`).join("; ");
  return `The check that looks for evidence against the conclusion found what may overturn it; if the report above does not weigh this, weigh it yourself: ${items}.`;
}

/** The answer the user reads: the report as written, then the notes, each once. */
export function researchAnswerText(report: string, notes: readonly string[]): string {
  const shown = [...new Set(notes.map((note) => note.trim()).filter(Boolean))];
  return shown.length > 0 ? `${report.trimEnd()}\n\n---\n\n${shown.map((note) => `*${note}*`).join("\n\n")}` : report;
}

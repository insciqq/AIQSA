import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, RESEARCH_ROUND_LIMITS, SUBMIT_RESEARCH_DRAFT_TOOL_NAME, type ResearchPlan, type ResearchQuestion } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { PlanUpdate } from "../tools/updatePlan";
import { RESEARCH_REVIEWS_REFERENCE } from "./dataCollection";
import { researchEmptyByRow, type ResearchEmptyRow, type ResearchMatrix } from "./matrix";

/**
 * The research method, owned by the server rather than left to the model's
 * memory of a prompt: what the main agent reads when research starts, what
 * every researcher's brief ends with whatever the main agent wrote in it
 * (`researcherBrief`), so each one gets its source classes and returns quotes,
 * and what the matrix says of itself as a round goes (`researchCoverageLine`),
 * so the next round is planned from the empty cells.
 */

const classLine = (question: ResearchQuestion, index: number) =>
  `${index + 1}. ${question.question} [${question.sourceClasses.join(", ")}]${question.sites.length > 0 ? ` (sites the user named: ${question.sites.join(", ")})` : ""}`;

/** What a plan that stands returns: how the main agent runs what it planned. */
export function researchMethodText(plan: ResearchPlan): string {
  return [
    "The plan stands. The user sees your questions as the plan; keep it current with update_plan.",
    `Start the researchers now with ${CALL_SUBAGENT_TOOL_NAME}: in one response, one call per question, without background, so they work in ` +
      "parallel and you get their reports together. Name in each brief which question it covers and the matrix cells it is to fill. The server " +
      "adds the method, the source classes and the matrix to each brief; do not repeat them.",
    "Do not write the report as a message: nothing you write while research runs reaches the user, and search snippets are not evidence.",
    "After each researcher's report you read what is still empty in the matrix. Send more researchers for empty cells only, never for one " +
      `more detail of a filled cell. ${RESEARCH_ROUND_LIMITS.noNewCellRounds} rounds of researchers in a row that fill no new cell end the research. ` +
      `A row or a criterion that turns out to matter goes in with ${CHANGE_RESEARCH_FRAME_TOOL_NAME}.`,
    `When the matrix is covered, or nothing more can fill it, call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the report, ` +
      "every finding and what could not be reached. The report keeps apart what is confirmed, what a party claims and what is not verified, " +
      "and says what could not be reached and why.",
    "",
    "The plan:",
    ...plan.questions.map(classLine),
    ...plan.skipped.map((entry) => `Skipped ${entry.sourceClass}: ${entry.reason}`)
  ].join("\n");
}

/** What ends a researcher's brief. It stays short: a brief rides on the follow-up store's bound. */
export function researcherMethodFooter(plan: ResearchPlan): string {
  return [
    "# Research method (from the server)",
    "You are one researcher of this research. Work on the question your brief names. The plan, with each question's source classes:",
    ...plan.questions.map(classLine),
    "",
    "Source classes: primary_official (the maker, the regulator, official documents), independent_tests (labs, independent reviews, " +
      "measurements), owner_reviews (what owners and users report, complaints included), action_channel (where the user will buy or act, " +
      "with current prices, stock and terms).",
    "For each source class of your question, open real pages with fetch_url or the browser: a search snippet is not evidence.",
    "Record each finding with record_evidence as soon as you have it, while you still have the page, and correct it if its result says the quote is not there.",
    "Give each record the row_key and criterion_key of its cell in the matrix below. A cell you cannot fill: record not_found for it, so nobody looks there again. " +
      `A candidate or an option the matrix lacks: add its row with ${CHANGE_RESEARCH_FRAME_TOOL_NAME}. A criterion only when the question needs it, with your reason.`,
    RESEARCH_REVIEWS_REFERENCE,
    "Report every finding as: claim; link; a verbatim quote copied from the page you opened; source class; and whether it is confirmed, " +
      "claimed by a party or not verified.",
    "List what you could not reach and why. If a site the user named shows a CAPTCHA or asks to sign in, call browser_handoff so the user " +
      "can pass it; never skip such a site. Any other site that blocks you: say so and go on."
  ].join("\n");
}

/** The longest the matrix may make a brief: every researcher reads it, and a long one falls back to counts per row. */
const MATRIX_FOOTER_CHARACTERS = 3_000;
const COVERAGE_LINE_CHARACTERS = 600;

const plain = (text: string) => text.replace(/\s+/gu, " ").trim();
const rowOf = ({ row }: ResearchEmptyRow) => row ? `${row.key}: ` : "";
const emptyCells = (rows: readonly ResearchEmptyRow[]) => rows.map((entry) => `${rowOf(entry)}${entry.criteria.map(({ key }) => key).join(", ")}`).join("; ");
const emptyCounts = (rows: readonly ResearchEmptyRow[], criteria: number) => rows.map((entry) => `${rowOf(entry)}${entry.criteria.length} of ${criteria}`).join("; ");

/** What ends a researcher's brief: the keys it records under and the cells still empty, as much of that as `room` holds. */
export function researcherMatrixFooter(matrix: ResearchMatrix, room: number): string | null {
  const { coverage, frame } = matrix;
  const empty = researchEmptyByRow(matrix);
  const noRows = `Rows: none yet. Add each candidate, study or option you find with ${CHANGE_RESEARCH_FRAME_TOOL_NAME}. Where the question has none, row_key is not read: leave it null, or use "all" where a record needs one.`;
  const rowKeys = frame.rows.length > 0 ? `Rows: ${frame.rows.map(({ key }) => key).join(", ")}.` : noRows;
  const criterionKeys = `Criteria: ${frame.criteria.map(({ key }) => key).join(", ")}.`;
  const total = `${coverage.empty} of ${coverage.cells.length} cells are still empty.`;
  const forms = [
    [frame.rows.length > 0 ? `Rows: ${frame.rows.map(({ key, label }) => `${key} (${plain(label)})`).join(", ")}.` : noRows,
      `Criteria: ${frame.criteria.map(({ criterion, key }) => `${key} (${plain(criterion)})`).join(", ")}.`, `${total} ${emptyCells(empty)}`.trim()],
    [rowKeys, criterionKeys, `${total} ${emptyCounts(empty, frame.criteria.length)}`.trim()],
    [rowKeys, criterionKeys, total],
    [total]
  ].map((lines) => ["# The matrix (from the server)", ...lines].join("\n"));
  return forms.find((form) => form.length <= Math.min(room, MATRIX_FOOTER_CHARACTERS)) ?? null;
}

/** A brief with as much of the matrix as its bound leaves room for: a matrix is no reason to refuse one. */
export function researcherMatrixBrief(brief: string, matrix: ResearchMatrix | null): string {
  const footer = matrix && researcherMatrixFooter(matrix, RUN_FOLLOWUP_MAX_CHARS - brief.length - 2);
  return footer ? `${brief}\n\n${footer}` : brief;
}

/** A researcher's first brief, with the method and the matrix, or null when the method would not fit the bound on a brief. */
export function researcherBrief(brief: string, plan: ResearchPlan, matrix: ResearchMatrix | null = null): string | null {
  const full = `${brief}\n\n${researcherMethodFooter(plan)}`;
  return full.length <= RUN_FOLLOWUP_MAX_CHARS ? researcherMatrixBrief(full, matrix) : null;
}

/** What the main agent reads after each researcher's report, in that call's result: what the next round is planned from. */
export function researchCoverageLine(matrix: ResearchMatrix, newCells: number | null): string {
  const { coverage, frame } = matrix;
  const sofar = newCells === null ? "" : `, ${newCells} newly filled in this round so far`;
  const opening = `The matrix (from the server): ${coverage.empty} of ${coverage.cells.length} cells empty${sofar}.`;
  if (coverage.empty === 0) return `${opening} Nothing is left for researchers to fill.`;
  const empty = researchEmptyByRow(matrix);
  const closing = "Send researchers for empty cells only.";
  return [`${opening} Empty: ${emptyCells(empty)}. ${closing}`, `${opening} Empty: ${emptyCounts(empty, frame.criteria.length)}. ${closing}`]
    .find((form) => form.length <= COVERAGE_LINE_CHARACTERS) ?? `${opening} ${closing}`;
}

/** Why no further researcher starts, as the refused call says it. */
export function researchNoNewCellMessage(): string {
  return `Nothing started: ${RESEARCH_ROUND_LIMITS.noNewCellRounds} rounds of researchers in a row filled no new cell of the matrix, so research ends here. ` +
    `Call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the report from what is recorded, and say which cells stayed empty.`;
}

/** The plan the answer's process disclosure shows when research starts: the user sees it started, and takes no action. */
export function researchPlanUpdate(plan: ResearchPlan): PlanUpdate {
  return {
    plan: plan.questions.map((question, index) => ({ status: index === 0 ? "in_progress" as const : "pending" as const, step: question.question }))
  };
}

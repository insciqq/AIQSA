import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { SUBMIT_RESEARCH_DRAFT_TOOL_NAME, type ResearchPlan, type ResearchQuestion } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { PlanUpdate } from "../tools/updatePlan";

/**
 * The research method, owned by the server rather than left to the model's
 * memory of a prompt: what the main agent reads when research starts, and what
 * every researcher's brief ends with whatever the main agent wrote in it
 * (`researcherBrief`), so each one gets its source classes and returns quotes.
 */

const classLine = (question: ResearchQuestion, index: number) =>
  `${index + 1}. ${question.question} [${question.sourceClasses.join(", ")}]${question.sites.length > 0 ? ` (sites the user named: ${question.sites.join(", ")})` : ""}`;

/** What `start_research` returns: how the main agent runs what it just planned. */
export function researchMethodText(plan: ResearchPlan): string {
  return [
    "Research started. The user sees your questions as the plan; keep it current with update_plan.",
    `Start the researchers now with ${CALL_SUBAGENT_TOOL_NAME}: in one response, one call per question, without background, so they work in ` +
      "parallel and you get their reports together. Name in each brief which question it covers. The server adds the method and the source " +
      "classes to each brief; do not repeat them.",
    "Do not write the report as a message: nothing you write while research runs reaches the user, and search snippets are not evidence.",
    `When the reports are in, send more researchers for what is still open, then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} with the report, ` +
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
    "Report every finding as: claim; link; a verbatim quote copied from the page you opened; source class; and whether it is confirmed, " +
      "claimed by a party or not verified.",
    "List what you could not reach and why. If a site the user named shows a CAPTCHA or asks to sign in, call browser_handoff so the user " +
      "can pass it; never skip such a site. Any other site that blocks you: say so and go on."
  ].join("\n");
}

/** A researcher's brief with the method, or null when it would not fit the bound on a brief. */
export function researcherBrief(brief: string, plan: ResearchPlan): string | null {
  const full = `${brief}\n\n${researcherMethodFooter(plan)}`;
  return full.length <= RUN_FOLLOWUP_MAX_CHARS ? full : null;
}

/** The plan the answer's process disclosure shows when research starts: the user sees it started, and takes no action. */
export function researchPlanUpdate(plan: ResearchPlan): PlanUpdate {
  return {
    plan: plan.questions.map((question, index) => ({ status: index === 0 ? "in_progress" as const : "pending" as const, step: question.question }))
  };
}

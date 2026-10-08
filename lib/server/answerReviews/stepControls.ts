import { decodeSearchPlan, type SearchPlan } from "../../contracts/search";

/** The control keys a step takes from the chat; everything else in a send body is the server's. */
const STEP_CONTROL_KEYS = [
  "agentEnabled", "knowledgePlan", "mcp", "searchPlan", "searchPreferencePlan", "searchPreferenceSource", "skillIds",
  "skills", "timeZone", "tools", "workspace"
] as const;

/** The chat's controls a step's send carries: Search, MCP, Workspace, Knowledge, Skills and the time zone. */
export function answerReviewStepControls(controls: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(STEP_CONTROL_KEYS.flatMap((key) => Object.hasOwn(controls, key) ? [[key, controls[key]]] : []));
}

/**
 * What an automatic session froze at its user's send for every step: that
 * send's controls, which the author's revisions use as they are, and each
 * reviewer's Search as the composer reconciled it for that reviewer's model.
 * Every step's admission checks them again like any send.
 */
export type AnswerReviewAutoControls = Readonly<{
  controls: Readonly<Record<string, unknown>>;
  reviewerSearchPlans: readonly SearchPlan[];
  version: 1;
}>;

/** Frozen controls are bounded like the body they came from. */
export const ANSWER_REVIEW_AUTO_CONTROLS_MAX_BYTES = 32_768;

export function decodeAnswerReviewAutoControls(value: unknown): AnswerReviewAutoControls | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.controls !== "object" || candidate.controls === null ||
    Array.isArray(candidate.controls) || !Array.isArray(candidate.reviewerSearchPlans)) return null;
  const plans: SearchPlan[] = [];
  for (const plan of candidate.reviewerSearchPlans) {
    const decoded = decodeSearchPlan(plan);
    if (!decoded.ok) return null;
    plans.push(decoded.plan);
  }
  return {
    controls: answerReviewStepControls(candidate.controls as Record<string, unknown>),
    reviewerSearchPlans: plans,
    version: 1
  };
}

/**
 * A step's controls from its session's frozen ones: a reviewer searches with
 * its own reconciled Search, the author with the send's own.
 */
export function answerReviewAutoStepControls(
  frozen: AnswerReviewAutoControls,
  step: Readonly<{ kind: "review"; reviewer: number } | { kind: "revision" }>
): Record<string, unknown> {
  if (step.kind === "revision") return { ...frozen.controls };
  const searchPlan = frozen.reviewerSearchPlans[step.reviewer] ?? { mode: "all_selected", optionIds: [] };
  return { ...frozen.controls, searchPlan: { mode: searchPlan.mode, optionIds: [...searchPlan.optionIds] } };
}

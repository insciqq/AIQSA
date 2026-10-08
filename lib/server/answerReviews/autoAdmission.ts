import {
  ANSWER_REVIEW_TEXT_LIMITS,
  decodeAnswerReviewSendRequest,
  type AnswerReviewRefusal
} from "../../contracts/answerReviews";
import type { AnswerReviewAutoAdmission } from "../runs/runRepositoryContract";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { admitAnswerReviewToolModel, type AnswerReviewServiceDeps } from "./service";
import {
  ANSWER_REVIEW_AUTO_CONTROLS_MAX_BYTES,
  answerReviewStepControls,
  type AnswerReviewAutoControls
} from "./stepControls";

export type AnswerReviewAutoResolution =
  | Readonly<{ auto?: AnswerReviewAutoAdmission; ok: true }>
  | Readonly<{ code: AnswerReviewRefusal; ok: false; status: 400 | 409 }>;

const refused = (code: AnswerReviewRefusal, status: 400 | 409 = 409): AnswerReviewAutoResolution => ({ code, ok: false, status });

/**
 * A send's or regeneration's automatic review (`answerReview` in its body),
 * resolved after its preparation and before admission. Nothing is requested:
 * no session. Otherwise the answer must be reviewable (no Assistant, Agent or
 * Knowledge, an answer model that calls tools) and every reviewer is admitted
 * now for this user like a send would admit it (catalog, entitlement, Project
 * models, tool calling), never the answer's own model. A request the composer
 * should not have made is refused with the reason it shows; nothing is
 * dropped or substituted.
 */
export async function resolveAnswerReviewAuto(
  deps: Partial<Pick<AnswerReviewServiceDeps, "providerAdmission">>,
  input: Readonly<{
    body: Readonly<Record<string, unknown>> | null;
    prepared: Pick<MaterializedPreparedRunData, "assistant" | "chatAssistant" | "normalizedRequest" | "project" |
      "providerAdmissionPlan">;
    userId: string;
  }>
): Promise<AnswerReviewAutoResolution> {
  if (!input.body || !Object.hasOwn(input.body, "answerReview")) return { ok: true };
  const request = decodeAnswerReviewSendRequest(input.body.answerReview);
  if (!request) return refused("answer_review_invalid", 400);
  const { normalizedRequest, project, providerAdmissionPlan: plan } = input.prepared;
  // The Assistant fixes the model; Codex owns Agent's loop; Knowledge answers stay bound to their Sources.
  if (input.prepared.assistant || input.prepared.chatAssistant) return refused("answer_review_assistant_unsupported");
  if (normalizedRequest.agent) return refused("answer_review_agent_unsupported");
  if (normalizedRequest.knowledgePlan.mode !== "none") return refused("answer_review_knowledge_unsupported");
  if (plan.answer.modelConfiguration.capabilities.toolCalling !== true || input.body.tools === "none") {
    return refused("answer_review_model_unsupported");
  }
  const author = {
    modelId: plan.selection.providerModelId,
    name: Array.from(plan.answer.snapshot.modelDisplayName.trim() || "Model").slice(0, ANSWER_REVIEW_TEXT_LIMITS.modelName).join(""),
    provider: plan.selection.providerConnectionId
  };
  // An independent model reviews: never the answer's own; in a Project only its models.
  if (request.reviewers.some((reviewer) => reviewer.provider === author.provider && reviewer.modelId === author.modelId) ||
    (project && request.reviewers.some((reviewer) => !project.modelIds.includes(reviewer.modelId)))) {
    return refused("answer_review_reviewer_unavailable");
  }
  const providerAdmission = deps.providerAdmission;
  if (!providerAdmission) return refused("answer_review_reviewer_unavailable");
  const reviewers: Array<AnswerReviewAutoAdmission["reviewers"][number]> = [];
  for (const reviewer of request.reviewers) {
    const admitted = await admitAnswerReviewToolModel({ providerAdmission }, reviewer, {
      projectId: project?.projectId ?? null, userId: input.userId
    });
    if (!admitted) return refused("answer_review_reviewer_unavailable");
    reviewers.push(admitted);
  }
  const controls: AnswerReviewAutoControls = {
    controls: answerReviewStepControls(input.body),
    reviewerSearchPlans: request.reviewers.map((reviewer) => reviewer.searchPlan),
    version: 1
  };
  if (JSON.stringify(controls).length > ANSWER_REVIEW_AUTO_CONTROLS_MAX_BYTES) return refused("answer_review_invalid", 400);
  return { auto: { authorModel: author, controls, maxRounds: request.maxRounds, reviewers }, ok: true };
}

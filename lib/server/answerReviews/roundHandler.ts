import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { answerReviewSessionWire } from "./repository";
import {
  ANSWER_REVIEW_ROUTE_ID,
  answerReviewJson,
  answerReviewUnavailable,
  hasExactRouteKeys,
  isRouteRecord,
  type RouteParams
} from "./routeSupport";
import { decodeAnswerReviewReviewerRequest, startAnswerReviewRound, type AnswerReviewServiceDeps } from "./service";

/**
 * `POST /api/chats/[chatId]/answer-reviews` with `{ answerMessageId,
 * expectedActiveLeafId, reviewers }`: starts a review round on the chat's
 * latest answer and returns its session. Nothing runs here, so the route never
 * loads the run pipeline: the round's first step starts through the steps route.
 */
export function createAnswerReviewRoundHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: () => AnswerReviewServiceDeps;
}>) {
  return async function POST(request: Request, context: { params: RouteParams<{ chatId: string }> }): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return answerReviewJson({ error: "unauthorized" }, 401);
    if (session.user.status !== "active") return answerReviewJson({ error: "forbidden" }, 403);
    const { chatId } = await context.params;
    if (!ANSWER_REVIEW_ROUTE_ID.test(chatId)) return answerReviewJson({ error: "answer_review_unavailable" }, 404);
    const body = await readJsonBodyOrNull(request, "json");
    const tooLarge = requestBodyErrorResponse(body);
    if (tooLarge) return tooLarge;
    const reviewers = isRouteRecord(body) ? decodeAnswerReviewReviewerRequest(body.reviewers) : null;
    if (!isRouteRecord(body) || !hasExactRouteKeys(body, ["answerMessageId", "expectedActiveLeafId", "reviewers"]) || !reviewers ||
      typeof body.answerMessageId !== "string" || !ANSWER_REVIEW_ROUTE_ID.test(body.answerMessageId) ||
      typeof body.expectedActiveLeafId !== "string" || !ANSWER_REVIEW_ROUTE_ID.test(body.expectedActiveLeafId)) {
      return answerReviewJson({ error: "answer_review_invalid" }, 400);
    }
    try {
      const result = await startAnswerReviewRound(deps.service(), {
        answerMessageId: body.answerMessageId, chatId, expectedActiveLeafId: body.expectedActiveLeafId, reviewers,
        userId: session.userId
      });
      return result.ok
        ? answerReviewJson({ session: answerReviewSessionWire(result.session, session.userId) })
        : answerReviewJson({ error: result.code }, result.status);
    } catch (error) {
      return answerReviewUnavailable(error);
    }
  };
}

import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import {
  ANSWER_REVIEW_ROUTE_ID,
  answerReviewJson,
  answerReviewUnavailable,
  hasExactRouteKeys,
  isRouteRecord,
  type RouteParams
} from "./routeSupport";
import { startAnswerReviewStep, type AnswerReviewStepStartDeps } from "./stepStart";

/**
 * `POST /api/answer-reviews/[sessionId]/steps` with `{ admissionId, controls,
 * expectedActiveLeafId, kind }`: starts the session's next step. The response
 * is that step's ordinary run stream, returned as soon as the step's run is
 * admitted; other users' and missing sessions look alike.
 */
export function createAnswerReviewStepHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  steps: () => AnswerReviewStepStartDeps;
}>) {
  return async function POST(request: Request, context: { params: RouteParams<{ sessionId: string }> }): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return answerReviewJson({ error: "unauthorized" }, 401);
    if (session.user.status !== "active") return answerReviewJson({ error: "forbidden" }, 403);
    const { sessionId } = await context.params;
    if (!ANSWER_REVIEW_ROUTE_ID.test(sessionId)) return answerReviewJson({ error: "answer_review_unavailable" }, 404);
    const body = await readJsonBodyOrNull(request, "json");
    const tooLarge = requestBodyErrorResponse(body);
    if (tooLarge) return tooLarge;
    if (!isRouteRecord(body) || !hasExactRouteKeys(body, ["admissionId", "controls", "expectedActiveLeafId", "kind"]) ||
      (body.kind !== "review" && body.kind !== "revision") || !isRouteRecord(body.controls) ||
      typeof body.admissionId !== "string" || !ANSWER_REVIEW_ROUTE_ID.test(body.admissionId) ||
      typeof body.expectedActiveLeafId !== "string" || !ANSWER_REVIEW_ROUTE_ID.test(body.expectedActiveLeafId)) {
      return answerReviewJson({ error: "answer_review_invalid" }, 400);
    }
    try {
      const started = await startAnswerReviewStep(deps.steps(), {
        admissionId: body.admissionId,
        controls: body.controls,
        expectedActiveLeafId: body.expectedActiveLeafId,
        // The browser starts only a manual session's steps; the server drives an automatic one.
        expectedMode: "manual",
        kind: body.kind,
        // The browser session is resolved again whenever the send asks.
        resolveAuth: () => deps.resolveAuth(request),
        sessionId,
        userId: session.userId
      });
      return started.response;
    } catch (error) {
      return answerReviewUnavailable(error);
    }
  };
}

import type { RequestAuthResolver } from "../auth/requestAuth";
import type { AnswerReviewDriver } from "./autoDriver";
import { answerReviewSessionWire } from "./repository";
import {
  ANSWER_REVIEW_ROUTE_ID,
  answerReviewJson,
  answerReviewUnavailable,
  type RouteParams
} from "./routeSupport";

/**
 * `POST /api/answer-reviews/[sessionId]/stop`: the initiator stops an
 * automatic session at any moment, between steps too; its running step stops
 * with it. Returns the session; other users' and missing sessions look alike.
 */
export function createAnswerReviewStopHandler(deps: Readonly<{
  driver: () => Pick<AnswerReviewDriver, "stop">;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function POST(request: Request, context: { params: RouteParams<{ sessionId: string }> }): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return answerReviewJson({ error: "unauthorized" }, 401);
    if (session.user.status !== "active") return answerReviewJson({ error: "forbidden" }, 403);
    const { sessionId } = await context.params;
    if (!ANSWER_REVIEW_ROUTE_ID.test(sessionId)) return answerReviewJson({ error: "answer_review_unavailable" }, 404);
    try {
      const stopped = await deps.driver().stop({ sessionId, userId: session.userId });
      return stopped
        ? answerReviewJson({ session: answerReviewSessionWire(stopped.session, session.userId) })
        : answerReviewJson({ error: "answer_review_unavailable" }, 404);
    } catch (error) {
      return answerReviewUnavailable(error);
    }
  };
}

import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { answerReviewHandlers } from "@/lib/server/answerReviews/defaultAnswerReviews";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof answerReviewHandlers.POST_ROUND> = answerReviewHandlers.POST_ROUND;

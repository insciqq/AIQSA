import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { answerReviewStopHandler } from "@/lib/server/answerReviews/defaultAnswerReviewStop";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof answerReviewStopHandler> = answerReviewStopHandler;

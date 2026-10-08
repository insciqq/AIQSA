import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { answerReviewRoundHandler } from "@/lib/server/answerReviews/defaultAnswerReviewRound";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof answerReviewRoundHandler> = answerReviewRoundHandler;

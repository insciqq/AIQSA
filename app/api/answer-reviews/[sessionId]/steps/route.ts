import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { answerReviewStepHandler } from "@/lib/server/answerReviews/defaultAnswerReviewSteps";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<typeof answerReviewStepHandler> = answerReviewStepHandler;

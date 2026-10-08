import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createAnswerReviewStepHandler } from "./stepHandler";
import type { AnswerReviewStepStartDeps } from "./stepStart";

const globalForAnswerReviews = globalThis as typeof globalThis & {
  __aiqsaAnswerReviewSendDeps?: AnswerReviewStepStartDeps["sendDeps"];
};

/** One set of send services per process, shared by every route bundle, built on first use. */
function sendDeps(): AnswerReviewStepStartDeps["sendDeps"] {
  globalForAnswerReviews.__aiqsaAnswerReviewSendDeps ??= createDefaultSendMessageDeps();
  return globalForAnswerReviews.__aiqsaAnswerReviewSendDeps;
}

export const answerReviewStepHandler = createAnswerReviewStepHandler({
  resolveAuth: resolveRequestAuth,
  steps: () => ({ prisma, sendDeps: sendDeps() })
});

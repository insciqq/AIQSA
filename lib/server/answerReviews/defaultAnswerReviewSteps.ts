import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createAnswerReviewStepHandler } from "./stepHandler";
import type { AnswerReviewStepStartDeps } from "./stepStart";

const globalForAnswerReviews = globalThis as typeof globalThis & {
  __aiqsaAnswerReviewSendDeps?: AnswerReviewStepStartDeps["sendDeps"];
};

/** One set of send services per process, shared by every route bundle and the automatic driver, built on first use. */
export function defaultAnswerReviewSendDeps(): AnswerReviewStepStartDeps["sendDeps"] {
  globalForAnswerReviews.__aiqsaAnswerReviewSendDeps ??= createDefaultSendMessageDeps();
  return globalForAnswerReviews.__aiqsaAnswerReviewSendDeps;
}

export const answerReviewStepHandler = createAnswerReviewStepHandler({
  resolveAuth: resolveRequestAuth,
  steps: () => ({ prisma, sendDeps: defaultAnswerReviewSendDeps() })
});

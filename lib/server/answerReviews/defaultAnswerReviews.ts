import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createAnswerReviewHandlers } from "./handlers";
import type { AnswerReviewStepStartDeps } from "./stepStart";

const globalForAnswerReviews = globalThis as typeof globalThis & {
  __aiqsaAnswerReviewSendDeps?: AnswerReviewStepStartDeps["sendDeps"];
};

/** One set of send services per process, shared by every route bundle, built on first use. */
function sendDeps(): AnswerReviewStepStartDeps["sendDeps"] {
  globalForAnswerReviews.__aiqsaAnswerReviewSendDeps ??= createDefaultSendMessageDeps();
  return globalForAnswerReviews.__aiqsaAnswerReviewSendDeps;
}

export const answerReviewHandlers = createAnswerReviewHandlers({
  resolveAuth: resolveRequestAuth,
  service: () => ({ prisma, providerAdmission: providerAdmissionService }),
  steps: () => ({ prisma, sendDeps: sendDeps() })
});

import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { createAnswerReviewRoundHandler } from "./roundHandler";

export const answerReviewRoundHandler = createAnswerReviewRoundHandler({
  resolveAuth: resolveRequestAuth,
  service: () => ({ prisma, providerAdmission: providerAdmissionService })
});

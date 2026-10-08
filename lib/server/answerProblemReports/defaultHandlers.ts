import { getAuthConfig } from "../auth/config";
import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { prisma } from "../prisma";
import {
  ANSWER_PROBLEM_REPORT_RATE_LIMIT,
  ANSWER_PROBLEM_REPORT_RATE_LIMIT_WINDOW_MS,
  createAnswerProblemReportHandlers
} from "./handlers";
import { createPrismaAnswerProblemReportRepository } from "./repository";

/** One durable per-user window for report creates and updates. */
const rateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: ANSWER_PROBLEM_REPORT_RATE_LIMIT,
  prisma,
  windowMs: ANSWER_PROBLEM_REPORT_RATE_LIMIT_WINDOW_MS
});

export const answerProblemReportHandlers = createAnswerProblemReportHandlers({
  rateLimiter,
  repository: () => createPrismaAnswerProblemReportRepository(prisma),
  resolveAuth: resolveRequestAuth
});

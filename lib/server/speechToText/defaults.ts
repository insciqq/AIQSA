import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { prisma } from "../prisma";
import { usageLimitsRepository } from "../usageLimits/defaultRepository";
import { createSpeechToTextAdminService } from "./adminService";
import { resolveSpeechToTextRole } from "./role";
import { DICTATION_RATE_LIMIT, DICTATION_RATE_LIMIT_WINDOW_MS, type TranscribeUserAudioDeps } from "./transcribeUserAudio";

export const speechToTextAdminService = createSpeechToTextAdminService({ db: prisma });

/** One durable per-user window for dictation attempts. */
const dictationRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: DICTATION_RATE_LIMIT,
  prisma,
  windowMs: DICTATION_RATE_LIMIT_WINDOW_MS
});

/** Production dependencies of `transcribeUserAudio`, for the dictation route and other server callers. */
export const transcriptionHandlerDeps: TranscribeUserAudioDeps = {
  rateLimiter: dictationRateLimiter,
  resolveRole: () => resolveSpeechToTextRole(prisma),
  usageLimits: usageLimitsRepository,
  writeUsage: (data) => prisma.usageEvent.create({ data, select: { id: true } })
};

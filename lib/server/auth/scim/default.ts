import { prisma } from "../../prisma";
import { getAuthConfig } from "../config";
import { createPrismaLoginRateLimiter } from "../prismaRateLimit";
import { resolveSignInMethods } from "../signInMethods";
import { recordSignInMethodOutcome } from "../signInSettings/defaultSignInSettings";
import { createScimHandler } from "./handlers";
import { createPrismaScimRepository } from "./repository";
import { createPrismaScimTokenRepository } from "./tokens";

const SCIM_AUTH_FAILURES_PER_WINDOW = 30;
const SCIM_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1_000;

export const scimTokenRepository = createPrismaScimTokenRepository(prisma);

export const defaultScimHandler = createScimHandler({
  getConfig: () => getAuthConfig(),
  rateLimiter: createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    maxAttempts: SCIM_AUTH_FAILURES_PER_WINDOW,
    prisma,
    windowMs: SCIM_AUTH_FAILURE_WINDOW_MS
  }),
  recordOutcome: recordSignInMethodOutcome,
  repository: createPrismaScimRepository(prisma),
  resolveScim: async () => (await resolveSignInMethods()).scim ?? null,
  tokens: scimTokenRepository
});

import { getAuthConfig } from "./config";
import { createPrismaAdminRepository } from "./adminRepository";
import { createDispatcherAuthMailer } from "./mailer";
import { createPrismaOAuthIdentityRepository } from "./oauthRepository";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { createPrismaLoginRateLimiter } from "./prismaRateLimit";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { createPrismaAuthSessionStore } from "./prismaSessions";
import { createRequestAuthResolver } from "./requestAuth";
import {
  OAUTH_FLOW_MAX_AGE_SECONDS,
  OAUTH_PROVIDER_ADMISSION_MAX_ATTEMPTS,
  OAUTH_PROVIDER_ADMISSION_WINDOW_MS
} from "./oauthHandlers";
import { prisma } from "../prisma";
import { kickDefaultMcpRuntime } from "../mcp/defaultRuntime";
import { emailDispatcher } from "../email/defaultEmail";
import { kickDefaultMemoryCoordinator } from "../memory/coordinator/defaultCoordinator";
import {
  getDefaultAccountMemoryDeletionHook,
  tryEnsureDefaultMemoryDeletionComposition
} from "../memory/deletionComposition";

tryEnsureDefaultMemoryDeletionComposition(kickDefaultMemoryCoordinator);

export const authMailer = createDispatcherAuthMailer(emailDispatcher);
export const adminRepository = createPrismaAdminRepository(prisma, {
  accountMemoryDeletionHook: getDefaultAccountMemoryDeletionHook
});
export const oauthIdentityRepository = createPrismaOAuthIdentityRepository(prisma);
export const passwordAuthRepository = createPrismaPasswordAuthRepository(prisma);
export const authRegistrationRepository = createPrismaAuthRegistrationRepository(prisma);
export const authSessionStore = createPrismaAuthSessionStore(prisma);
export const authRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  prisma
});
export const oauthCallbackFlowRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 1,
  prisma,
  windowMs: OAUTH_FLOW_MAX_AGE_SECONDS * 1000
});
export const oauthCallbackProviderRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: OAUTH_PROVIDER_ADMISSION_MAX_ATTEMPTS,
  prisma,
  windowMs: OAUTH_PROVIDER_ADMISSION_WINDOW_MS
});

export const resolveRequestAuth = createRequestAuthResolver({
  getConfig: () => getAuthConfig(),
  onAuthenticated: (session) => kickDefaultMcpRuntime(session.userId),
  sessions: authSessionStore
});

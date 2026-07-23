import { getAuthConfig } from "./config";
import { createPrismaAdminRepository } from "./adminRepository";
import { createAuthMailer } from "./mailer";
import { createPrismaOAuthIdentityRepository } from "./oauthRepository";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { createPrismaAuthSessionStore } from "./prismaSessions";
import { createRequestAuthResolver } from "./requestAuth";
import { prisma } from "../prisma";
import { kickDefaultMcpRuntime } from "../mcp/defaultRuntime";

export const authMailer = createAuthMailer(process.env);
export const adminRepository = createPrismaAdminRepository(prisma);
export const oauthIdentityRepository = createPrismaOAuthIdentityRepository(prisma);
export const passwordAuthRepository = createPrismaPasswordAuthRepository(prisma);
export const authRegistrationRepository = createPrismaAuthRegistrationRepository(prisma);
export const authSessionStore = createPrismaAuthSessionStore(prisma);

export const resolveRequestAuth = createRequestAuthResolver({
  getConfig: () => getAuthConfig(),
  onAuthenticated: (session) => kickDefaultMcpRuntime(session.userId),
  sessions: authSessionStore
});

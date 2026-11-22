import { getAuthConfig } from "../../auth/config";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { createPrismaAuthSessionStore } from "../../auth/prismaSessions";
import { createRequestAuthResolver } from "../../auth/requestAuth";
import { prisma } from "../../prisma";
import { createInboundMcpClientMetadataResolver } from "./clientMetadata";
import {
  createInboundMcpAuthorizationHandlers,
  createInboundMcpRegistrationHandler,
  createInboundMcpRevocationHandler,
  createInboundMcpTokenHandler
} from "./handlers";
import { createPrismaInboundMcpOAuthRepository } from "./repository";
import {
  createInboundMcpOAuthService,
  inboundMcpOAuthConfiguration
} from "./service";

const authConfig = getAuthConfig();
const inboundMcpAuthSessionStore = createPrismaAuthSessionStore(prisma);
const resolveInboundMcpRequestAuth = createRequestAuthResolver({
  getConfig: () => getAuthConfig(),
  sessions: inboundMcpAuthSessionStore
});
export const defaultInboundMcpOAuthConfiguration = inboundMcpOAuthConfiguration(
  authConfig.appBaseUrl
);
export const defaultInboundMcpOAuthRepository =
  createPrismaInboundMcpOAuthRepository(prisma);
export const defaultInboundMcpOAuthService = createInboundMcpOAuthService({
  clientMetadataResolver: createInboundMcpClientMetadataResolver({
    allowLoopbackDevelopment:
      defaultInboundMcpOAuthConfiguration.allowLoopbackDevelopment,
    appBaseUrl: authConfig.appBaseUrl
  }),
  configuration: defaultInboundMcpOAuthConfiguration,
  consentSigningSecret: () => getAuthConfig().sessionSecret,
  repository: defaultInboundMcpOAuthRepository
});

function limiter(maxAttempts: number, windowMs: number) {
  return createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    maxAttempts,
    prisma,
    windowMs
  });
}

const authorizationRateLimiter = limiter(30, 15 * 60 * 1_000);
const registrationRateLimiter = limiter(20, 60 * 60 * 1_000);
const tokenRateLimiter = limiter(30, 15 * 60 * 1_000);
const revocationRateLimiter = limiter(30, 15 * 60 * 1_000);

export const defaultInboundMcpAuthorizationHandlers =
  createInboundMcpAuthorizationHandlers({
    getConfig: () => getAuthConfig(),
    rateLimiter: authorizationRateLimiter,
    resolveAuth: resolveInboundMcpRequestAuth,
    service: defaultInboundMcpOAuthService
  });

export const defaultInboundMcpRegistrationHandler =
  createInboundMcpRegistrationHandler({
    getConfig: () => getAuthConfig(),
    rateLimiter: registrationRateLimiter,
    service: defaultInboundMcpOAuthService
  });

export const defaultInboundMcpTokenHandler = createInboundMcpTokenHandler({
  getConfig: () => getAuthConfig(),
  rateLimiter: tokenRateLimiter,
  service: defaultInboundMcpOAuthService
});

export const defaultInboundMcpRevocationHandler = createInboundMcpRevocationHandler({
  getConfig: () => getAuthConfig(),
  rateLimiter: revocationRateLimiter,
  service: defaultInboundMcpOAuthService
});

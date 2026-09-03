import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { defaultMemoryConsumerService } from "../memory/consumer/defaultConsumer";
import { createPrismaMemoryNativeFactSearchService } from
  "../memory/retrieval/nativeFactSearch";
import { prisma } from "../prisma";
import { createMemoryMcpHandler } from "./handler";
import { defaultInboundMcpOAuthService } from "./oauth/default";

const memoryMcpRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 120,
  prisma,
  windowMs: 60 * 1_000
});

export const defaultMemoryMcpHandler = createMemoryMcpHandler({
  getConfig: () => getAuthConfig(),
  oauthService: defaultInboundMcpOAuthService,
  rateLimiter: memoryMcpRateLimiter,
  searchService: createPrismaMemoryNativeFactSearchService(prisma),
  service: defaultMemoryConsumerService
});

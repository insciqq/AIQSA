import { prisma } from "@/lib/server/prisma";
import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { PERSONAL_MCP_RATE_LIMITS, PERSONAL_MCP_RATE_LIMIT_WINDOW_MS } from "./personalRateLimit";

/** One durable limiter for every personal MCP action; each check applies its
 * action's ceiling from `PERSONAL_MCP_RATE_LIMITS` under its own key. */
export const personalMcpRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: Math.max(...Object.values(PERSONAL_MCP_RATE_LIMITS)),
  prisma,
  windowMs: PERSONAL_MCP_RATE_LIMIT_WINDOW_MS
});

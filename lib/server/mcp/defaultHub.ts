import { getDefaultMcpRuntimeCoordinator, defaultMcpRunPlan } from "./defaultRuntime";
import { createMcpHubService } from "./hubService";
import { filterMcpToolsForHub } from "./toolAccess";
import { prisma } from "@/lib/server/prisma";
import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { createMcpHubOperationStore } from "./hubOperations";

const operations = createMcpHubOperationStore(prisma);

export const defaultMcpHubRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 120,
  prisma,
  windowMs: 60_000
});

export const defaultMcpHubService = createMcpHubService({
  callRuntimeTool: (input) => getDefaultMcpRuntimeCoordinator().callTool(input),
  catalog: (userId) => defaultMcpRunPlan.catalog(userId),
  filterTools: filterMcpToolsForHub,
  inspect: (userId, tools) => defaultMcpRunPlan.inspect(userId, tools),
  materialize: (userId, tools, signal) => defaultMcpRunPlan.materialize(userId, tools, signal),
  recordDispatch: operations.recordDispatch
});

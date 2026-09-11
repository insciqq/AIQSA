import { getDefaultMcpRuntimeCoordinator, defaultMcpRunPlan } from "./defaultRuntime";
import { createMcpHubService } from "./hubService";
import { filterMcpToolsForUser } from "./toolAccess";
import { prisma } from "@/lib/server/prisma";
import { getAuthConfig } from "../auth/config";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { createAcceptedStructuredOutputExecutor } from "../providerRuntime/structuredOutputExecutor";
import { createSystemModelRoleResolver } from "../providerRuntime/systemModelRole";
import { createMcpHubOperationStore } from "./hubOperations";
import { createMcpSemanticRouter } from "./router";

const operations = createMcpHubOperationStore(prisma);
const systemModel = createSystemModelRoleResolver(prisma);

export const defaultMcpHubRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 120,
  prisma,
  windowMs: 60_000
});

export const defaultMcpHubService = createMcpHubService({
  callRuntimeTool: (input) => getDefaultMcpRuntimeCoordinator().callTool(input),
  catalog: (userId) => defaultMcpRunPlan.catalog(userId),
  filterTools: filterMcpToolsForUser,
  inspect: (userId, tools) => defaultMcpRunPlan.inspect(userId, tools),
  materialize: (userId, tools, signal) => defaultMcpRunPlan.materialize(userId, tools, signal),
  router: createMcpSemanticRouter({
    executeStructuredOutput: createAcceptedStructuredOutputExecutor(prisma, { disableRequestRetries: true }),
    resolveSystemModel: () => systemModel.resolve()
  }),
  recordDispatch: operations.recordDispatch,
  recordDiscoveryAttempt: operations.recordDiscoveryAttempt
});

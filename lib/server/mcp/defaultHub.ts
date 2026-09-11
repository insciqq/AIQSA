import { getDefaultMcpRuntimeCoordinator, defaultMcpRunPlan } from "./defaultRuntime";
import { createMcpHubService } from "./hubService";
import { filterMcpToolsForUser } from "./toolAccess";

export const defaultMcpHubService = createMcpHubService({
  callRuntimeTool: (input) => getDefaultMcpRuntimeCoordinator().callTool(input),
  catalog: (userId) => defaultMcpRunPlan.catalog(userId),
  filterTools: filterMcpToolsForUser,
  materialize: (userId, tools) => defaultMcpRunPlan.materialize(userId, tools),
  router: defaultMcpRunPlan.router
});

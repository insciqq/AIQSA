import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import { mcpCatalogToolsByNames } from "./discovery";
import { McpSemanticRouterError, type McpRouterUsageAttribution, type McpSemanticRouter } from "./router";
import type { McpCapabilityCatalog, McpRunPlanResult } from "./runPlan";
import type { McpToolAccessFilter } from "./toolAccess";
import { filterMcpCatalog } from "./toolAccessProjection";

export type McpDiscoverySelection = ReturnType<typeof mcpCatalogToolsByNames>;
type ReadyPlan = Extract<McpRunPlanResult, { ok: true }>;
type Materialize = (userId: string, tools: readonly Readonly<{
  namespacedName: string; revisionId: string; serverId: string;
}>[], signal?: AbortSignal) => Promise<McpRunPlanResult>;

export class McpDiscoveryError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "McpDiscoveryError";
  }
}

/** Exact schemas and runtime bindings must come from the selected authorized definitions. */
export async function materializeMcpSelection(input: Readonly<{
  materialize: Materialize;
  selected: McpDiscoverySelection;
  signal?: AbortSignal;
  userId: string;
}>): Promise<ReadyPlan> {
  let result: McpRunPlanResult;
  try {
    input.signal?.throwIfAborted();
    result = await input.materialize(input.userId, input.selected.map(({ namespacedName, revisionId, serverId }) =>
      ({ namespacedName, revisionId, serverId })), input.signal);
    input.signal?.throwIfAborted();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new McpDiscoveryError("mcp_materialization_failed", { cause: error });
  }
  if (!result.ok) throw new McpDiscoveryError(`mcp_materialization_${result.code}`);
  const actual = result.snapshot.tools;
  if (actual.length !== input.selected.length || new Set(actual.map((tool) => tool.namespacedName)).size !== actual.length ||
    !input.selected.every((selected) => actual.some((tool) => tool.namespacedName === selected.namespacedName &&
      tool.serverId === selected.serverId)) ||
    actual.some((tool) => !result.bindings.some((binding) => binding.serverId === tool.serverId &&
      result.snapshot.servers.some((server) => server.serverId === tool.serverId && server.fingerprint === binding.fingerprint)))) {
    throw new McpDiscoveryError("mcp_materialization_mismatch");
  }
  return result;
}

/** Shared discovery has no Chat, ModelRun or provider-request dependency. */
export async function discoverMcpTools(input: Readonly<{
  assertActive?(): Promise<void>;
  catalog: McpCapabilityCatalog;
  filterTools: McpToolAccessFilter;
  materialize: Materialize;
  onUsage?(usage: McpRouterUsageAttribution): void;
  partial?: boolean;
  router?: McpSemanticRouter;
  routing: Omit<Parameters<McpSemanticRouter["route"]>[0], "catalog">;
  userId: string;
}>): Promise<Readonly<{ plans: ReadyPlan[]; selected: McpDiscoverySelection }>> {
  const { signal, activeToolNames, limit } = input.routing;
  const assertActive = async () => {
    signal?.throwIfAborted();
    await input.assertActive?.();
    signal?.throwIfAborted();
  };
  await assertActive();
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MCP_RUN_PLAN_LIMITS.maxTools) {
    throw new McpDiscoveryError("mcp_discovery_limit_invalid");
  }
  const catalog = await filterMcpCatalog(input.userId, input.catalog, input.filterTools);
  await assertActive();
  if (limit === 0 || catalog.servers.every((server) => server.tools.every((tool) => activeToolNames.has(tool.namespacedName)))) {
    return { plans: [], selected: [] };
  }
  if (!input.router) throw new McpDiscoveryError("mcp_router_unavailable");
  let routed: Awaited<ReturnType<McpSemanticRouter["route"]>>;
  try {
    routed = await input.router.route({ ...input.routing, catalog });
  } catch (error) {
    if (error instanceof McpSemanticRouterError && error.usageAttribution) input.onUsage?.(error.usageAttribution);
    if (signal?.aborted) throw error;
    throw new McpDiscoveryError(error instanceof McpSemanticRouterError ? error.code : "mcp_router_request_failed", { cause: error });
  }
  if (routed.usageAttribution) input.onUsage?.(routed.usageAttribution);
  await assertActive();
  const selected = mcpCatalogToolsByNames(catalog, routed.toolNames)
    .filter((tool) => !activeToolNames.has(tool.namespacedName));
  if (routed.toolNames.length > limit || new Set(routed.toolNames).size !== routed.toolNames.length ||
    selected.length !== routed.toolNames.length) throw new McpDiscoveryError("mcp_router_output_invalid");
  const batches = input.partial ? selected.map((tool) => [tool]) : selected.length ? [selected] : [];
  const settled = await Promise.allSettled(batches.map(async (batch) => {
    await assertActive();
    return materializeMcpSelection({ materialize: input.materialize, selected: batch, signal, userId: input.userId });
  }));
  await assertActive();
  const failed = settled.find((result) => result.status === "rejected");
  if (!input.partial && failed?.status === "rejected") throw failed.reason;
  return { plans: settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []), selected };
}

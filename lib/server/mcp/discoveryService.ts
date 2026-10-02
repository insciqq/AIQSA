import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import { mcpCatalogToolsByNames } from "./discovery";
import { logEvent } from "../observability";
import { searchMcpCatalog, type McpToolSearchResult } from "./toolSearch";
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

/** Shared discovery has no Chat, ModelRun or provider-request dependency.
 * The search is local and deterministic; only materialization performs I/O. */
export async function discoverMcpTools(input: Readonly<{
  assertActive?(): Promise<void>;
  catalog: McpCapabilityCatalog;
  filterTools: McpToolAccessFilter;
  materialize: Materialize;
  partial?: boolean;
  search: Readonly<{
    activeToolNames: ReadonlySet<string>;
    limit: number;
    query: string;
    signal?: AbortSignal;
  }>;
  userId: string;
}>): Promise<Readonly<{
  alreadyActive: McpDiscoverySelection;
  plans: ReadyPlan[];
  search: McpToolSearchResult;
  selected: McpDiscoverySelection;
}>> {
  const { signal, activeToolNames, limit, query } = input.search;
  const started = Date.now();
  let search: McpToolSearchResult | undefined;
  let alreadyActive: McpDiscoverySelection = [];
  let loaded = 0;
  const observe = (outcome: "completed" | "failed" | "cancelled") => logEvent("mcp_discovery", {
    outcome, duration_ms: Date.now() - started,
    ...(search ? { mode: search.mode, candidate_count: search.candidateCount, result_count: search.matches.length,
      unknown_name_count: search.unknownNames.length } : {}),
    loaded_count: loaded, already_loaded_count: alreadyActive.length
  });
  const assertActive = async () => {
    signal?.throwIfAborted();
    await input.assertActive?.();
    signal?.throwIfAborted();
  };
  try {
    await assertActive();
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MCP_RUN_PLAN_LIMITS.maxTools) {
      throw new McpDiscoveryError("mcp_discovery_limit_invalid");
    }
    const catalog = await filterMcpCatalog(input.userId, input.catalog, input.filterTools);
    await assertActive();
    const allowed = new Set(catalog.servers.flatMap((server) => server.tools.map((tool) => tool.namespacedName)));
    // The frozen catalog object keys the cached index; current access only narrows candidates.
    search = searchMcpCatalog(input.catalog, { query, limit, eligible: (name) => allowed.has(name) });
    const ranked = mcpCatalogToolsByNames(catalog, search.matches.map((match) => match.namespacedName));
    alreadyActive = ranked.filter((tool) => activeToolNames.has(tool.namespacedName));
    const capacity = Math.max(0, MCP_RUN_PLAN_LIMITS.maxTools - activeToolNames.size);
    const selected = ranked.filter((tool) => !activeToolNames.has(tool.namespacedName)).slice(0, capacity);
    const batches = input.partial ? selected.map((tool) => [tool]) : selected.length ? [selected] : [];
    const settled = await Promise.allSettled(batches.map(async (batch) => {
      await assertActive();
      return materializeMcpSelection({ materialize: input.materialize, selected: batch, signal, userId: input.userId });
    }));
    await assertActive();
    const failed = settled.find((result) => result.status === "rejected");
    if (!input.partial && failed?.status === "rejected") throw failed.reason;
    const plans = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    loaded = plans.reduce((total, plan) => total + plan.snapshot.tools.length, 0);
    observe("completed");
    return { alreadyActive, plans, search, selected };
  } catch (error) {
    observe(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}

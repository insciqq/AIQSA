import type { McpToolAccessFilter } from "./toolAccess";
import { discoverMcpTools, McpDiscoveryError } from "./discoveryService";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import {
  mcpAutoDiscoveryFailure
} from "../../contracts/runs";
import {
  LEGACY_MCP_DISCOVERY_MAX_RESULTS,
  mcpCatalogToolsByNames,
  mcpFindToolsArguments,
  mcpFindToolsExecutionResult,
  type McpFindToolsUnavailableServer
} from "./discovery";
import type {
  McpDiscoveryState,
  McpDiscoveryUnavailableServer,
  McpRunPlanBinding,
  McpRunPlanResult,
  McpRunPlanSnapshot
} from "./runPlan";

export class McpAutoDiscoveryUnavailableError extends Error {
  readonly code: string;

  constructor(readonly internalReason: string, serverName?: string | null) {
    const failure = mcpAutoDiscoveryFailure(internalReason, { serverName });
    super(failure.message);
    this.code = failure.code;
    this.name = "McpAutoDiscoveryUnavailableError";
  }
}

type AppendMcpDiscoveryEpoch = (input: Readonly<{
  bindings: readonly McpRunPlanBinding[];
  goal: string;
  modelRunToolCallId: string;
  roundIndex: number;
  runId: string;
  snapshot: McpRunPlanSnapshot;
  toolIds: readonly string[];
  /** Servers whose matched tools the call could not load, in rank order; omitted when none. */
  unavailable?: readonly McpDiscoveryUnavailableServer[];
  userId: string;
}>) => Promise<Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
}> | null>;

const emptySnapshot = (): McpRunPlanSnapshot => ({ servers: [], tools: [], version: 1 });

type CatalogSelection = ReturnType<typeof mcpCatalogToolsByNames>;

/** An epoch lists loaded and already-active matches in rank order, and the
 * servers it could not load. Without the pre-call snapshot (replay), a tool an
 * earlier epoch listed counts as already available. */
function checkpointResult(input: Readonly<{
  discovery: McpDiscoveryState;
  modelRunToolCallId: string;
  previouslyActive?: ReadonlySet<string>;
  snapshot: McpRunPlanSnapshot;
}>): Readonly<{
  loaded: CatalogSelection;
  alreadyAvailable: CatalogSelection;
  unavailable: McpFindToolsUnavailableServer[];
}> {
  const index = input.discovery.epochs.findIndex((candidate) =>
    candidate.modelRunToolCallId === input.modelRunToolCallId
  );
  const epoch = input.discovery.epochs[index];
  if (!epoch) throw new Error("mcp_discovery_checkpoint_conflict");
  const activeNames = new Set(input.snapshot.tools.map((tool) => tool.namespacedName));
  const tools = mcpCatalogToolsByNames(input.discovery.catalog, epoch.toolIds)
    .filter((tool) => activeNames.has(tool.namespacedName));
  if (tools.length !== epoch.toolIds.length) {
    throw new Error("mcp_discovery_checkpoint_conflict");
  }
  const earlier = input.previouslyActive ??
    new Set(input.discovery.epochs.slice(0, index).flatMap((candidate) => candidate.toolIds));
  const serverNames = new Map(input.discovery.catalog.servers.map((server) => [server.serverId, server.serverName]));
  const unavailable = (epoch.unavailable ?? []).map((server) => {
    const serverName = serverNames.get(server.serverId);
    if (serverName === undefined) throw new Error("mcp_discovery_checkpoint_conflict");
    return { reason: server.reason, serverName };
  });
  return {
    loaded: tools.filter((tool) => !earlier.has(tool.namespacedName)),
    alreadyAvailable: tools.filter((tool) => earlier.has(tool.namespacedName)),
    unavailable
  };
}

type ExecuteDurableMcpDiscoveryInput = Readonly<{
  filterTools: McpToolAccessFilter;
  activeDiscovery: McpDiscoveryState;
  activeSnapshot?: McpRunPlanSnapshot;
  appendEpoch: AppendMcpDiscoveryEpoch;
  call: ModelToolCall;
  materialize(
    userId: string,
    tools: readonly Readonly<{
      namespacedName: string;
      revisionId: string;
      serverId: string;
    }>[]
  ): Promise<McpRunPlanResult>;
  maxResults?: number;
  modelRunToolCallId: string;
  roundIndex: number;
  runId: string;
  signal?: AbortSignal;
  userId: string;
}>;

type DurableMcpDiscoveryResult = Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
  toolResult: ToolExecutionResult;
}>;

/** A settled epoch replays without searching or materializing, unavailable
 * servers included; a pending call repeats the deterministic search against
 * the run's frozen catalog. Each selected server loads on its own: one that
 * cannot run is checkpointed unavailable with its reason while the others'
 * tools load, so the call still returns an ordinary result. */
export async function executeDurableMcpDiscovery(
  input: ExecuteDurableMcpDiscoveryInput
): Promise<DurableMcpDiscoveryResult> {
  const parsed = mcpFindToolsArguments(input.call.arguments);
  if (!parsed) throw new Error("mcp_discovery_arguments_invalid");
  const maxResults = input.maxResults ?? LEGACY_MCP_DISCOVERY_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 ||
    maxResults > MCP_RUN_PLAN_LIMITS.maxTools) {
    throw new Error("mcp_discovery_limit_invalid");
  }
  const currentSnapshot = input.activeSnapshot ?? emptySnapshot();
  const replay = input.activeDiscovery.epochs.find((epoch) =>
    epoch.modelRunToolCallId === input.modelRunToolCallId
  );
  const resultFrom = async (discovery: McpDiscoveryState, snapshot: McpRunPlanSnapshot,
    fresh?: Readonly<{ previouslyActive: ReadonlySet<string>; unknownNames: readonly string[] }>) => {
    const checkpoint = checkpointResult({ discovery, modelRunToolCallId: input.modelRunToolCallId, snapshot,
      ...(fresh ? { previouslyActive: fresh.previouslyActive } : {}) });
    return mcpFindToolsExecutionResult(input.call, {
      loaded: await input.filterTools(input.userId, checkpoint.loaded),
      alreadyAvailable: await input.filterTools(input.userId, checkpoint.alreadyAvailable),
      unknownNames: fresh?.unknownNames ?? [],
      unavailable: checkpoint.unavailable
    });
  };
  if (replay) {
    if (replay.goal !== parsed.query || replay.roundIndex !== input.roundIndex) {
      throw new Error("mcp_discovery_checkpoint_conflict");
    }
    return {
      discovery: input.activeDiscovery,
      snapshot: currentSnapshot,
      toolResult: await resultFrom(input.activeDiscovery, currentSnapshot)
    };
  }

  const activeNames = new Set(currentSnapshot.tools.map((tool) => tool.namespacedName));
  let discovered: Awaited<ReturnType<typeof discoverMcpTools>>;
  try {
    discovered = await discoverMcpTools({
      catalog: input.activeDiscovery.catalog,
      filterTools: input.filterTools,
      materialize: input.materialize,
      partial: "server",
      search: {
        activeToolNames: activeNames,
        limit: maxResults,
        query: parsed.query,
        signal: input.signal
      },
      snapshot: currentSnapshot,
      userId: input.userId
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw error instanceof McpDiscoveryError
      ? new McpAutoDiscoveryUnavailableError(error.code, error.serverName)
      : new McpAutoDiscoveryUnavailableError("mcp_materialization_failed");
  }
  const { alreadyActive, plans, search, unavailable } = discovered;
  // One plan per loaded server, already fitted onto the run's snapshot in rank order.
  const addedSnapshot: McpRunPlanSnapshot = {
    servers: plans.flatMap((plan) => plan.snapshot.servers),
    tools: plans.flatMap((plan) => plan.snapshot.tools),
    version: 1
  };
  const bindings = plans.flatMap((plan) => plan.bindings);
  const accepted = new Set([...addedSnapshot.tools, ...alreadyActive].map((tool) => tool.namespacedName));

  const appended = await input.appendEpoch({
    bindings,
    // The persisted epoch field keeps its historical name; it stores the query.
    goal: parsed.query,
    modelRunToolCallId: input.modelRunToolCallId,
    roundIndex: input.roundIndex,
    runId: input.runId,
    snapshot: addedSnapshot,
    toolIds: search.matches.map((match) => match.namespacedName).filter((name) => accepted.has(name)),
    ...(unavailable.length ? { unavailable } : {}),
    userId: input.userId
  });
  if (!appended) throw new Error("mcp_discovery_checkpoint_conflict");
  return {
    discovery: appended.discovery,
    snapshot: appended.snapshot,
    toolResult: await resultFrom(appended.discovery, appended.snapshot,
      { previouslyActive: activeNames, unknownNames: search.unknownNames })
  };
}

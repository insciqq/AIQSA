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
  mcpFindToolsExecutionResult
} from "./discovery";
import type {
  McpDiscoveryState,
  McpRunPlanBinding,
  McpRunPlanResult,
  McpRunPlanSnapshot
} from "./runPlan";

export class McpAutoDiscoveryUnavailableError extends Error {
  readonly code: string;

  constructor(readonly internalReason: string) {
    const failure = mcpAutoDiscoveryFailure(internalReason);
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
  userId: string;
}>) => Promise<Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
}> | null>;

const emptySnapshot = (): McpRunPlanSnapshot => ({ servers: [], tools: [], version: 1 });

type CatalogSelection = ReturnType<typeof mcpCatalogToolsByNames>;

/** An epoch lists loaded and already-active matches in rank order. Without
 * the pre-call snapshot (replay), a tool an earlier epoch listed counts as
 * already available. */
function checkpointResult(input: Readonly<{
  discovery: McpDiscoveryState;
  modelRunToolCallId: string;
  previouslyActive?: ReadonlySet<string>;
  snapshot: McpRunPlanSnapshot;
}>): Readonly<{ loaded: CatalogSelection; alreadyAvailable: CatalogSelection }> {
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
  return {
    loaded: tools.filter((tool) => !earlier.has(tool.namespacedName)),
    alreadyAvailable: tools.filter((tool) => earlier.has(tool.namespacedName))
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

/** A settled epoch replays without searching; a pending call repeats the
 * deterministic search against the run's frozen catalog. */
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
      unknownNames: fresh?.unknownNames ?? []
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
      search: {
        activeToolNames: activeNames,
        limit: maxResults,
        query: parsed.query,
        signal: input.signal
      },
      userId: input.userId
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new McpAutoDiscoveryUnavailableError(error instanceof McpDiscoveryError ? error.code : "mcp_materialization_failed");
  }
  const { selected, alreadyActive, plans, search } = discovered;
  const addedSnapshot = plans[0]?.snapshot ?? emptySnapshot();
  const bindings = plans[0]?.bindings ?? [];
  const accepted = new Set([...selected, ...alreadyActive].map((tool) => tool.namespacedName));

  const appended = await input.appendEpoch({
    bindings,
    // The persisted epoch field keeps its historical name; it stores the query.
    goal: parsed.query,
    modelRunToolCallId: input.modelRunToolCallId,
    roundIndex: input.roundIndex,
    runId: input.runId,
    snapshot: addedSnapshot,
    toolIds: search.matches.map((match) => match.namespacedName).filter((name) => accepted.has(name)),
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

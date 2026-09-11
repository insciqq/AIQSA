import type { ProviderRunRequest } from "../providers/types";
import type { McpToolAccessFilter } from "./toolAccess";
import { mcpChatDiscoveryContext } from "./chatDiscoveryContext";
import { discoverMcpTools, McpDiscoveryError } from "./discoveryService";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
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
import {
  type McpRouterUsageAttribution,
  type McpSemanticRouter
} from "./router";
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

function selectedToolsFromCheckpoint(input: Readonly<{
  discovery: McpDiscoveryState;
  modelRunToolCallId: string;
  snapshot: McpRunPlanSnapshot;
}>): ReturnType<typeof mcpCatalogToolsByNames> {
  const epoch = input.discovery.epochs.find((candidate) =>
    candidate.modelRunToolCallId === input.modelRunToolCallId
  );
  if (!epoch) throw new Error("mcp_discovery_checkpoint_conflict");
  const activeNames = new Set(input.snapshot.tools.map((tool) => tool.namespacedName));
  const tools = mcpCatalogToolsByNames(input.discovery.catalog, epoch.toolIds)
    .filter((tool) => activeNames.has(tool.namespacedName));
  if (tools.length !== epoch.toolIds.length) {
    throw new Error("mcp_discovery_checkpoint_conflict");
  }
  return tools;
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
  maxOutputTokens?: number | null;
  modelRunToolCallId: string;
  onUsage?(attribution: McpRouterUsageAttribution): void;
  request: Pick<ProviderRunRequest, "content" | "context">;
  routingGoals?: readonly string[];
  roundIndex: number;
  router?: McpSemanticRouter;
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  userId: string;
}>;

type DurableMcpDiscoveryResult = Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
  toolResult: ToolExecutionResult;
}>;

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
  if (replay) {
    if (replay.goal !== parsed.goal || replay.roundIndex !== input.roundIndex) {
      throw new Error("mcp_discovery_checkpoint_conflict");
    }
    return {
      discovery: input.activeDiscovery,
      snapshot: currentSnapshot,
      toolResult: mcpFindToolsExecutionResult(input.call, await input.filterTools(input.userId, selectedToolsFromCheckpoint({
        discovery: input.activeDiscovery,
        modelRunToolCallId: input.modelRunToolCallId,
        snapshot: currentSnapshot
      })))
    };
  }

  const activeNames = new Set(currentSnapshot.tools.map((tool) => tool.namespacedName));
  let discovered: Awaited<ReturnType<typeof discoverMcpTools>>;
  try {
    discovered = await discoverMcpTools({
      catalog: input.activeDiscovery.catalog,
      filterTools: input.filterTools,
      materialize: input.materialize,
      onUsage: input.onUsage,
      router: input.router,
      routing: {
        activeToolNames: activeNames,
        context: mcpChatDiscoveryContext(input.request),
        goals: input.routingGoals ?? [parsed.goal],
        limit: Math.min(maxResults, Math.max(0, MCP_RUN_PLAN_LIMITS.maxTools - activeNames.size)),
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
        timeoutMs: input.timeoutMs
      },
      userId: input.userId
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new McpAutoDiscoveryUnavailableError(error instanceof McpDiscoveryError ? error.code : "mcp_materialization_failed");
  }
  const { selected, plans } = discovered;
  const addedSnapshot = plans[0]?.snapshot ?? emptySnapshot();
  const bindings = plans[0]?.bindings ?? [];

  const appended = await input.appendEpoch({
    bindings,
    goal: parsed.goal,
    modelRunToolCallId: input.modelRunToolCallId,
    roundIndex: input.roundIndex,
    runId: input.runId,
    snapshot: addedSnapshot,
    toolIds: selected.map((tool) => tool.namespacedName),
    userId: input.userId
  });
  if (!appended) throw new Error("mcp_discovery_checkpoint_conflict");
  return {
    discovery: appended.discovery,
    snapshot: appended.snapshot,
    toolResult: mcpFindToolsExecutionResult(input.call, await input.filterTools(input.userId, selectedToolsFromCheckpoint({
      discovery: appended.discovery,
      modelRunToolCallId: input.modelRunToolCallId,
      snapshot: appended.snapshot
    })))
  };
}

export async function executeDurableMcpDiscoveryBatch(
  input: Omit<ExecuteDurableMcpDiscoveryInput, "call" | "modelRunToolCallId" | "routingGoals"> &
    Readonly<{
      calls: readonly Readonly<{
        call: ModelToolCall;
        modelRunToolCallId: string;
      }>[];
    }>
): Promise<Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
  toolResults: ReadonlyMap<string, ToolExecutionResult>;
}>> {
  if (input.calls.length === 0 || input.calls.length > toolLoopPersistenceLimits.batchCalls) {
    throw new Error("mcp_discovery_arguments_invalid");
  }
  const parsed = input.calls.map(({ call }) => mcpFindToolsArguments(call.arguments));
  if (parsed.some((goal) => goal === null)) {
    throw new Error("mcp_discovery_arguments_invalid");
  }
  const routingGoals = [...new Set(parsed.map((goal) => goal!.goal))];
  const [leader, ...followers] = input.calls;
  const executed = await executeDurableMcpDiscovery({
    ...input,
    call: leader!.call,
    modelRunToolCallId: leader!.modelRunToolCallId,
    routingGoals
  });
  let discovery = executed.discovery;
  let snapshot = executed.snapshot;
  const leaderEpoch = discovery.epochs.find((epoch) =>
    epoch.modelRunToolCallId === leader!.modelRunToolCallId
  );
  if (!leaderEpoch) throw new Error("mcp_discovery_checkpoint_conflict");
  const toolResults = new Map<string, ToolExecutionResult>([
    [leader!.call.id, executed.toolResult]
  ]);

  for (const follower of followers) {
    const goal = mcpFindToolsArguments(follower.call.arguments);
    if (!goal) throw new Error("mcp_discovery_arguments_invalid");
    let epoch = discovery.epochs.find((candidate) =>
      candidate.modelRunToolCallId === follower.modelRunToolCallId
    );
    if (epoch) {
      if (epoch.goal !== goal.goal || epoch.roundIndex !== input.roundIndex) {
        throw new Error("mcp_discovery_checkpoint_conflict");
      }
    } else {
      const appended = await input.appendEpoch({
        bindings: [],
        goal: goal.goal,
        modelRunToolCallId: follower.modelRunToolCallId,
        roundIndex: input.roundIndex,
        runId: input.runId,
        snapshot: emptySnapshot(),
        toolIds: leaderEpoch.toolIds,
        userId: input.userId
      });
      if (!appended) throw new Error("mcp_discovery_checkpoint_conflict");
      discovery = appended.discovery;
      snapshot = appended.snapshot;
      epoch = discovery.epochs.find((candidate) =>
        candidate.modelRunToolCallId === follower.modelRunToolCallId
      );
      if (!epoch) throw new Error("mcp_discovery_checkpoint_conflict");
    }
    toolResults.set(follower.call.id, mcpFindToolsExecutionResult(
      follower.call,
      await input.filterTools(input.userId, selectedToolsFromCheckpoint({
        discovery,
        modelRunToolCallId: follower.modelRunToolCallId,
        snapshot
      }))
    ));
  }

  return { discovery, snapshot, toolResults };
}

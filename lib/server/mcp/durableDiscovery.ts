import type { ProviderRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import {
  MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} from "../../contracts/runs";
import {
  LEGACY_MCP_DISCOVERY_MAX_RESULTS,
  mcpCatalogToolsByNames,
  mcpFindToolsArguments,
  mcpFindToolsExecutionResult
} from "./discovery";
import {
  McpSemanticRouterError,
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
  readonly code = MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE;

  constructor(readonly internalReason: string) {
    super(MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE);
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

function materializedSelectionMatches(
  result: Extract<McpRunPlanResult, { ok: true }>,
  selectedNames: readonly string[]
): boolean {
  const actual = result.snapshot.tools.map((tool) => tool.namespacedName);
  const expected = new Set(selectedNames);
  return actual.length === selectedNames.length &&
    new Set(actual).size === actual.length &&
    actual.every((name) => expected.has(name));
}

type ExecuteDurableMcpDiscoveryInput = Readonly<{
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
  onUsage?(attribution: McpRouterUsageAttribution): void;
  request: Pick<ProviderRunRequest, "content" | "context">;
  routingGoal?: string;
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
      toolResult: mcpFindToolsExecutionResult(input.call, selectedToolsFromCheckpoint({
        discovery: input.activeDiscovery,
        modelRunToolCallId: input.modelRunToolCallId,
        snapshot: currentSnapshot
      }))
    };
  }

  const activeNames = new Set(currentSnapshot.tools.map((tool) => tool.namespacedName));
  const routeLimit = Math.min(
    maxResults,
    Math.max(0, MCP_RUN_PLAN_LIMITS.maxTools - activeNames.size)
  );
  if (!input.router) {
    throw new McpAutoDiscoveryUnavailableError("mcp_router_unavailable");
  }
  let routed: Awaited<ReturnType<McpSemanticRouter["route"]>>;
  try {
    routed = await input.router.route({
      activeToolNames: activeNames,
      catalog: input.activeDiscovery.catalog,
      goal: input.routingGoal ?? parsed.goal,
      limit: routeLimit,
      request: input.request,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new McpAutoDiscoveryUnavailableError(
      error instanceof McpSemanticRouterError ? error.code : "mcp_router_request_failed"
    );
  }
  if (routed.usageAttribution) input.onUsage?.(routed.usageAttribution);
  if (routed.toolNames.length > routeLimit ||
    new Set(routed.toolNames).size !== routed.toolNames.length) {
    throw new McpAutoDiscoveryUnavailableError("mcp_router_output_invalid");
  }

  const selected = mcpCatalogToolsByNames(
    input.activeDiscovery.catalog,
    routed.toolNames
  ).filter((tool) => !activeNames.has(tool.namespacedName));
  if (selected.length !== routed.toolNames.length) {
    throw new McpAutoDiscoveryUnavailableError("mcp_router_output_invalid");
  }

  let addedSnapshot = emptySnapshot();
  let bindings: readonly McpRunPlanBinding[] = [];
  if (selected.length > 0) {
    let plan: McpRunPlanResult;
    try {
      plan = await input.materialize(
        input.userId,
        selected.map((tool) => ({
          namespacedName: tool.namespacedName,
          revisionId: tool.revisionId,
          serverId: tool.serverId
        }))
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new McpAutoDiscoveryUnavailableError("mcp_materialization_failed");
    }
    if (!plan.ok) {
      throw new McpAutoDiscoveryUnavailableError(`mcp_materialization_${plan.code}`);
    }
    if (!materializedSelectionMatches(plan, routed.toolNames)) {
      throw new McpAutoDiscoveryUnavailableError("mcp_materialization_mismatch");
    }
    addedSnapshot = plan.snapshot;
    bindings = plan.bindings;
  }

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
    toolResult: mcpFindToolsExecutionResult(input.call, selectedToolsFromCheckpoint({
      discovery: appended.discovery,
      modelRunToolCallId: input.modelRunToolCallId,
      snapshot: appended.snapshot
    }))
  };
}

export async function executeDurableMcpDiscoveryBatch(
  input: Omit<ExecuteDurableMcpDiscoveryInput, "call" | "modelRunToolCallId" | "routingGoal"> &
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
  if (input.calls.length === 0) throw new Error("mcp_discovery_arguments_invalid");
  const parsed = input.calls.map(({ call }) => mcpFindToolsArguments(call.arguments));
  if (parsed.some((goal) => goal === null)) {
    throw new Error("mcp_discovery_arguments_invalid");
  }
  const routingGoal = [...new Set(parsed.map((goal) => goal!.goal))]
    .map((goal, index) => `${index + 1}. ${goal}`)
    .join("\n")
    .slice(0, 400);
  const [leader, ...followers] = input.calls;
  const executed = await executeDurableMcpDiscovery({
    ...input,
    call: leader!.call,
    modelRunToolCallId: leader!.modelRunToolCallId,
    routingGoal
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
      selectedToolsFromCheckpoint({
        discovery,
        modelRunToolCallId: follower.modelRunToolCallId,
        snapshot
      })
    ));
  }

  return { discovery, snapshot, toolResults };
}

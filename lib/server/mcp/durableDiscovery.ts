import type { ProviderRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import {
  MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} from "../../contracts/runs";
import {
  MCP_DISCOVERY_MAX_RESULTS,
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

export async function executeDurableMcpDiscovery(input: Readonly<{
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
  modelRunToolCallId: string;
  onUsage?(attribution: McpRouterUsageAttribution): void;
  request: Pick<ProviderRunRequest, "content" | "context">;
  roundIndex: number;
  router?: McpSemanticRouter;
  runId: string;
  signal?: AbortSignal;
  userId: string;
}>): Promise<Readonly<{
  discovery: McpDiscoveryState;
  snapshot: McpRunPlanSnapshot;
  toolResult: ToolExecutionResult;
}>> {
  const parsed = mcpFindToolsArguments(input.call.arguments);
  if (!parsed) throw new Error("mcp_discovery_arguments_invalid");
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
  if (!input.router) {
    throw new McpAutoDiscoveryUnavailableError("mcp_router_unavailable");
  }
  let routed: Awaited<ReturnType<McpSemanticRouter["route"]>>;
  try {
    routed = await input.router.route({
      activeToolNames: activeNames,
      catalog: input.activeDiscovery.catalog,
      goal: parsed.goal,
      limit: MCP_DISCOVERY_MAX_RESULTS,
      request: input.request,
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new McpAutoDiscoveryUnavailableError(
      error instanceof McpSemanticRouterError ? error.code : "mcp_router_request_failed"
    );
  }
  if (routed.usageAttribution) input.onUsage?.(routed.usageAttribution);
  if (routed.toolNames.length > MCP_DISCOVERY_MAX_RESULTS ||
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
    const plan = await input.materialize(
      input.userId,
      selected.map((tool) => ({
        namespacedName: tool.namespacedName,
        revisionId: tool.revisionId,
        serverId: tool.serverId
      }))
    );
    if (!plan.ok) throw new Error(plan.code);
    if (!materializedSelectionMatches(plan, routed.toolNames)) {
      throw new Error("mcp_discovery_materialization_mismatch");
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

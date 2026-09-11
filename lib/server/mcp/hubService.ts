import type {
  McpHubDiscoveryResult,
  McpHubToolDescriptor
} from "@/lib/contracts/mcpHub";
import { MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { canonicalMcpJson, hashCanonicalMcpValue } from "./definitions";
import {
  LEGACY_MCP_DISCOVERY_MAX_RESULTS,
  mcpCatalogToolsByNames,
  mcpFindToolsArguments
} from "./discovery";
import { filterMcpCatalog } from "./toolAccessProjection";
import type { McpToolAccessFilter } from "./toolAccess";
import { McpClientSessionError, validateMcpToolArguments, type AiqsaMcpToolCallResult } from "./clientSession";
import { resolveMcpRunTool } from "./toolExecutor";
import {
  McpSemanticRouterError,
  type McpSemanticRouter,
  type McpRouterUsageAttribution
} from "./router";
import type {
  McpCapabilityCatalog,
  McpRunPlanResult,
  McpRunPlanSnapshot
} from "./runPlan";

export type McpHubServiceErrorCode =
  | "discovery_unavailable"
  | "execution_outcome_unknown"
  | "invalid_arguments"
  | "request_cancelled"
  | "result_unsupported"
  | "tool_definition_changed"
  | "tool_unavailable"
  | "upstream_unavailable";

export class McpHubServiceError extends Error {
  constructor(readonly code: McpHubServiceErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "McpHubServiceError";
  }
}

export type McpHubPreparedToolCall = Readonly<{
  arguments: Readonly<Record<string, unknown>>;
  descriptor: McpHubToolDescriptor;
  serverId: string;
}>;

type SelectedCatalogTool = ReturnType<typeof mcpCatalogToolsByNames>[number];

export type McpHubServiceDependencies = Readonly<{
  callRuntimeTool(input: Readonly<{
    arguments: Record<string, unknown>;
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }>): Promise<AiqsaMcpToolCallResult>;
  catalog(userId: string): Promise<McpCapabilityCatalog>;
  filterTools: McpToolAccessFilter;
  materialize(
    userId: string,
    tools: readonly Readonly<{
      namespacedName: string;
      revisionId: string;
      serverId: string;
    }>[]
  ): Promise<McpRunPlanResult>;
  router: McpSemanticRouter;
}>;

type MaterializedTool = Readonly<{
  descriptor: McpHubToolDescriptor;
  generationId: string;
  snapshot: McpRunPlanSnapshot;
}>;

const MAX_HUB_CONTEXT_CHARACTERS = 8_000;

function toolVersion(snapshot: McpRunPlanSnapshot, toolId: string): string {
  const route = resolveMcpRunTool(snapshot, toolId);
  if (!route) throw new McpHubServiceError("tool_unavailable");
  return hashCanonicalMcpValue({
    definitionHash: route.tool.definitionHash,
    effectiveConfiguration: route.fingerprint,
    toolId
  });
}

function descriptorFor(
  selection: SelectedCatalogTool,
  snapshot: McpRunPlanSnapshot
): McpHubToolDescriptor {
  const route = resolveMcpRunTool(snapshot, selection.namespacedName);
  if (!route || route.serverId !== selection.serverId) {
    throw new McpHubServiceError("tool_unavailable");
  }
  return {
    ...(route.tool.annotations ? { annotations: route.tool.annotations } : {}),
    description: route.tool.description,
    input_schema: route.tool.inputSchema as McpHubToolDescriptor["input_schema"],
    name: route.tool.originalName,
    ...(route.tool.outputSchema ? { output_schema: route.tool.outputSchema as McpHubToolDescriptor["input_schema"] } : {}),
    server_name: route.tool.serverName,
    ...(route.tool.title ? { title: route.tool.title } : {}),
    tool_id: route.tool.namespacedName,
    tool_version: toolVersion(snapshot, route.tool.namespacedName)
  };
}

function materializationInput(selection: SelectedCatalogTool) {
  return [{
    namespacedName: selection.namespacedName,
    revisionId: selection.revisionId,
    serverId: selection.serverId
  }];
}

function findSelection(catalog: McpCapabilityCatalog, toolId: string): SelectedCatalogTool | null {
  return mcpCatalogToolsByNames(catalog, [toolId])[0] ?? null;
}

function safeArguments(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    const encoded = canonicalMcpJson(value);
    const snapshot = JSON.parse(encoded) as unknown;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("invalid");
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1_024) throw new Error("too_large");
    return snapshot as Record<string, unknown>;
  } catch (error) {
    throw new McpHubServiceError("invalid_arguments", { cause: error });
  }
}

function requestFor(goal: string, context?: string) {
  return {
    content: { blocks: [{ text: goal, type: "text" }] },
    ...(context ? {
      context: {
        messages: [{
          content: { blocks: [{ text: context, type: "text" }] },
          id: "hub-context",
          role: "user" as const
        }],
        mode: "branch_path" as const
      }
    } : {})
  };
}

function mapPreparationFailure(error: unknown): McpHubServiceError {
  if (error instanceof McpHubServiceError) return error;
  return new McpHubServiceError("upstream_unavailable", { cause: error });
}

export function createMcpHubService(dependencies: McpHubServiceDependencies) {
  const authorizedCatalog = async (userId: string) =>
    filterMcpCatalog(userId, await dependencies.catalog(userId), dependencies.filterTools);

  const materialize = async (
    userId: string,
    selection: SelectedCatalogTool
  ): Promise<MaterializedTool> => {
    let plan: McpRunPlanResult;
    try {
      plan = await dependencies.materialize(userId, materializationInput(selection));
    } catch (error) {
      throw mapPreparationFailure(error);
    }
    if (!plan.ok || plan.snapshot.tools.length !== 1 ||
      plan.snapshot.tools[0]?.namespacedName !== selection.namespacedName) {
      throw new McpHubServiceError("upstream_unavailable");
    }
    const route = resolveMcpRunTool(plan.snapshot, selection.namespacedName);
    const binding = plan.bindings.find((candidate) => candidate.serverId === selection.serverId);
    if (!route || !binding || binding.fingerprint !== route.fingerprint) {
      throw new McpHubServiceError("upstream_unavailable");
    }
    return {
      descriptor: descriptorFor(selection, plan.snapshot),
      generationId: binding.runtimeGenerationId,
      snapshot: plan.snapshot
    };
  };

  const resolveCurrent = async (
    userId: string,
    toolId: string
  ): Promise<MaterializedTool> => {
    const selection = findSelection(await authorizedCatalog(userId), toolId);
    if (!selection) throw new McpHubServiceError("tool_unavailable");
    return materialize(userId, selection);
  };

  return {
    async findTools(input: Readonly<{
      context?: string;
      goal: string;
      maxResults?: number;
      maxOutputTokens?: number | null;
      onUsage?(usage: McpRouterUsageAttribution): void;
      signal?: AbortSignal;
      timeoutMs?: number;
      userId: string;
    }>): Promise<McpHubDiscoveryResult> {
      const parsed = mcpFindToolsArguments({ goal: input.goal });
      if (!parsed || (input.context !== undefined &&
        (typeof input.context !== "string" || input.context.length > MAX_HUB_CONTEXT_CHARACTERS))) {
        throw new McpHubServiceError("invalid_arguments");
      }
      const maxResults = input.maxResults ?? LEGACY_MCP_DISCOVERY_MAX_RESULTS;
      if (!Number.isSafeInteger(maxResults) || maxResults < 1 ||
        maxResults > MCP_RUN_PLAN_LIMITS.maxTools) {
        throw new McpHubServiceError("invalid_arguments");
      }
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      const catalog = await authorizedCatalog(input.userId);
      if (catalog.servers.length === 0) {
        return {
          incomplete: false,
          message: "No matching enabled MCP tools were found.",
          schema_version: 1,
          tools: []
        };
      }
      let routed: Awaited<ReturnType<McpSemanticRouter["route"]>>;
      try {
        routed = await dependencies.router.route({
          activeToolNames: new Set(),
          catalog,
          goals: [parsed.goal],
          limit: maxResults,
          maxOutputTokens: input.maxOutputTokens,
          request: requestFor(parsed.goal, input.context?.trim() || undefined),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
        });
      } catch (error) {
        if (error instanceof McpSemanticRouterError && error.usageAttribution) {
          input.onUsage?.(error.usageAttribution);
        }
        throw new McpHubServiceError(
          input.signal?.aborted ? "request_cancelled" : "discovery_unavailable",
          { cause: error }
        );
      }
      if (routed.usageAttribution) input.onUsage?.(routed.usageAttribution);
      if (routed.toolNames.length > maxResults ||
        new Set(routed.toolNames).size !== routed.toolNames.length) {
        throw new McpHubServiceError("discovery_unavailable");
      }
      const selections = mcpCatalogToolsByNames(catalog, routed.toolNames);
      if (selections.length !== routed.toolNames.length) {
        throw new McpHubServiceError("discovery_unavailable");
      }
      const settled = await Promise.allSettled(
        selections.map((selection) => materialize(input.userId, selection))
      );
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      const tools = settled.flatMap((entry) => entry.status === "fulfilled"
        ? [entry.value.descriptor]
        : []);
      const incomplete = tools.length !== selections.length;
      if (selections.length > 0 && tools.length === 0) {
        throw new McpHubServiceError("upstream_unavailable");
      }
      return {
        incomplete,
        message: tools.length === 0
          ? "No matching enabled MCP tools were found."
          : incomplete
            ? "Some matching tools are temporarily unavailable. Use call_tool with a returned tool_id, tool_version and arguments."
            : "Use call_tool with a returned tool_id, tool_version and arguments.",
        schema_version: 1,
        tools
      };
    },

    async prepareToolCall(input: Readonly<{
      arguments: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
      toolId: string;
      toolVersion: string;
      userId: string;
    }>): Promise<McpHubPreparedToolCall> {
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      const materialized = await resolveCurrent(input.userId, input.toolId);
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      if (materialized.descriptor.tool_version !== input.toolVersion) {
        throw new McpHubServiceError("tool_definition_changed");
      }
      const toolArguments = safeArguments(input.arguments);
      try {
        validateMcpToolArguments(materialized.descriptor.input_schema, toolArguments);
      } catch (error) {
        throw new McpHubServiceError("invalid_arguments", { cause: error });
      }
      return {
        arguments: toolArguments,
        descriptor: materialized.descriptor,
        serverId: materialized.snapshot.tools[0]!.serverId
      };
    },

    async dispatchPreparedToolCall(input: Readonly<{
      beforeDispatch?(call: McpHubPreparedToolCall): Promise<void>;
      prepared: McpHubPreparedToolCall;
      signal?: AbortSignal;
      userId: string;
    }>): Promise<AiqsaMcpToolCallResult> {
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      const current = await resolveCurrent(input.userId, input.prepared.descriptor.tool_id);
      if (current.descriptor.tool_version !== input.prepared.descriptor.tool_version) {
        throw new McpHubServiceError("tool_definition_changed");
      }
      const route = resolveMcpRunTool(current.snapshot, current.descriptor.tool_id);
      if (!route) throw new McpHubServiceError("tool_unavailable");
      const allowed = await dependencies.filterTools(input.userId, [route.tool]);
      if (allowed.length !== 1) throw new McpHubServiceError("tool_unavailable");
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      await input.beforeDispatch?.(input.prepared);
      if (input.signal?.aborted) throw new McpHubServiceError("request_cancelled");
      try {
        const result = await dependencies.callRuntimeTool({
          arguments: input.prepared.arguments as Record<string, unknown>,
          generationId: current.generationId,
          inputSchema: route.tool.inputSchema,
          name: route.originalName,
          ...(input.signal ? { signal: input.signal } : {})
        });
        if (result.unsupportedContentTypes.length > 0) {
          throw new McpHubServiceError("result_unsupported");
        }
        return result;
      } catch (error) {
        if (error instanceof McpHubServiceError) throw error;
        if (error instanceof McpClientSessionError) {
          if (["mcp_call_arguments_invalid", "mcp_call_arguments_too_large"].includes(error.code)) {
            throw new McpHubServiceError("invalid_arguments", { cause: error });
          }
          if (["mcp_call_result_invalid", "mcp_call_result_too_large", "mcp_call_result_unsupported"]
            .includes(error.code)) {
            throw new McpHubServiceError("result_unsupported", { cause: error });
          }
          if (["mcp_session_closed", "mcp_session_not_ready", "mcp_tool_not_available"]
            .includes(error.code)) {
            throw new McpHubServiceError("upstream_unavailable", { cause: error });
          }
        }
        throw new McpHubServiceError("execution_outcome_unknown", { cause: error });
      }
    }
  };
}

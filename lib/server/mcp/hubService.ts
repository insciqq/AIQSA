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
import { MCP_HUB_DISCOVERY_RESPONSE_MAX_BYTES } from "./hubConfiguration";
import type { McpToolAccessFilter } from "./toolAccess";
import { McpClientSessionError, validateMcpToolArguments, type AiqsaMcpToolCallResult } from "./clientSession";
import { dispatchMcpTool, resolveMcpRunTool } from "./toolExecutor";
import { discoverMcpTools, materializeMcpSelection } from "./discoveryService";
import {
  type McpSemanticRouter,
  type McpRouterAttemptRecorder,
  type McpRouterUsageAttribution
} from "./router";
import type {
  McpCapabilityCatalog,
  McpRunPlanResult,
  McpRunPlanSnapshot
} from "./runPlan";

export type McpHubServiceErrorCode =
  | "authorization_required"
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

/** Server-owned, request-bound authority. Never accepted from tool arguments. */
export type McpHubAuthority = Readonly<{
  clientId: string;
  grantId: string;
  userId: string;
  assertActive(): Promise<void>;
}>;

type SelectedCatalogTool = ReturnType<typeof mcpCatalogToolsByNames>[number];
type SelectedTools = readonly Readonly<{
  namespacedName: string;
  revisionId: string;
  serverId: string;
}>[];

export type McpHubServiceDependencies = Readonly<{
  callRuntimeTool(input: Readonly<{
    arguments: Record<string, unknown>;
    beforeDispatch(): Promise<void>;
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }>): Promise<AiqsaMcpToolCallResult>;
  catalog(userId: string): Promise<McpCapabilityCatalog>;
  filterTools: McpToolAccessFilter;
  materialize(
    userId: string,
    tools: SelectedTools,
    signal?: AbortSignal
  ): Promise<McpRunPlanResult>;
  /** Read the current exact definition/authority without starting a runtime. */
  inspect(userId: string, tools: SelectedTools): Promise<McpRunPlanResult>;
  router: McpSemanticRouter;
  recordDiscoveryAttempt(authority: McpHubAuthority, role: Parameters<McpRouterAttemptRecorder>[0]): ReturnType<McpRouterAttemptRecorder>;
  recordDispatch(input: Readonly<{
    clientId: string;
    grantId: string;
    resourcePath: "/mcp/hub";
    toolId: string;
    toolVersion: string;
    userId: string;
  }>): Promise<Readonly<{
    settle(state: "COMPLETE" | "ERROR" | "UNKNOWN", resultCode?: string): Promise<void>;
  }>>;
}>;

type MaterializedTool = Readonly<{
  descriptor: McpHubToolDescriptor;
  generationId: string;
  snapshot: McpRunPlanSnapshot;
}>;

const MAX_HUB_CONTEXT_CHARACTERS = 8_000;

function discoveryResult(tools: readonly McpHubToolDescriptor[], incomplete: boolean): McpHubDiscoveryResult {
  return {
    incomplete,
    message: tools.length === 0 ? "No matching enabled MCP tools were found."
      : incomplete ? "Some matching tools could not be included. Use call_tool with a returned tool_id, tool_version and arguments."
        : "Use call_tool with a returned tool_id, tool_version and arguments.",
    schema_version: 1,
    tools
  };
}

function discoveryFits(tools: readonly McpHubToolDescriptor[]): boolean {
  const value = discoveryResult(tools, true);
  const result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  // Reserve the bounded incoming request's maximum ID plus protocol overhead.
  return Buffer.byteLength(JSON.stringify(result), "utf8") + 129 * 1_024 <= MCP_HUB_DISCOVERY_RESPONSE_MAX_BYTES;
}

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

function mapPreparationFailure(error: unknown): McpHubServiceError {
  if (error instanceof McpHubServiceError) return error;
  return new McpHubServiceError("upstream_unavailable", { cause: error });
}

export function createMcpHubService(dependencies: McpHubServiceDependencies) {
  const preparedCalls = new WeakMap<McpHubPreparedToolCall, McpHubAuthority>();
  const assertActive = async (authority: McpHubAuthority, signal?: AbortSignal) => {
    if (signal?.aborted) throw new McpHubServiceError("request_cancelled");
    await authority.assertActive();
    if (signal?.aborted) throw new McpHubServiceError("request_cancelled");
  };
  const authorizedCatalog = async (userId: string) =>
    filterMcpCatalog(userId, await dependencies.catalog(userId), dependencies.filterTools);

  const materialize = async (
    authority: McpHubAuthority,
    selection: SelectedCatalogTool,
    signal?: AbortSignal,
    inspect = false
  ): Promise<MaterializedTool> => {
    await assertActive(authority, signal);
    let plan: McpRunPlanResult;
    try {
      plan = await materializeMcpSelection({
        materialize: inspect ? dependencies.inspect : dependencies.materialize,
        selected: [selection],
        signal,
        userId: authority.userId
      });
    } catch (error) {
      throw mapPreparationFailure(error);
    }
    await assertActive(authority, signal);
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
    authority: McpHubAuthority,
    toolId: string,
    signal?: AbortSignal,
    inspect = false
  ): Promise<MaterializedTool> => {
    await assertActive(authority, signal);
    const selection = findSelection(await authorizedCatalog(authority.userId), toolId);
    if (!selection) throw new McpHubServiceError("tool_unavailable");
    return materialize(authority, selection, signal, inspect);
  };

  const revalidate = async (
    authority: McpHubAuthority,
    descriptor: McpHubToolDescriptor,
    signal?: AbortSignal
  ) => {
    const current = await resolveCurrent(authority, descriptor.tool_id, signal, true);
    if (current.descriptor.tool_version !== descriptor.tool_version) {
      throw new McpHubServiceError("tool_definition_changed");
    }
    return current;
  };

  return {
    async findTools(input: Readonly<{
      authority: McpHubAuthority;
      context?: string;
      goal: string;
      maxResults?: number;
      maxOutputTokens?: number | null;
      onUsage?(usage: McpRouterUsageAttribution): void;
      signal?: AbortSignal;
      timeoutMs?: number;
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
      await assertActive(input.authority, input.signal);
      let discovered: Awaited<ReturnType<typeof discoverMcpTools>>;
      try {
        discovered = await discoverMcpTools({
          assertActive: () => assertActive(input.authority, input.signal),
          catalog: await dependencies.catalog(input.authority.userId),
          filterTools: dependencies.filterTools,
          materialize: dependencies.materialize,
          onUsage: input.onUsage,
          partial: true,
          router: dependencies.router,
          routing: {
            activeToolNames: new Set(),
            context: input.context ? { messages: [{ role: "user", text: input.context }] } : undefined,
            goals: [parsed.goal],
            limit: maxResults,
            maxOutputTokens: input.maxOutputTokens,
            beforeDispatch: () => assertActive(input.authority, input.signal),
            recordAttempt: (role) => dependencies.recordDiscoveryAttempt(input.authority, role),
            signal: input.signal,
            timeoutMs: input.timeoutMs
          },
          userId: input.authority.userId
        });
      } catch (error) {
        if (error instanceof McpHubServiceError) throw error;
        throw new McpHubServiceError(input.signal?.aborted ? "request_cancelled" : "discovery_unavailable", { cause: error });
      }
      const { selected: selections, plans } = discovered;
      const settled = await Promise.allSettled(plans.map(async (plan) => {
        const selection = selections.find((selected) => selected.namespacedName === plan.snapshot.tools[0]?.namespacedName)!;
        const descriptor = descriptorFor(selection, plan.snapshot);
        await revalidate(input.authority, descriptor, input.signal);
        return descriptor;
      }));
      await assertActive(input.authority, input.signal);
      const readyTools = settled.flatMap((entry) => entry.status === "fulfilled"
        ? [entry.value]
        : []);
      // A slow sibling can hold discovery open after another descriptor was
      // prepared. Apply current grants once more to the complete response.
      const currentCatalog = await authorizedCatalog(input.authority.userId);
      const tools: McpHubToolDescriptor[] = [];
      for (const tool of readyTools) {
        const current = findSelection(currentCatalog, tool.tool_id);
        if (current && selections.some((selected) => selected.namespacedName === tool.tool_id &&
          selected.revisionId === current.revisionId) && discoveryFits([...tools, tool])) tools.push(tool);
      }
      await assertActive(input.authority, input.signal);
      const incomplete = tools.length !== selections.length;
      if (selections.length > 0 && tools.length === 0) {
        throw new McpHubServiceError("upstream_unavailable");
      }
      return discoveryResult(tools, incomplete);
    },

    async prepareToolCall(input: Readonly<{
      authority: McpHubAuthority;
      arguments: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
      toolId: string;
      toolVersion: string;
    }>): Promise<McpHubPreparedToolCall> {
      const materialized = await resolveCurrent(input.authority, input.toolId, input.signal);
      if (materialized.descriptor.tool_version !== input.toolVersion) {
        throw new McpHubServiceError("tool_definition_changed");
      }
      const toolArguments = safeArguments(input.arguments);
      try {
        validateMcpToolArguments(materialized.descriptor.input_schema, toolArguments);
      } catch (error) {
        throw new McpHubServiceError("invalid_arguments", { cause: error });
      }
      await revalidate(input.authority, materialized.descriptor, input.signal);
      const prepared = {
        arguments: toolArguments,
        descriptor: materialized.descriptor,
        serverId: materialized.snapshot.tools[0]!.serverId
      };
      preparedCalls.set(prepared, input.authority);
      return prepared;
    },

    async dispatchPreparedToolCall(input: Readonly<{
      authority: McpHubAuthority;
      onDispatch?(): void;
      prepared: McpHubPreparedToolCall;
      signal?: AbortSignal;
    }>): Promise<AiqsaMcpToolCallResult> {
      if (preparedCalls.get(input.prepared) !== input.authority) {
        throw new McpHubServiceError("tool_unavailable");
      }
      // A prepared object is one dispatch admission, not a replay handle.
      preparedCalls.delete(input.prepared);
      await revalidate(input.authority, input.prepared.descriptor, input.signal);
      let receipt: Awaited<ReturnType<McpHubServiceDependencies["recordDispatch"]>>;
      try {
        receipt = await dependencies.recordDispatch({
          clientId: input.authority.clientId,
          grantId: input.authority.grantId,
          resourcePath: "/mcp/hub",
          toolId: input.prepared.descriptor.tool_id,
          toolVersion: input.prepared.descriptor.tool_version,
          userId: input.authority.userId
        });
      } catch (error) {
        throw new McpHubServiceError("upstream_unavailable", { cause: error });
      }
      let dispatched = false;
      let result: AiqsaMcpToolCallResult | undefined;
      let failure: McpHubServiceError | undefined;
      try {
        // The durable write can wait on the database. Check authority again
        // after it, before handing anything to the outbound runtime.
        const current = await revalidate(input.authority, input.prepared.descriptor, input.signal);
        const route = resolveMcpRunTool(current.snapshot, current.descriptor.tool_id);
        if (!route) throw new McpHubServiceError("tool_unavailable");
        const args = safeArguments(input.prepared.arguments);
        validateMcpToolArguments(route.tool.inputSchema, args);
        result = await dispatchMcpTool({
          arguments: args,
          async assertCurrent() {
            const latest = await revalidate(input.authority, input.prepared.descriptor, input.signal);
            if (latest.generationId !== current.generationId) throw new McpHubServiceError("tool_unavailable");
          },
          callTool: dependencies.callRuntimeTool,
          generationId: current.generationId,
          onDispatch() {
            dispatched = true;
            input.onDispatch?.();
          },
          route,
          signal: input.signal
        });
        if (result.unsupportedContentTypes.length > 0) {
          throw new McpHubServiceError("result_unsupported");
        }
        await revalidate(input.authority, input.prepared.descriptor, input.signal);
      } catch (error) {
        if (error instanceof McpHubServiceError) {
          failure = dispatched && error.code === "request_cancelled"
            ? new McpHubServiceError("execution_outcome_unknown") : error;
        } else if (error instanceof McpClientSessionError &&
          ["mcp_call_result_invalid", "mcp_call_result_too_large", "mcp_call_result_unsupported"].includes(error.code)) {
          failure = new McpHubServiceError("result_unsupported");
        } else {
          failure = new McpHubServiceError(dispatched ? "execution_outcome_unknown" : "upstream_unavailable");
        }
      }
      try {
        await receipt.settle(
          failure?.code === "execution_outcome_unknown" ? "UNKNOWN"
            : failure || result?.isError ? "ERROR" : "COMPLETE",
          failure?.code ?? (result?.isError ? "upstream_error" : undefined)
        );
      } catch (error) {
        throw new McpHubServiceError(dispatched ? "execution_outcome_unknown" : "upstream_unavailable", { cause: error });
      }
      if (failure) throw failure;
      // Authority may change while terminal accounting settles too.
      await revalidate(input.authority, input.prepared.descriptor, input.signal);
      return result!;
    }
  };
}

import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { prisma } from "../prisma";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { logEvent, runWithContext } from "../observability";
import { catalogFromSnapshot } from "../agents/mcpGateway";
import { withAgentLease } from "../agents/lease";
import { createMcpToolService, McpHubServiceError, type McpHubServiceErrorCode } from "../mcp/hubService";
import { defaultMcpRunPlan, getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { getMcpRequestMaxBytes, getMcpResponseWireLimits, mcpRequestSizeFailure } from "../mcp/responseLimits";
import { resolveMcpRunTool, type McpToolRuntimeCall } from "../mcp/toolExecutor";
import { filterMcpCatalog } from "../mcp/toolAccessProjection";
import type { McpToolAccessFilter } from "../mcp/toolAccess";
import type { McpCapabilityCatalog, McpCapabilityCatalogTool, McpRunPlanResult } from "../mcp/runPlan";
import { resolveProjectAccess } from "../projects/access";
import { isWorkspaceCodeInvocationId, WORKSPACE_CODE_INVOCATION_HEADER } from "./codeMcp";
import {
  createPrismaWorkspaceCodeGatewayStore,
  WorkspaceCodeAccessError,
  type WorkspaceCodeClaim,
  type WorkspaceCodeGatewayGrant,
  type WorkspaceCodeGatewayStore,
  type WorkspaceCodeProjectAuthority
} from "./codeMcpStore";

/** Marks gateway refusals in a tool result, distinct from a tool's own error result. */
export const WORKSPACE_CODE_ERROR_META = "aiqsa/error";

type SelectedTools = readonly Readonly<{ namespacedName: string; revisionId: string; serverId: string }>[];

/** The shared MCP dispatch pipeline and authority of model calls; injectable for tests. */
export type WorkspaceCodeMcpDependencies = Readonly<{
  callRuntimeTool: McpToolRuntimeCall;
  filterTools: McpToolAccessFilter;
  inspect(userId: string, tools: SelectedTools): Promise<McpRunPlanResult>;
  inspectProject(userId: string, tools: SelectedTools): Promise<McpRunPlanResult>;
  materialize(userId: string, tools: SelectedTools, signal?: AbortSignal): Promise<McpRunPlanResult>;
  materializeProject(userId: string, tools: SelectedTools, signal?: AbortSignal): Promise<McpRunPlanResult>;
  /**
   * Whether the Project run initiator still holds the run's accepted Project
   * authority: rechecked with the bearer, before each step and every lease tick.
   */
  projectAccess(input: WorkspaceCodeProjectAuthority & Readonly<{ userId: string }>): Promise<boolean>;
  store: WorkspaceCodeGatewayStore;
}>;

export function defaultWorkspaceCodeMcpDependencies(): WorkspaceCodeMcpDependencies {
  return {
    callRuntimeTool: (request) => getDefaultMcpRuntimeCoordinator().callTool(request),
    filterTools: defaultMcpRunPlan.filterTools,
    inspect: (userId, tools) => defaultMcpRunPlan.inspect(userId, tools),
    inspectProject: (userId, tools) => defaultMcpRunPlan.inspectProject(userId, tools),
    materialize: (userId, tools, signal) => defaultMcpRunPlan.materialize(userId, tools, signal),
    materializeProject: (userId, tools, signal) => defaultMcpRunPlan.materializeProject(userId, tools, signal),
    // The model path's rule (the run repository's `isProjectRunAccessCurrent`):
    // a current contributor, at exactly the run's accepted Project revisions.
    async projectAccess({ userId, ...accepted }) {
      const access = await resolveProjectAccess(prisma, { minimumRole: "CONTRIBUTOR", projectId: accepted.projectId,
        requireActive: true, userId });
      return access?.accessRevision === accepted.accessRevision &&
        access.instructionsRevision === accepted.instructionsRevision &&
        access.memoryRevision === accepted.memoryRevision &&
        access.policyRevision === accepted.policyRevision;
    },
    store: createPrismaWorkspaceCodeGatewayStore(prisma)
  };
}

const refused = () => Response.json({ error: "agent_authorization_required" }, { status: 401 });
/** The bearer is valid, but the request names no open invocation of its run. */
const invocationRefused = () => Response.json({ error: "code_invocation_required" }, { status: 403 });

type RefusalCode = Exclude<WorkspaceCodeClaim, { kind: "claimed" }>["code"] | McpHubServiceErrorCode;

const MESSAGES: Readonly<Record<RefusalCode, string>> = {
  authorization_required: "The MCP server needs the user to sign in again. Nothing was sent.",
  code_invocation_closed: "This process no longer belongs to a running Workspace command, so it cannot call MCP tools.",
  code_mcp_busy: "Too many MCP calls from this run's code are in progress. Wait for one to finish, then retry.",
  code_mcp_call_limit: "This run's MCP call budget for code is exhausted. Nothing was sent; further calls are refused for this run.",
  code_mcp_rate_limited: "MCP calls from this run's code are arriving too fast. Wait a moment, then retry.",
  code_token_revoked: "The run's MCP authority for code has ended.",
  discovery_unavailable: "The MCP tool could not be prepared. Nothing was sent.",
  execution_outcome_unknown: "The call was sent, but its outcome is unknown. Do not repeat an operation whose outcome is unknown.",
  invalid_arguments: "The arguments do not match the tool's input schema. Nothing was sent.",
  request_cancelled: "The call was cancelled before anything was sent.",
  result_unsupported: "The tool was called, but its response was too large, invalid or used unsupported content. Do not repeat a write operation solely because its response could not be read.",
  tool_definition_changed: "The tool definition or configuration changed since this run started. Nothing was sent.",
  tool_unavailable: "The tool is unavailable with the current settings or permissions. Nothing was sent.",
  upstream_unavailable: "The MCP server is unavailable. Nothing was sent."
};

/** Gateway refusals keep the tool-result shape, marked so clients never mistake them for the tool's own output. */
function refusal(code: RefusalCode, dispatched: boolean, detail: Record<string, unknown> = {}): CallToolResult {
  const value = { code, dispatched, message: MESSAGES[code], ...detail };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true,
    _meta: { [WORKSPACE_CODE_ERROR_META]: true } };
}

/** Bounded schemas only: a hint must never become a large response by itself. */
function boundedSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return Buffer.byteLength(JSON.stringify(schema)) <= 16 * 1_024 ? schema as Record<string, unknown> : undefined;
}

const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

/** An Auto catalog holds argument inventories, not schemas: advertise them as a hint. */
function catalogInputSchema(tool: McpCapabilityCatalogTool): Record<string, unknown> {
  const properties = Object.fromEntries((tool.arguments ?? []).map((argument) => {
    const types = argument.types.filter((type) => SCHEMA_TYPES.has(type));
    return [argument.name, { ...(types.length === 1 ? { type: types[0] } : types.length > 1 ? { type: types } : {}),
      ...(argument.description ? { description: argument.description } : {}) }];
  }));
  return { properties, type: "object" };
}

/**
 * The SDK validates nothing here: arguments are validated once, by the
 * shared pipeline, against the exact accepted or current definition.
 */
function advertised(schema: Record<string, unknown>) {
  return { "~standard": { version: 1 as const, vendor: "aiqsa",
    jsonSchema: { input: () => schema, output: () => schema },
    validate(value: unknown) {
      if (value === undefined) return { value: {} as Record<string, unknown> };
      return value && typeof value === "object" && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "invalid_arguments" }] };
    }
  } };
}

type ListedTool = Readonly<{
  annotations?: Record<string, boolean | string>;
  description: string;
  inputSchema: Record<string, unknown>;
  namespacedName: string;
  originalName: string;
  revisionId: string;
  serverId: string;
  serverName: string;
}>;

function listedTools(grant: WorkspaceCodeGatewayGrant, visible: McpCapabilityCatalog): ListedTool[] {
  const names = new Set(visible.servers.flatMap((server) => server.tools.map((tool) => tool.namespacedName)));
  if (grant.authority.kind === "plan") {
    const { snapshot } = grant.authority;
    return snapshot.tools.filter((tool) => names.has(tool.namespacedName)).map((tool) => ({
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      description: tool.description ?? tool.title ?? tool.originalName,
      inputSchema: boundedSchema(tool.inputSchema) ?? { type: "object" },
      namespacedName: tool.namespacedName, originalName: tool.originalName,
      revisionId: snapshot.servers.find((server) => server.serverId === tool.serverId)?.revisionId ?? "",
      serverId: tool.serverId, serverName: tool.serverName
    }));
  }
  return visible.servers.flatMap((server) => server.tools.map((tool) => ({
    description: tool.description ?? tool.title ?? tool.originalName,
    inputSchema: catalogInputSchema(tool),
    namespacedName: tool.namespacedName, originalName: tool.originalName, revisionId: server.revisionId,
    serverId: server.serverId, serverName: server.serverName
  })));
}

const SIGN_IN_READINESS = new Set(["authorizing", "needs_authorization", "reauthorization_required"]);

/** Whether a source refused before dispatch needs the user to sign in again, from its current plan. */
function signInRequired(plan: McpRunPlanResult): boolean {
  return !plan.ok && plan.issues.some((issue) => SIGN_IN_READINESS.has(issue.readiness) ||
    issue.errorCode === "mcp_oauth_reauthorization_required" || issue.personalCredentialRejected === true);
}

/**
 * `POST mcp` for a Workspace code bearer: an MCP server over exactly the
 * run's frozen MCP authority (the Auto catalog or the accepted plan). Each
 * call persists a content-free receipt within the code budgets first, then
 * runs the shared reauthorization and dispatch pipeline of model calls.
 * Nothing of the arguments or the result is stored.
 */
export async function handleWorkspaceCodeMcpRequest(
  request: Request,
  tokenHash: string,
  dependencies: WorkspaceCodeMcpDependencies = defaultWorkspaceCodeMcpDependencies()
): Promise<Response> {
  const grant = await dependencies.store.load(tokenHash);
  if (!grant) return refused();
  const invocationId = request.headers.get(WORKSPACE_CODE_INVOCATION_HEADER);
  if (!isWorkspaceCodeInvocationId(invocationId)) return invocationRefused();
  // The lease runs this before serving and every second while a request is
  // open, so lost run, invocation or Project authority also ends a call in flight.
  const assertActive = async () => {
    await dependencies.store.assertActive(grant, invocationId);
    if (grant.project && !(await dependencies.projectAccess({ ...grant.project, userId: grant.userId }))) {
      throw new WorkspaceCodeAccessError("authority");
    }
  };
  try {
    return await runWithContext({ run_id: grant.runId }, () => withAgentLease(request, assertActive,
      (signal) => serve(request, signal, grant, invocationId, assertActive, dependencies)));
  } catch (error) {
    return error instanceof WorkspaceCodeAccessError && error.reason === "invocation" ? invocationRefused() : refused();
  }
}

/** A refusal for authority the run lost: never the source's failure. */
function lostAuthority(error: WorkspaceCodeAccessError): RefusalCode {
  return error.reason === "invocation" ? "code_invocation_closed" : "code_token_revoked";
}

async function serve(
  request: Request,
  signal: AbortSignal,
  grant: WorkspaceCodeGatewayGrant,
  invocationId: string,
  assertGrantActive: () => Promise<void>,
  dependencies: WorkspaceCodeMcpDependencies
): Promise<Response> {
  let requestBodyRead = false;
  try {
    const bounded = new Request(request, { signal });
    const bytes = await readBoundedRequestBody(bounded, { maxBytes: getMcpRequestMaxBytes(), signal });
    requestBodyRead = true;
    const parsedBody: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return new Response(null, { status: 400 });
    type Authority = Readonly<{ userId: string; assertActive(): Promise<void> }>;
    const authority: Authority = { userId: grant.userId, async assertActive() {
      signal.throwIfAborted();
      await assertGrantActive();
    } };
    const project = grant.project !== null;
    const catalog = grant.authority.kind === "catalog" ? grant.authority.catalog : catalogFromSnapshot(grant.authority.snapshot);
    const service = createMcpToolService<Authority>({
      catalog: async () => catalog,
      filterTools: dependencies.filterTools,
      callRuntimeTool: dependencies.callRuntimeTool,
      inspect: (userId, tools) => project ? dependencies.inspectProject(userId, tools) : dependencies.inspect(userId, tools),
      materialize: (userId, tools, materializeSignal) => project
        ? dependencies.materializeProject(userId, tools, materializeSignal)
        : dependencies.materialize(userId, tools, materializeSignal),
      // The receipt exists already; it settles once, below, with size and duration.
      recordDispatch: async () => ({ async settle() {} })
    });
    const tools = listedTools(grant, await filterMcpCatalog(grant.userId, catalog, dependencies.filterTools));
    const call = async (tool: ListedTool, args: Record<string, unknown>): Promise<CallToolResult> => {
      const started = Date.now();
      const claim = await dependencies.store.claim({ argumentHash: hashCanonicalMcpValue(args), grant, invocationId,
        serverId: tool.serverId, toolName: tool.namespacedName });
      const observe = (outcome: "completed" | "failed", stage: "admission" | "result", code?: string) =>
        logEvent("tool_execution", { tool_kind: "mcp", stage, outcome, duration_ms: Date.now() - started, ...(code ? { code } : {}) });
      if (claim.kind === "refused") {
        observe("failed", "admission", claim.code);
        return refusal(claim.code, false);
      }
      let dispatched = false;
      let schema: Record<string, unknown> | undefined;
      try {
        let toolVersion: string;
        if (grant.authority.kind === "plan") {
          const route = resolveMcpRunTool(grant.authority.snapshot, tool.namespacedName);
          if (!route) throw new McpHubServiceError("tool_unavailable");
          schema = boundedSchema(route.tool.inputSchema);
          // Exact accepted definition and configuration: a change is refused.
          toolVersion = hashCanonicalMcpValue({ definitionHash: route.tool.definitionHash,
            effectiveConfiguration: route.fingerprint, toolId: tool.namespacedName });
        } else {
          // Auto: the exact current definition the run's catalog authorizes, as `find_tools` would load it.
          const found = await service.findTools({ authority, maxResults: 1, query: `select:${tool.namespacedName}`, signal });
          const descriptor = found.tools.find((candidate) => candidate.tool_id === tool.namespacedName);
          if (!descriptor) throw new McpHubServiceError("tool_unavailable");
          schema = boundedSchema(descriptor.input_schema);
          toolVersion = descriptor.tool_version;
        }
        const prepared = await service.prepareToolCall({ arguments: args, authority, signal, toolId: tool.namespacedName, toolVersion });
        const result = await service.dispatchPreparedToolCall({ authority, onDispatch: () => { dispatched = true; }, prepared, signal });
        const output: CallToolResult = {
          content: result.text.map((text) => ({ type: "text" as const, text })),
          ...(result.structuredContent ? { structuredContent: result.structuredContent as Record<string, unknown> } : {}),
          ...(result.isError ? { isError: true } : {})
        };
        await dependencies.store.settle({ durationMs: Date.now() - started, errorCode: result.isError ? "upstream_error" : null,
          id: claim.id, resultBytes: Buffer.byteLength(JSON.stringify(output)), runId: grant.runId,
          state: result.isError ? "error" : "complete" });
        observe(result.isError ? "failed" : "completed", "result", result.isError ? "upstream_error" : undefined);
        return output;
      } catch (error) {
        let code: RefusalCode = error instanceof McpHubServiceError ? error.code
          : error instanceof WorkspaceCodeAccessError ? lostAuthority(error)
          : signal.aborted ? "request_cancelled" : "upstream_unavailable";
        const sent = dispatched && !(error instanceof McpHubServiceError && error.refusedBeforeSend);
        if (!sent && code === "upstream_unavailable" && !signal.aborted) {
          // The shared pipeline reports lost run authority and a lost sign-in
          // as unavailable too; tell the code (and scheduled source health)
          // which one it is, since only an outage or a sign-in is the source's.
          const lost = await assertGrantActive().then(() => null, (failure: unknown) => failure);
          if (lost instanceof WorkspaceCodeAccessError) code = lostAuthority(lost);
          else {
            const selection = [{ namespacedName: tool.namespacedName, revisionId: tool.revisionId, serverId: tool.serverId }];
            const current = await (project ? dependencies.inspectProject(grant.userId, selection)
              : dependencies.inspect(grant.userId, selection)).catch(() => null);
            if (current && signInRequired(current)) code = "authorization_required";
          }
        }
        // Sent and unreadable is a known error; anything else sent has an unknown outcome.
        const state = !sent ? "error" : code === "result_unsupported" ? "error" : "unknown";
        const reported = sent && state === "unknown" ? "execution_outcome_unknown" : code;
        await dependencies.store.settle({ durationMs: Date.now() - started, errorCode: reported, id: claim.id,
          resultBytes: null, runId: grant.runId, state }).catch(() => undefined);
        observe("failed", sent ? "result" : "admission", reported);
        return refusal(reported, sent, reported === "invalid_arguments" && schema ? { input_schema: schema } : {});
      }
    };
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "aiqsa-workspace-code", version: "1.0.0" });
      for (const tool of tools) {
        server.registerTool(tool.namespacedName, {
          _meta: { "aiqsa/server": tool.serverName, "aiqsa/tool": tool.originalName,
            ...(tool.annotations ? { "aiqsa/annotations": tool.annotations } : {}) },
          description: tool.description,
          inputSchema: advertised(tool.inputSchema),
          title: tool.originalName
        }, (args) => call(tool, args as Record<string, unknown>));
      }
      return server;
    }, { legacy: "stateless", responseMode: "json" });
    const response = await handler.fetch(bounded, { parsedBody });
    if (!response.body || response.status === 204) return response;
    // Finish the bounded transport before the lease ends, as the Agent gateway does.
    const result = await readBoundedRequestBody(new Request("http://code.invalid/", { method: "POST", body: response.body,
      duplex: "half", signal } as RequestInit), {
      maxBytes: 2 * getMcpResponseWireLimits().callToolResponseMaxBytes + 64 * 1024,
      signal
    });
    return new Response(result, { status: response.status, headers: response.headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      if (requestBodyRead) return Response.json({ code: "mcp_response_too_large", maxBytes: error.limitBytes,
        observedBytes: String(error.actualBytes), message: "The MCP response exceeds the configured transport limit. The tool may have completed; do not repeat a write operation solely because its response could not be read." }, { status: 502 });
      return Response.json(mcpRequestSizeFailure(error.actualBytes, error.limitBytes), { status: 413 });
    }
    if (error instanceof WorkspaceCodeAccessError) throw error;
    return Response.json({ error: "code_mcp_unavailable" }, { status: 502 });
  }
}

import { createAgentAiqsaSearch } from "./aiqsaSearchTool";
import { mcpDiscoveryFailureMessage } from "../../contracts/mcpDiscoveryFailure";
import { mcpToolFailureMessage } from "../../contracts/mcpToolFailure";
import { agentFailureCode, agentFailureMessage } from "./failures";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { canAccessSearchStrategy } from "../auth/entitlements";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { prisma } from "../prisma";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { createMcpToolService, McpHubServiceError, type McpToolAuthority } from "../mcp/hubService";
import { defaultMcpRunPlan, getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { createMcpSemanticRouter } from "../mcp/router";
import { createAcceptedStructuredOutputExecutor } from "../providerRuntime/structuredOutputExecutor";
import { createSystemModelRoleResolver } from "../providerRuntime/systemModelRole";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { validateMcpToolArguments } from "../mcp/clientSession";
import { getMcpResponseWireLimits, getMcpRequestMaxBytes, mcpRequestSizeFailure } from "../mcp/responseLimits";
import type { McpCapabilityCatalog, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { NormalizedRunRequest } from "../providers/types";
import type { createAgentRunStore } from "./store";

type Authority = McpToolAuthority & Readonly<{ callId: string }>;

function textResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function catalogFromSnapshot(snapshot?: McpRunPlanSnapshot): McpCapabilityCatalog {
  return { version: 1, servers: snapshot?.servers.map((server) => ({
    ...server, description: "", namespace: server.serverId,
    tools: snapshot.tools.filter((tool) => tool.serverId === server.serverId).map((tool) => ({
      namespacedName: tool.namespacedName, originalName: tool.originalName, description: tool.description
    }))
  })) ?? [] };
}

function frozenSchema(schema: Record<string, unknown>) {
  return { "~standard": { version: 1 as const, vendor: "aiqsa",
    jsonSchema: { input: () => schema, output: () => schema },
    validate(value: unknown) {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
        validateMcpToolArguments(schema, value as Record<string, unknown>);
        return { value: value as Record<string, unknown> };
      } catch { return { issues: [{ message: "invalid_arguments" }] }; }
    }
  } };
}

export async function createAgentMcpGateway(input: Readonly<{
  request: NormalizedRunRequest;
  runId: string;
  userId: string;
  store: ReturnType<typeof createAgentRunStore>;
  signal: AbortSignal;
  onFailure(code: string): Promise<void>;
  onUsage(): Promise<void>;
}>) {
  const configuration = input.request.agent!;
  const repository = createPrismaRunRepository(prisma);
  const search = createAgentAiqsaSearch({ plan: input.request.searchPlan, store: input.store, onUsage: input.onUsage,
    resolve: (option) => providerRuntimeResolver.resolve(input.runId, "search", `search:${option.optionId}`, { disableRequestRetries: true }),
    async assertAllowed(option) {
      const [entitlements, revision] = await Promise.all([
        repository.loadEntitlements(input.userId),
        prisma.searchIntegrationRevision.findFirst({ where: { id: option.revisionId, searchStrategy: {
          id: option.searchStrategyRowId, enabled: true, archivedAt: null,
          searchOption: { optionId: option.optionId, enabled: true, archivedAt: null }
        } }, select: { id: true } })
      ]);
      if (!revision || !canAccessSearchStrategy(entitlements, option.optionId)) throw new Error("search_strategy_not_available");
    }
  });
  const catalog = input.request.mcpDiscovery?.catalog ?? catalogFromSnapshot(input.request.mcp);
  const allowed = new Map((await input.store.mcpTools()).map((tool) => [tool.toolId, tool.version]));
  const role = createSystemModelRoleResolver(prisma);
  const service = createMcpToolService<Authority>({
    catalog: async () => catalog,
    filterTools: defaultMcpRunPlan.filterTools,
    callRuntimeTool: (request) => getDefaultMcpRuntimeCoordinator().callTool(request),
    inspect: (userId, tools) => defaultMcpRunPlan.inspect(userId, tools),
    async materialize(userId, tools, signal) {
      const plan = await defaultMcpRunPlan.materialize(userId, tools, signal);
      if (plan.ok) await input.store.admitMcpPlan(plan);
      return plan;
    },
    router: createMcpSemanticRouter({ resolveSystemModel: () => role.resolve(),
      executeStructuredOutput: createAcceptedStructuredOutputExecutor(prisma, { disableRequestRetries: true }) }),
    async recordDiscoveryAttempt(authority, providerRole, maxOutputTokens, _timeoutMs, inputBytes) {
      await authority.assertActive();
      // Include the complete admitted goal, context and catalog. Reserve for
      // transport escaping and output; charge only provider-reported usage.
      const reservation = 2 * inputBytes + maxOutputTokens;
      const id = await input.store.reserveProvider(reservation, { kind: "discovery", role: providerRole });
      return { async settle({ state, usage }) {
        await input.store.settleProvider(id, state, usage);
        await input.onUsage();
      } };
    },
    async recordDispatch({ authority, toolId }) {
      await input.store.attachMcpCall(authority.callId, toolId);
      return { async settle(state, resultCode) {
        await input.store.settleTool(authority.callId, state === "COMPLETE" ? "complete" : "error", { state, code: resultCode ?? null });
        if (state === "UNKNOWN") await input.onFailure("agent_mcp_outcome_unknown");
      } };
    }
  });
  // The all-mode plan was frozen at acceptance. Auto exposes no business schema here.
  if (configuration.mcpMode === "all" && input.request.mcp) {
    const snapshot = input.request.mcp;
    await input.store.admitMcpPlan({ ok: true, snapshot, bindings: [] });
    for (const tool of snapshot.tools) {
      const server = snapshot.servers.find((candidate) => candidate.serverId === tool.serverId)!;
      allowed.set(tool.namespacedName, hashCanonicalMcpValue({ definitionHash: tool.definitionHash,
        effectiveConfiguration: server.fingerprint, toolId: tool.namespacedName }));
    }
  }
  return async (request: Request): Promise<Response> => {
    if (configuration.mcpMode === "off" && !search) return new Response(null, { status: 404 });
    let requestBodyRead = false;
    try {
      const signal = AbortSignal.any([input.signal, request.signal]);
      const bounded = new Request(request, { signal });
      const bytes = await readBoundedRequestBody(bounded, { maxBytes: getMcpRequestMaxBytes(), signal });
      requestBodyRead = true;
      const parsedBody: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return new Response(null, { status: 400 });
      const rpc = parsedBody as Record<string, unknown>;
      const deliveryId = `agent-mcp:${hashCanonicalMcpValue(rpc.id ?? null)}`;
      const execute = async (name: string, args: unknown, action: (authority: Authority) => Promise<CallToolResult>) => {
        let callId: string | null = null;
        try {
          signal.throwIfAborted();
          callId = await input.store.toolCall(name, { argumentHash: hashCanonicalMcpValue(args) }, false, deliveryId);
          const authority = { callId, userId: input.userId, async assertActive() {
            signal.throwIfAborted(); await input.store.assertActive();
          } };
          const result = await action(authority);
          await input.store.settleTool(callId, result.isError ? "error" : "complete", { status: result.isError ? "error" : "complete" });
          return result;
        } catch (error) {
          const agentCode = agentFailureCode(error);
          const code = agentCode ?? (error instanceof McpHubServiceError ? error.code : "execution_unavailable");
          const discoveryFailure = error instanceof McpHubServiceError ? error.discoveryFailure : null;
          const toolFailure = error instanceof McpHubServiceError ? error.toolFailure : null;
          const detail = { code, ...(discoveryFailure ? { discoveryFailure } : {}), ...(toolFailure ? { toolFailure } : {}) };
          if (agentCode && agentCode !== "agent_mcp_call_limit") await input.onFailure(agentCode);
          if (callId) await input.store.settleTool(callId, "error", detail).catch(() => undefined);
          if (code === "discovery_unavailable") {
            const value = { ...detail, message: `${discoveryFailure ? mcpDiscoveryFailureMessage(discoveryFailure) : "Tool discovery is unavailable."} No connected tool was called. This does not establish an authorization failure on the connected service. You may retry find_tools with a narrower goal.` };
            return { ...textResult(value, true), structuredContent: value };
          }
          if (code === "result_unsupported") {
            const value = { ...detail, message: `${toolFailure ? mcpToolFailureMessage(toolFailure) : "The MCP tool was called, but its response was too large, invalid or used unsupported content."} For a read-only query, request fewer records or fields. Do not repeat a write operation solely because its response could not be read.` };
            return { ...textResult(value, true), structuredContent: value };
          }
          return textResult({ code, message: agentCode ? agentFailureMessage(agentCode) : "The call could not complete. Do not repeat an operation whose outcome is unknown." }, true);
        }
      };
      const call = async (authority: Authority, toolId: string, toolVersion: string, args: Record<string, unknown>) => {
        if (allowed.get(toolId) !== toolVersion) throw new McpHubServiceError("tool_unavailable");
        const prepared = await service.prepareToolCall({ authority, toolId, toolVersion, arguments: args, signal });
        const result = await service.dispatchPreparedToolCall({ authority, prepared, signal });
        const content = result.text.map((text) => ({ type: "text" as const, text }));
        const structured = result.structuredContent;
        const hasStructuredData = structured && Object.keys(structured).length > 0;
        // Codex prefers any structured content, including {}, over ordinary
        // text. Keep error explanations model-visible, carrying structured
        // details alongside them without copying private payloads into receipts.
        if (result.isError && content.length > 0 && hasStructuredData) {
          content.push({ type: "text", text: JSON.stringify(structured) });
        }
        const preferStructured = content.length === 0 || !result.isError && hasStructuredData;
        return { content,
          ...(structured && preferStructured ? { structuredContent: structured } : {}),
          ...(result.isError ? { isError: true } : {}) } satisfies CallToolResult;
      };
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "aiqsa-agent", version: "1.0.0" });
        if (search) server.registerTool("aiqsa_search", { description: search.description, inputSchema: frozenSchema(search.schema) },
          (args) => execute("aiqsa_search", args, (authority) => search.execute(args as Record<string, unknown>, authority.callId, signal)));
        if (configuration.mcpMode === "auto") {
          server.registerTool("find_tools", { description: "Find a small relevant set of the chat's enabled MCP tools. Call the returned tools with call_tool.",
            inputSchema: z.strictObject({ goal: z.string().trim().min(1).max(getMcpRequestMaxBytes()) }) },
          (args) => execute("find_tools", args, async (authority) => {
            const result = await service.findTools({ authority, goal: args.goal, signal,
              timeoutMs: (input.request.toolBudgets?.mcpAutoDiscoveryTimeoutSeconds ?? 90) * 1000,
              maxResults: input.request.toolBudgets?.maxMcpToolsPerDiscovery ?? 5,
              maxOutputTokens: input.request.toolBudgets?.mcpAutoDiscoveryMaxOutputTokens });
            for (const tool of result.tools) allowed.set(tool.tool_id, tool.tool_version);
            return textResult(result);
          }));
          server.registerTool("call_tool", { description: "Call one tool returned by find_tools using its exact tool_id, tool_version and argument schema.",
            inputSchema: z.strictObject({ tool_id: z.string().min(1).max(128), tool_version: z.string().length(64), arguments: z.record(z.string(), z.unknown()) }) },
          (args) => execute(args.tool_id, args.arguments, (authority) => call(authority, args.tool_id, args.tool_version, args.arguments)));
        } else if (configuration.mcpMode === "all") {
          for (const tool of input.request.mcp?.tools ?? []) {
            server.registerTool(tool.namespacedName, { description: tool.description ?? tool.originalName,
              inputSchema: frozenSchema(tool.inputSchema) }, (args) => execute(tool.namespacedName, args,
              (authority) => call(authority, tool.namespacedName, allowed.get(tool.namespacedName)!, args as Record<string, unknown>)));
          }
        }
        return server;
      }, { legacy: "stateless", responseMode: "json" });
      const response = await handler.fetch(bounded, { parsedBody });
      if (!response.body || response.status === 204) return response;
      // Finish the bounded JSON transport before releasing the authority lease.
      // Include the accepted upstream result plus room for the gateway envelope.
      const result = await readBoundedRequestBody(new Request("http://agent.invalid/", { method: "POST", body: response.body,
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
      return Response.json({ error: "agent_mcp_unavailable" }, { status: 502 });
    }
  };
}

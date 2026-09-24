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
import { createPrismaAcceptedMcpRouter } from "../mcp/decisionRouter";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { validateMcpToolArguments } from "../mcp/clientSession";
import { normalizeMcpResultForModel } from "../mcp/resultNormalization";
import { getMcpResponseWireLimits, getMcpRequestMaxBytes, mcpRequestSizeFailure } from "../mcp/responseLimits";
import type { McpCapabilityCatalog, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { NormalizedRunRequest } from "../providers/types";
import type { createAgentRunStore } from "./store";
import { agentBuiltinTools, createAgentBuiltinDispatcher } from "./builtinTools";
import { restoreAgentMcpTools } from "./mcpResume";
import { logEvent, runWithContext } from "../observability";

type Authority = McpToolAuthority & Readonly<{ callId: string; markDispatched(): void }>;

class DiscoveryRequiredError extends McpHubServiceError {
  constructor() { super("tool_unavailable"); }
}

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
  const builtins = agentBuiltinTools(input.request);
  const dispatchBuiltin = createAgentBuiltinDispatcher(input);
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
  const allowed = new Map<string, string>();
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
    router: createPrismaAcceptedMcpRouter(prisma, { runId: input.runId, userId: input.userId }, {
      disableRequestRetries: true,
      // A speculative utility must not consume the last admitted call/token
      // allowance needed by the ordinary router. Bounded Agents keep baseline.
      decisionsEnabled: !configuration.limitsEnabled,
      async admit(snapshot) {
        // Reserve the qualified model envelope, not an invented token charge.
        // Reported usage settles the reservation; unknown work stays reserved.
        const contextWindow = snapshot.model.capabilities.contextWindow;
        if (!contextWindow || !Number.isSafeInteger(contextWindow)) throw new Error("decision_model_context_unavailable");
        const id = await input.store.reserveProvider(contextWindow, { kind: "decision", snapshot });
        return { async settle(result) {
          const usage = result.receipt?.usage;
          await input.store.settleProvider(id, result.receipt || !result.dispatched ? result.failureCode ? "ERROR" : "COMPLETE" : "UNKNOWN",
            usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens, completeness: "complete" } : null);
          await input.onUsage();
        } };
      }
    }),
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
    if (configuration.mcpMode === "off" && !search && !builtins.length) return new Response(null, { status: 404 });
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
        let dispatched = false;
        const started = Date.now();
        const observe = (failed: boolean, code?: string) => runWithContext({ run_id: input.runId,
          ...(callId ? { tool_call_id: callId } : {}) }, () => logEvent("tool_execution", {
          tool_kind: "mcp", stage: dispatched ? "result" : "admission", outcome: failed ? "failed" : "completed",
          duration_ms: Date.now() - started, ...(code ? { code } : {})
        }));
        try {
          signal.throwIfAborted();
          callId = await input.store.toolCall(name, { argumentHash: hashCanonicalMcpValue(args) }, false, deliveryId);
          const authority = { callId, discoveryOperationKey: callId, userId: input.userId,
            markDispatched() { dispatched = true; }, async assertActive() {
            signal.throwIfAborted(); await input.store.assertActive();
          } };
          const result = await runWithContext({ run_id: input.runId, tool_call_id: callId }, () => action(authority));
          await input.store.settleTool(callId, result.isError ? "error" : "complete", { status: result.isError ? "error" : "complete" });
          observe(Boolean(result.isError));
          return result;
        } catch (error) {
          const agentCode = agentFailureCode(error);
          const code = agentCode ?? (error instanceof McpHubServiceError ? error.code
            : error instanceof Error && error.message === "agent_mcp_definition_changed" ? "tool_definition_changed" : "execution_unavailable");
          const discoveryFailure = error instanceof McpHubServiceError ? error.discoveryFailure : null;
          const toolFailure = error instanceof McpHubServiceError ? error.toolFailure : null;
          const detail = { code, ...(discoveryFailure ? { discoveryFailure } : {}), ...(toolFailure ? { toolFailure } : {}) };
          if (agentCode && agentCode !== "agent_mcp_call_limit") await input.onFailure(agentCode);
          if (callId) await input.store.settleTool(callId, "error", detail).catch(() => undefined);
          observe(true, code);
          if (!dispatched && ["tool_unavailable", "tool_definition_changed", "upstream_unavailable", "invalid_arguments", "authorization_required"].includes(code)) {
            const discoveryRequired = error instanceof DiscoveryRequiredError;
            const explanation = discoveryRequired ? "This tool has not been discovered or admitted for the current turn."
              : code === "tool_definition_changed" ? "The tool definition or configuration changed; the old arguments were not executed."
                : code === "upstream_unavailable" ? "The MCP runtime is temporarily unavailable."
                  : code === "invalid_arguments" ? "The arguments do not match the admitted tool schema."
                    : "The tool is unavailable with the current settings or permissions.";
            const value = { ...detail, dispatched: false,
              ...(discoveryRequired ? { reason: "discovery_required" } : {}),
              recovery: "find_tools",
              message: `${explanation} No external tool call was sent. Run find_tools and use the returned tool version and argument schema before calling again.` };
            return { ...textResult(value, true), structuredContent: value };
          }
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
        // Gateway handlers can move between workers. PostgreSQL, not this
        // request's map, owns discovery admissions from another request.
        let current = configuration.mcpMode === "all" && allowed.has(toolId) ? { toolId, version: allowed.get(toolId)! }
          : (await input.store.mcpTools()).find(tool => tool.toolId === toolId);
        if (!current) {
          const failures = await restoreAgentMcpTools({ ...input, signal, toolId });
          if (failures.has(toolId)) throw failures.get(toolId)!;
          current = (await input.store.mcpTools()).find(tool => tool.toolId === toolId);
        }
        if (!current) throw new DiscoveryRequiredError();
        if (current.version !== toolVersion) throw new McpHubServiceError("tool_definition_changed");
        const prepared = await service.prepareToolCall({ authority, toolId, toolVersion, arguments: args, signal });
        const result = normalizeMcpResultForModel(await service.dispatchPreparedToolCall({ authority, prepared, signal, onDispatch: authority.markDispatched }));
        const content = result.text.map((text) => ({ type: "text" as const, text }));
        const structured = result.structuredContent;
        // Codex prefers any structured content, including {}, over ordinary
        // text. Preserve ALL remaining unique text, on success as well as error,
        // and carry structured data once in the same model-visible channel.
        const preferStructured = content.length === 0;
        if (structured && !preferStructured) {
          content.push({ type: "text", text: JSON.stringify(structured) });
        }
        return { content,
          ...(structured && preferStructured ? { structuredContent: structured } : {}),
          ...(result.isError ? { isError: true } : {}) } satisfies CallToolResult;
      };
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "aiqsa-agent", version: "1.0.0" });
        for (const tool of builtins) server.registerTool(tool.name, {
          description: tool.description, inputSchema: frozenSchema(tool.inputSchema)
        }, async args => {
          try {
            const result = await dispatchBuiltin({ id: deliveryId, name: tool.name, arguments: args as Record<string, unknown> }, signal);
            return { content: result.content.map(part => ({ type: "text" as const,
              text: part.type === "text" ? part.text : JSON.stringify(part.value) })),
              ...(result.status === "error" ? { isError: true } : {}) };
          } catch (error) {
            const code = agentFailureCode(error);
            if (code && code !== "agent_mcp_call_limit") await input.onFailure(code);
            return textResult({ code: code ?? "agent_builtin_unavailable",
              message: code ? agentFailureMessage(code) : "The built-in operation could not finish. Do not repeat an unconfirmed write with a new call ID." }, true);
          }
        });
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

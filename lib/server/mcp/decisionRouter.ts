import type { PrismaClient } from "@prisma/client";
import { createPrismaOptionalDecisionService, type OptionalDecisionExecutor, type OptionalDecisionAdmission } from "../providerRuntime/optionalDecision";
import { createAcceptedStructuredOutputSnapshotExecutor } from "../providerRuntime/structuredOutputExecutor";
import { buildMcpDecisionPlan, mcpDecisionSelection, MCP_DECISION_POLICY_VERSION } from "./decisionPolicy";
import { loadAcceptedMcpRoutingBindings } from "./decisionBinding";
import { createMcpSemanticRouter, McpSemanticRouterError, type McpSemanticRouter } from "./router";

export function createAcceptedMcpDecisionRouter(deps: Readonly<{
  owner: Readonly<{ runId: string; userId: string }>;
  bindings(): ReturnType<typeof loadAcceptedMcpRoutingBindings>;
  baseline(bindings: Awaited<ReturnType<typeof loadAcceptedMcpRoutingBindings>>): McpSemanticRouter;
  decide: OptionalDecisionExecutor;
  authorize(operationKey: string): Promise<void>;
  admit?: OptionalDecisionAdmission;
  decisionsEnabled?: boolean;
}>): McpSemanticRouter {
  return {
    async route(input) {
      const started = Date.now();
      input.signal?.throwIfAborted();
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647)) {
        throw new McpSemanticRouterError("mcp_router_request_failed");
      }
      const bindings = await deps.bindings();
      const plan = deps.decisionsEnabled !== false && bindings.decision && input.decisionOperationKey ? buildMcpDecisionPlan(input) : null;
      if (plan && bindings.decision && input.decisionOperationKey) {
        const key = input.decisionOperationKey;
        const answers = await deps.decide({
          owner: { ...deps.owner, purpose: "mcp_discovery", operationKey: key },
          evidence: bindings.decision, policy: MCP_DECISION_POLICY_VERSION, request: plan.request, signal: input.signal,
          ...(deps.admit ? { admit: deps.admit } : {}), timeoutMs: input.timeoutMs,
          async authorize() { await deps.authorize(key); await input.beforeDispatch?.(); }
        });
        input.signal?.throwIfAborted();
        const selection = answers ? mcpDecisionSelection(plan, { answers }) : null;
        if (selection) return { toolNames: [...selection], usageAttribution: null }; // Usage has its own durable row.
      }
      const timeoutMs = input.timeoutMs === undefined ? undefined : input.timeoutMs - (Date.now() - started);
      if (timeoutMs !== undefined && timeoutMs < 1) throw new McpSemanticRouterError("mcp_router_timeout");
      return deps.baseline(bindings).route({ ...input, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    }
  };
}

export function createPrismaAcceptedMcpRouter(db: PrismaClient, owner: Readonly<{ runId: string; userId: string }>,
  options: Readonly<{ admit?: OptionalDecisionAdmission; disableRequestRetries?: true; decisionsEnabled?: boolean }> = {}
): McpSemanticRouter {
  const execute = createAcceptedStructuredOutputSnapshotExecutor(db, options);
  return createAcceptedMcpDecisionRouter({ owner,
    bindings: () => loadAcceptedMcpRoutingBindings(db, owner),
    baseline: bindings => createMcpSemanticRouter({ resolveSystemModel: async () => bindings.system,
      executeStructuredOutput: (role, request, options) => execute(role.snapshot, request, options) }),
    decide: createPrismaOptionalDecisionService(db),
    ...(options.admit ? { admit: options.admit } : {}),
    decisionsEnabled: options.decisionsEnabled,
    async authorize(operationKey) {
      const call = await db.modelRunToolCall.findFirst({ where: { id: operationKey, modelRunId: owner.runId,
        toolName: "find_tools", state: { in: ["pending", "running"] },
        modelRun: { userId: owner.userId, status: { in: ["in_progress", "streaming"] } }
      }, select: { id: true } });
      if (!call) throw new Error("mcp_discovery_authority_unavailable");
    }
  });
}

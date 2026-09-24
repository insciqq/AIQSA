import { MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { mcpCatalogToolsByNames } from "../mcp/discovery";
import { materializeMcpSelection } from "../mcp/discoveryService";
import { McpHubServiceError } from "../mcp/hubService";
import { filterMcpCatalog } from "../mcp/toolAccessProjection";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import { logEvent, runWithContext } from "../observability";
import type { NormalizedRunRequest } from "../providers/types";
import type { createAgentRunStore } from "./store";

type Store = Pick<ReturnType<typeof createAgentRunStore>, "assertActive" | "resumedMcpTools" | "admitMcpPlan"> & {
  mcpTools(): PromiseLike<{ toolId: string; version: string }[]>;
};

/** Restores only fresh admissions, never bearer tokens, receipts or business calls. */
export async function restoreAgentMcpTools(input: Readonly<{
  request: NormalizedRunRequest; runId: string; userId: string; store: Store; signal: AbortSignal;
  toolId?: string;
}>, runtime = defaultMcpRunPlan): Promise<Map<string, McpHubServiceError>> {
  const failures = new Map<string, McpHubServiceError>();
  if (input.request.agent?.mcpMode !== "auto" || !input.request.mcpDiscovery) return failures;
  const assertActive = async () => { input.signal.throwIfAborted(); await input.store.assertActive(); };
  await assertActive();
  const admitted = new Set((await input.store.mcpTools()).map(tool => tool.toolId));
  const candidates = (await input.store.resumedMcpTools()).filter(tool => !admitted.has(tool.toolId) &&
    (!input.toolId || tool.toolId === input.toolId)).slice(0, MCP_RUN_PLAN_LIMITS.maxTools);
  for (const candidate of candidates) {
    await assertActive();
    const started = Date.now();
    try {
      // Intersect the accepted selection with current permissions and server
      // configuration. A previously visible identifier reveals no new schema.
      const catalog = await filterMcpCatalog(input.userId, input.request.mcpDiscovery.catalog, runtime.filterTools);
      const selected = mcpCatalogToolsByNames(catalog, [candidate.toolId]);
      if (!selected.length) throw new McpHubServiceError("tool_unavailable");
      const current = mcpCatalogToolsByNames(await runtime.catalog(input.userId), [candidate.toolId])[0];
      if (!current || current.serverId !== selected[0]!.serverId) throw new McpHubServiceError("tool_unavailable");
      if (current.revisionId !== selected[0]!.revisionId) throw new McpHubServiceError("tool_definition_changed");
      const plan = await materializeMcpSelection({ userId: input.userId, selected, signal: input.signal,
        materialize: runtime.materialize });
      const route = resolveMcpRunTool(plan.snapshot, candidate.toolId);
      if (!route) throw new McpHubServiceError("tool_unavailable");
      const version = hashCanonicalMcpValue({ definitionHash: route.tool.definitionHash,
        effectiveConfiguration: route.fingerprint, toolId: candidate.toolId });
      if (version !== candidate.version) throw new McpHubServiceError("tool_definition_changed");
      const stillAllowed = await filterMcpCatalog(input.userId, catalog, runtime.filterTools);
      if (!mcpCatalogToolsByNames(stillAllowed, [candidate.toolId]).length) throw new McpHubServiceError("tool_unavailable");
      await assertActive();
      await input.store.admitMcpPlan(plan);
      runWithContext({ run_id: input.runId }, () => logEvent("tool_execution", {
        tool_kind: "mcp", stage: "admission", outcome: "completed", duration_ms: Date.now() - started, count: 1
      }));
    } catch (error) {
      // Candidate failures are optional; loss of the run itself is terminal.
      await assertActive();
      const failure = error instanceof McpHubServiceError ? error : new McpHubServiceError("upstream_unavailable");
      failures.set(candidate.toolId, failure);
      runWithContext({ run_id: input.runId }, () => logEvent("tool_execution", {
        tool_kind: "mcp", stage: "admission", outcome: "failed", code: failure.code, duration_ms: Date.now() - started
      }));
    }
  }
  return failures;
}

import type { PrismaClient } from "@prisma/client";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import { createMcpGuardPlanResolver, type AcceptedMcpGuardPlan } from "../providerRuntime/mcpGuardPlan";
import { createAcceptedStructuredOutputSnapshotExecutor } from "../providerRuntime/structuredOutputExecutor";
import { logEvent } from "../observability";
import { reportedAnswerCost } from "../runs/usagePricing";
import { collectMcpGuardUsage } from "./guardUsage";
import { decodeMcpGuardVerdict, MCP_GUARD_LIMITS, mcpGuardRequest,
  type McpGuardToolInput, type McpGuardVerdict } from "./guardPrompt";

import { freezeGuardAuthority, readGuardAuthority, type GuardAuthorityInput, type McpGuardAdmission } from "./guardAuthority";
export type { McpGuardAdmission } from "./guardAuthority";
export const MCP_GUARD_TOO_LONG_REASON = "The conversation is too long for the automatic check. Please review this call.";
export const MCP_GUARD_UNAVAILABLE_REASON = "The automatic check could not verify this call. Please review it before allowing it.";
export const mcpGuardAsk = (): McpGuardVerdict => ({ decision: "ask", reason: MCP_GUARD_UNAVAILABLE_REASON });
export type McpGuardCheck = (input: Readonly<{ admission: McpGuardAdmission; tool: McpGuardToolInput;
  runId: string; userId: string; signal?: AbortSignal }>) => Promise<McpGuardVerdict>;

export function createMcpGuardService(db: PrismaClient, options: Readonly<{
  resolve?: () => Promise<AcceptedMcpGuardPlan>;
  execute?: ReturnType<typeof createAcceptedStructuredOutputSnapshotExecutor>;
  collectUsage?: typeof collectMcpGuardUsage;
  timeoutMs?: number;
}> = {}) {
  const resolve = options.resolve ?? createMcpGuardPlanResolver(db);
  const execute = options.execute ?? createAcceptedStructuredOutputSnapshotExecutor(db, { disableRequestRetries: true });
  return {
    async admit(input: GuardAuthorityInput): Promise<McpGuardAdmission | undefined> {
      const unavailable = (plan: AcceptedMcpGuardPlan): McpGuardAdmission => ({ version: 2, plan, messages: [], unavailable: true });
      try {
        const plan = await resolve();
        if (!plan.available) return plan.code === "mcp_guard_model_absent" ? undefined : unavailable(plan);
        return await freezeGuardAuthority(db, input, plan);
      } catch {
        logEvent("service_operation", { action: "degrade", code: "mcp_guard_admission_unavailable", outcome: "degraded", subsystem: "mcp", stage: "prepare" });
        return unavailable({ version: 1, available: false, code: "mcp_guard_model_unavailable" });
      }
    },
    async check(input: Parameters<McpGuardCheck>[0]): Promise<McpGuardVerdict> {
      const fail = (code: string) => {
        logEvent("tool_execution", { tool_kind: "mcp", code, outcome: "failed", stage: "admission" });
        return mcpGuardAsk();
      };
      const { plan } = input.admission;
      if (!plan.available) return fail("mcp_guard_unavailable");
      const timeout = new AbortController();
      const timeoutMs = options.timeoutMs ?? MCP_GUARD_LIMITS.timeoutMs;
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      timer.unref?.();
      const signal = AbortSignal.any([timeout.signal, ...(input.signal ? [input.signal] : [])]);
      let usage = normalizeTokenUsage({});
      let reported = false;
      let costUsd: number | undefined;
      let abort: (() => void) | undefined;
      try {
        const work = async () => {
          const authority = await readGuardAuthority(db, input);
          signal.throwIfAborted();
          if (!authority.ok) {
            if (authority.code !== "too_long") return fail("mcp_guard_authority_unavailable");
            fail("mcp_guard_conversation_too_long");
            return { decision: "ask" as const, reason: MCP_GUARD_TOO_LONG_REASON };
          }
          const request = mcpGuardRequest(authority.messages, input.tool, plan.reasoningEffort);
          if (!request) return fail("mcp_guard_input_oversize");
          try {
            const result = await execute(plan.snapshot, request, { signal, timeoutMs,
              onUsage(update) { reported = true; usage = mergeTokenUsage(usage, update); }, onCostUsd(value) { costUsd = value; } });
            signal.throwIfAborted();
            return decodeMcpGuardVerdict(result) ?? fail("mcp_guard_output_invalid");
          } finally {
            // The transport may finish after the verdict timed out. Collect only once it
            // settles so late provider-reported usage reaches the detached writer too.
            if (reported || costUsd !== undefined) {
              try { (options.collectUsage ?? collectMcpGuardUsage)(input.runId, { provider: plan.snapshot.providerFamily,
                modelId: plan.snapshot.model.upstreamModelId, providerModelId: plan.snapshot.providerModelId,
                purpose: "mcp_guard", usage, ...reportedAnswerCost(costUsd) }); } catch { /* Accounting cannot change a verdict. */ }
            }
          }
        };
        signal.throwIfAborted();
        return await Promise.race([work(), new Promise<never>((_, reject) => {
          abort = () => reject(new Error("mcp_guard_cancelled"));
          signal.addEventListener("abort", abort, { once: true });
        })]);
      } catch { return fail(timeout.signal.aborted ? "mcp_guard_timeout" : input.signal?.aborted ? "mcp_guard_cancelled" : "mcp_guard_failed"); }
      finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
      }
    }
  };
}
export type McpGuardService = ReturnType<typeof createMcpGuardService>;

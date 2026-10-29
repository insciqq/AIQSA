import type { PrismaClient } from "@prisma/client";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import { createMcpGuardPlanResolver, type AcceptedMcpGuardPlan } from "../providerRuntime/mcpGuardPlan";
import { createAcceptedStructuredOutputSnapshotExecutor } from "../providerRuntime/structuredOutputExecutor";
import type { ProviderConversationMessage } from "../providers/types";
import { logEvent } from "../observability";
import { reportedAnswerCost } from "../runs/usagePricing";
import { collectMcpGuardUsage } from "./guardUsage";
import { boundedMcpGuardMessages, decodeMcpGuardVerdict, MCP_GUARD_LIMITS, mcpGuardRequest,
  type McpGuardToolInput, type McpGuardVerdict } from "./guardPrompt";

export type McpGuardAdmission = Readonly<{ approvedBy?: string; plan: AcceptedMcpGuardPlan; userMessages: readonly string[] | null }>;
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
    async admit(input: Readonly<{ chatId: string; userId: string; messages: readonly ProviderConversationMessage[];
      currentMessage?: string }>): Promise<McpGuardAdmission | undefined> {
      const unavailable = (): McpGuardAdmission => ({ plan: { version: 1, available: false, code: "mcp_guard_model_unavailable" }, userMessages: null });
      try {
        const plan = await resolve();
        if (!plan.available) return plan.code === "mcp_guard_model_absent" ? undefined : { plan, userMessages: null };
        const branch = input.messages.filter(message => message.role === "user" && !message.purpose && message.id !== "current-user-message").reverse();
        if (branch.length > MCP_GUARD_LIMITS.messages) return { plan, userMessages: null };
        const ids = branch.map(message => message.id);
        // Read original user text, never model-facing attachment/Skill enrichment, and prove authorship.
        const [messages, followups] = await Promise.all([
          // Historical personal sends have no per-message author. Their owner-private,
          // non-imported chat proves authorship; an imported transcript never does.
          db.message.findMany({ where: { id: { in: ids }, chatId: input.chatId,
            OR: [{ authorUserId: input.userId }, { authorUserId: null, chat: { userId: input.userId, importSource: null } }],
            role: "user", scheduledTaskPrompt: false, systemTurnKind: null, answerReviewSessionId: null }, select: { id: true, content: true } }),
          db.runFollowup.findMany({ where: { id: { in: ids }, authorUserId: input.userId,
            modelRun: { chatId: input.chatId, userId: input.userId } }, select: { id: true, text: true } })
        ]);
        const texts = new Map([...messages.map(row => [row.id, textFromContentBlocks(row.content as { blocks?: unknown[] })] as const),
          ...followups.map(row => [row.id, row.text] as const)]);
        // A copied follow-up whose original authorship cannot be proved may be a correction;
        // do not silently drop it and authorize from an earlier message instead.
        if (branch.some(message => message.followupOf && !texts.has(message.id))) return { plan, userMessages: null };
        const userMessages = [...(input.currentMessage === undefined ? [] : [input.currentMessage]),
          ...ids.flatMap(id => texts.has(id) ? [texts.get(id)!] : [])];
        return { plan, userMessages: boundedMcpGuardMessages(userMessages) };
      } catch {
        logEvent("service_operation", { action: "degrade", code: "mcp_guard_admission_unavailable", outcome: "degraded", subsystem: "mcp", stage: "prepare" });
        return unavailable();
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
          // Only delivered, owner-authored follow-ups of this run extend its authority.
          const followups = await db.runFollowup.findMany({ where: { modelRunId: input.runId, authorUserId: input.userId,
            deliveredAt: { not: null }, modelRun: { userId: input.userId } }, orderBy: { ordinal: "desc" },
            select: { text: true }, take: MCP_GUARD_LIMITS.messages + 1 });
          signal.throwIfAborted();
          const messages = input.admission.userMessages;
          const request = mcpGuardRequest(messages && [...followups.map(row => row.text), ...messages], input.tool, plan.reasoningEffort);
          if (!request) return fail("mcp_guard_input_oversize");
          const result = await execute(plan.snapshot, request, { signal, timeoutMs,
            onUsage(update) { reported = true; usage = mergeTokenUsage(usage, update); }, onCostUsd(value) { costUsd = value; } });
          signal.throwIfAborted();
          return decodeMcpGuardVerdict(result) ?? fail("mcp_guard_output_invalid");
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
        if (reported || costUsd !== undefined) {
          try { (options.collectUsage ?? collectMcpGuardUsage)(input.runId, { provider: plan.snapshot.providerFamily,
            modelId: plan.snapshot.model.upstreamModelId, providerModelId: plan.snapshot.providerModelId,
            purpose: "mcp_guard", usage, ...reportedAnswerCost(costUsd) }); } catch { /* Accounting cannot change a verdict. */ }
        }
      }
    }
  };
}
export type McpGuardService = ReturnType<typeof createMcpGuardService>;

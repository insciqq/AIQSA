import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeTokenUsage, normalizeTokenUsage } from "@/lib/domain/usage";
import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { json, lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import type { McpRunPlanResult } from "../mcp/runPlan";
import { AGENT_GRANT_LEASE_MS, type NormalizedRunAgent } from "./config";
import { AgentExecutionError, agentFailureCode, type AgentFailureCode } from "./failures";

export function agentTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const ACTIVE = ["queued", "in_progress", "streaming"] as const;

/** Raw bearer exists only in the live executor and guest; persistence keeps its hash. */
export function createAgentRunStore(database: PrismaClient, input: Readonly<{
  runId: string;
  userId: string;
  configuration: NormalizedRunAgent;
}>) {
  const { runId, userId, configuration } = input;
  const assertActive = async (tx: Prisma.TransactionClient = database) => {
    const now = new Date();
    const binding = await tx.agentRunBinding.findFirst({ where: {
      modelRunId: runId, revokedAt: null, completedAt: null,
      leaseExpiresAt: { gt: now },
      workspaceRun: { modelRun: { userId, status: { in: [...ACTIVE] }, chat: { user: { status: "active" } } } }
    } });
    if (!binding || hashCanonicalMcpValue(binding.configuration) !== hashCanonicalMcpValue(configuration)) {
      throw new Error("agent_authority_expired");
    }
    if (binding.failureCode) throw new AgentExecutionError(agentFailureCode(binding.failureCode) ?? "agent_execution_interrupted");
    if (binding.expiresAt && binding.expiresAt <= now) throw new AgentExecutionError("agent_time_limit");
    return binding;
  };
  const locked = async <T>(action: (tx: Prisma.TransactionClient) => Promise<T>) => database.$transaction(async (tx) => {
    await lockRunSettlementScope(tx, runId);
    await tx.$queryRaw`SELECT "modelRunId" FROM "AgentRunBinding" WHERE "modelRunId" = ${runId} FOR UPDATE`;
    return action(tx);
  });

  return {
    async failure() {
      const binding = await database.agentRunBinding.findUnique({ where: { modelRunId: runId }, select: { failureCode: true } });
      return agentFailureCode(binding?.failureCode);
    },
    async fail(code: AgentFailureCode) {
      // A transport cancellation can arrive before the executor observes its
      // deadline. Preserve the expired budget as the cause in that race.
      await database.agentRunBinding.updateMany({ where: { modelRunId: runId, failureCode: null,
        expiresAt: { lte: new Date() } }, data: { failureCode: "agent_time_limit" } });
      await database.agentRunBinding.updateMany({ where: { modelRunId: runId, failureCode: null }, data: { failureCode: code } });
    },
    assertActive: async () => { await assertActive(); },
    async arm(previousAssistantMessageId: string | null) {
      const token = randomBytes(32).toString("base64url");
      return locked(async (tx) => {
        const binding = await tx.agentRunBinding.findUnique({ where: { modelRunId: runId },
          include: { workspaceRun: { include: { workspaceSession: true, modelRun: true } } } });
        if (!binding || binding.startedAt || binding.revokedAt ||
          binding.workspaceRun.modelRun.userId !== userId ||
          !ACTIVE.some((state) => state === binding.workspaceRun.modelRun.status) ||
          hashCanonicalMcpValue(binding.configuration) !== hashCanonicalMcpValue(configuration)) {
          throw new Error("agent_binding_invalid");
        }
        const previous = previousAssistantMessageId && binding.workspaceRun.workspaceSession.runtimeSandboxId
          ? await tx.agentRunBinding.findFirst({ where: {
              compatibilityHash: configuration.compatibilityHash, completedAt: { not: null }, threadId: { not: null },
              workspaceRun: { workspaceSessionId: binding.workspaceRun.workspaceSessionId,
                modelRun: { userId, assistantMessageId: previousAssistantMessageId, status: "complete" } }
            } }) : null;
        const now = new Date();
        await tx.agentRunBinding.update({ where: { modelRunId: runId }, data: {
          tokenHash: agentTokenHash(token), startedAt: now,
          expiresAt: configuration.timeoutSeconds === null ? null : new Date(now.getTime() + configuration.timeoutSeconds * 1000),
          leaseExpiresAt: new Date(now.getTime() + AGENT_GRANT_LEASE_MS),
          resumedFromRunId: previous?.modelRunId ?? null
        } });
        return { token, threadId: previous?.threadId ?? undefined };
      });
    },
    async renew() {
      await locked(async (tx) => {
        await assertActive(tx);
        await tx.agentRunBinding.update({ where: { modelRunId: runId },
          data: { leaseExpiresAt: new Date(Date.now() + AGENT_GRANT_LEASE_MS) } });
      });
    },
    async setThread(threadId: string) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(threadId)) {
        throw new Error("agent_protocol_invalid");
      }
      await locked(async (tx) => {
        const current = await assertActive(tx);
        if (current.threadId && current.threadId !== threadId) throw new Error("agent_protocol_invalid");
        await tx.agentRunBinding.update({ where: { modelRunId: runId }, data: { threadId } });
      });
    },
    async revoke(completed: boolean) {
      await locked(async (tx) => {
        await tx.agentRunBinding.updateMany({ where: { modelRunId: runId, revokedAt: null },
          data: { revokedAt: new Date(), ...(completed ? { completedAt: new Date() } : {}) } });
        // A restart/abort cannot imply that a dispatched physical operation did not execute.
        await tx.agentProviderAttempt.updateMany({ where: { modelRunId: runId, state: "DISPATCHED" },
          data: { state: "UNKNOWN", completedAt: new Date() } });
      });
    },
    drain: () => drainAgentRequests(database, runId),
    async reserveProvider(reservedTokens: number, utility?:
      | Readonly<{ kind: "native_search" }>
      | Readonly<{ kind: "aiqsa_search"; optionId: string; invocationId: string; maxCalls: number }>
      | Readonly<{ kind: "discovery"; role: ProviderAdmissionRole }>) {
      if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1) throw new Error("agent_budget_invalid");
      const result = await locked(async (tx) => {
        const current = await assertActive(tx);
        const failureCode = !configuration.limitsEnabled ? null
          : current.modelCalls >= configuration.maxModelCalls ? "agent_model_call_limit" as const
          : current.reservedTokens + BigInt(reservedTokens) > BigInt(configuration.tokenBudget) ? "agent_token_limit" as const : null;
        if (failureCode) {
          // Commit the cause before throwing; a thrown transaction would lose it.
          await tx.agentRunBinding.updateMany({ where: { modelRunId: runId, failureCode: null }, data: { failureCode } });
          return { failureCode };
        }
        if (utility?.kind === "aiqsa_search") {
          const calls = await tx.agentProviderAttempt.findMany({
            where: { modelRunId: runId, searchOptionId: utility.optionId },
            distinct: ["searchInvocationId"], select: { searchInvocationId: true }
          });
          if (!calls.some((call) => call.searchInvocationId === utility.invocationId) && calls.length >= utility.maxCalls) {
            throw new Error("search_invocation_limit_reached");
          }
        }
        if (!utility && current.providerInFlight) throw new Error("agent_provider_busy");
        const id = randomUUID();
        const bindingKey = utility ? `agent-${utility.kind}:${id}` : "answer";
        if (utility?.kind === "native_search" || utility?.kind === "aiqsa_search") {
          // Codex can execute a search before generation's terminal event.
          // Bind its own receipt to the exact answer tuple, without releasing
          // or contending for the generation-in-flight slot.
          const answer = await tx.providerRunBinding.findUniqueOrThrow({ where: {
            modelRunId_bindingKey: { modelRunId: runId, bindingKey: utility.kind === "aiqsa_search" ? `search:${utility.optionId}` : "answer" }
          }, select: { connectionId: true, providerModelId: true, credentialId: true,
            credentialVersionId: true, credentialSource: true, executionSnapshot: true } });
          await tx.providerRunBinding.create({ data: { ...answer, executionSnapshot: json(answer.executionSnapshot),
            modelRunId: runId, bindingKey, role: "search" } });
        } else if (utility?.kind === "discovery") {
          const { role } = utility;
          const snapshot = role.snapshot;
          await tx.providerRunBinding.create({ data: {
            modelRunId: runId, bindingKey, role: "search", executionSnapshot: json(snapshot),
            connectionId: snapshot.connectionId, providerModelId: snapshot.providerModelId,
            credentialId: snapshot.credentialId, credentialVersionId: snapshot.credentialVersionId,
            credentialSource: role.credentialSource
          } });
        }
        await tx.agentProviderAttempt.create({ data: { id, modelRunId: runId, providerBindingKey: bindingKey, reservedTokens,
          ...(utility?.kind === "aiqsa_search" ? { searchOptionId: utility.optionId, searchInvocationId: utility.invocationId } : {}) } });
        await tx.agentRunBinding.update({ where: { modelRunId: runId }, data: {
          modelCalls: { increment: 1 }, reservedTokens: { increment: reservedTokens },
          ...(!utility ? { providerInFlight: true } : {})
        } });
        return { id };
      });
      if (result.failureCode) throw new AgentExecutionError(result.failureCode);
      return result.id!;
    },
    async settleProvider(id: string, state: "COMPLETE" | "ERROR" | "UNKNOWN", usage: ModelRunUsage | null) {
      await locked(async (tx) => {
        const attempt = await tx.agentProviderAttempt.findFirst({ where: { id, modelRunId: runId } });
        if (!attempt || (attempt.state !== "DISPATCHED" && attempt.state !== "UNKNOWN")) return;
        const reported = normalizeTokenUsage(usage ?? {});
        const canRelease = attempt.state === "DISPATCHED" && state !== "UNKNOWN" && reported.completeness === "complete";
        // Reservation is a safety ceiling, never synthetic usage or cost.
        const consumed = canRelease ? reported.totalTokens! : attempt.reservedTokens;
        await tx.agentProviderAttempt.update({ where: { id }, data: {
          state: attempt.state === "UNKNOWN" ? "UNKNOWN" : state,
          usage: json(reported), completedAt: new Date()
        } });
        await tx.agentRunBinding.update({ where: { modelRunId: runId }, data: {
          reservedTokens: { increment: consumed - attempt.reservedTokens },
          ...(attempt.providerBindingKey === "answer" ? { providerInFlight: false } : {})
        } });
      });
    },
    async toolCall(toolName: string, args: unknown, workspace = false, deliveryId?: string) {
      const result = await locked(async (tx) => {
        const current = await assertActive(tx);
        const exhausted = !workspace && configuration.limitsEnabled && current.toolCalls >= configuration.maxToolCalls;
        if (!workspace && !exhausted && await tx.modelRunToolCall.count({ where: {
          modelRunId: runId, state: "pending", workspaceRunBindingId: null
        } }) >= 4) throw new Error("agent_mcp_busy");
        const id = randomUUID();
        await tx.modelRunToolCall.create({ data: {
          id, modelRunId: runId, providerCallId: deliveryId ?? id, roundIndex: 0, ordinal: current.nextToolOrdinal,
          toolName, arguments: json(args), startedAt: new Date(),
          ...(workspace ? { workspaceRunBindingId: runId } : {}),
          ...(exhausted ? { state: "error", completedAt: new Date(), result: json({ code: "agent_mcp_call_limit" }) } : {})
        } });
        await tx.agentRunBinding.update({ where: { modelRunId: runId }, data: {
          nextToolOrdinal: { increment: 1 }, ...(!workspace && !exhausted ? { toolCalls: { increment: 1 } } : {})
        } });
        return { id, exhausted };
      });
      if (result.exhausted) throw new AgentExecutionError("agent_mcp_call_limit");
      return result.id;
    },
    async attachMcpCall(id: string, toolId: string) {
      await locked(async (tx) => {
        await assertActive(tx);
        const grant = await tx.agentMcpTool.findUnique({ where: { modelRunId_toolId: { modelRunId: runId, toolId } } });
        if (!grant) throw new Error("agent_mcp_binding_invalid");
        const snapshot = grant.snapshot as unknown as Extract<McpRunPlanResult, { ok: true }>["snapshot"];
        const route = resolveMcpRunTool(snapshot, toolId);
        if (!route) throw new Error("agent_mcp_binding_invalid");
        const binding = await tx.mcpRunBinding.findUnique({ where: { modelRunId_runtimeGenerationFingerprint: {
          modelRunId: runId, runtimeGenerationFingerprint: route.fingerprint
        } } });
        if (!binding) throw new Error("agent_mcp_binding_invalid");
        const changed = await tx.modelRunToolCall.updateMany({ where: { id, modelRunId: runId, state: "pending" },
          data: { mcpRunBindingId: binding.id } });
        if (changed.count !== 1) throw new Error("agent_mcp_binding_invalid");
      });
    },
    async settleTool(id: string, state: "complete" | "error", result: unknown) {
      await database.modelRunToolCall.updateMany({ where: { id, modelRunId: runId, state: "pending" },
        data: { state, result: json(result), completedAt: new Date() } });
    },
    async admitMcpPlan(plan: Extract<McpRunPlanResult, { ok: true }>) {
      await locked(async (tx) => {
        await assertActive(tx);
        for (const tool of plan.snapshot.tools) {
          const route = resolveMcpRunTool(plan.snapshot, tool.namespacedName);
          if (!route) throw new Error("agent_mcp_binding_invalid");
          const version = hashCanonicalMcpValue({ definitionHash: route.tool.definitionHash,
            effectiveConfiguration: route.fingerprint, toolId: tool.namespacedName });
          const current = await tx.agentMcpTool.findUnique({ where: { modelRunId_toolId: { modelRunId: runId, toolId: tool.namespacedName } } });
          if (current && current.version !== version) throw new Error("agent_mcp_definition_changed");
          if (!current) await tx.agentMcpTool.create({ data: {
            modelRunId: runId, toolId: tool.namespacedName, version, snapshot: json(plan.snapshot)
          } });
        }
        for (const binding of plan.bindings) {
          const existing = await tx.mcpRunBinding.findUnique({ where: { modelRunId_runtimeGenerationFingerprint: {
            modelRunId: runId, runtimeGenerationFingerprint: binding.fingerprint
          } } });
          if (existing && existing.runtimeGenerationId !== binding.runtimeGenerationId) throw new Error("agent_mcp_binding_invalid");
          await tx.mcpRunBinding.upsert({ where: { modelRunId_runtimeGenerationFingerprint: {
            modelRunId: runId, runtimeGenerationFingerprint: binding.fingerprint
          } }, create: { modelRunId: runId, runtimeGenerationId: binding.runtimeGenerationId,
            runtimeGenerationFingerprint: binding.fingerprint }, update: {} });
        }
      });
    },
    mcpTools: () => database.agentMcpTool.findMany({ where: { modelRunId: runId }, select: { toolId: true, version: true } }),
    usage: () => loadAgentUsage(database, runId)
  };
}

export async function loadAgentUsage(database: Pick<Prisma.TransactionClient, "agentProviderAttempt">, runId: string): Promise<RunUsageAttribution[]> {
  const attempts = await database.agentProviderAttempt.findMany({ where: { modelRunId: runId },
    include: { providerBinding: { select: { executionSnapshot: true } } }, orderBy: { createdAt: "asc" } });
  return attempts.map((attempt) => {
    const snapshot = normalizeProviderExecutionSnapshot(attempt.providerBinding.executionSnapshot);
    return { providerModelId: snapshot.providerModelId,
      provider: snapshot.providerFamily, modelId: snapshot.model.upstreamModelId, operationCount: 1,
      usage: decodeTokenUsage(attempt.usage) ?? normalizeTokenUsage({}) };
  });
}

async function drainAgentRequests(database: PrismaClient, runId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const binding = await database.agentRunBinding.findUnique({ where: { modelRunId: runId }, select: { providerInFlight: true } });
    if (!binding?.providerInFlight) return;
    await sleep(100);
  }
}

/** A lost executor terminates the turn. Never replay Codex or its MCP effects. */
export async function interruptExpiredAgentRun(database: PrismaClient, input: {
  runId: string; userId: string; now: Date;
}): Promise<{ kind: "not_agent" } | { kind: "active" } | { kind: "interrupted"; failureCode: AgentFailureCode; usage: RunUsageAttribution[] }> {
  const result = await database.$transaction(async (tx) => {
    await lockRunSettlementScope(tx, input.runId);
    await tx.$queryRaw`SELECT "modelRunId" FROM "AgentRunBinding" WHERE "modelRunId" = ${input.runId} FOR UPDATE`;
    const binding = await tx.agentRunBinding.findFirst({ where: { modelRunId: input.runId,
      workspaceRun: { modelRun: { userId: input.userId } } } });
    if (!binding) return "not_agent" as const;
    const cutoff = input.now.getTime() - AGENT_GRANT_LEASE_MS;
    if ((!binding.revokedAt && !binding.failureCode && binding.leaseExpiresAt && binding.leaseExpiresAt > input.now &&
      (!binding.expiresAt || binding.expiresAt > input.now)) ||
      (!binding.startedAt && binding.createdAt.getTime() > cutoff) ||
      (binding.completedAt && binding.completedAt.getTime() > cutoff)) return "active" as const;
    await tx.agentRunBinding.updateMany({ where: { modelRunId: input.runId, revokedAt: null }, data: { revokedAt: input.now } });
    await tx.agentRunBinding.updateMany({ where: { modelRunId: input.runId, failureCode: null }, data: {
      failureCode: binding.expiresAt && binding.expiresAt <= input.now ? "agent_time_limit" : "agent_execution_interrupted"
    } });
    await tx.agentProviderAttempt.updateMany({ where: { modelRunId: input.runId, state: "DISPATCHED" },
      data: { state: "UNKNOWN", completedAt: input.now } });
    await tx.modelRunToolCall.updateMany({ where: { modelRunId: input.runId, state: "pending" },
      data: { state: "error", completedAt: input.now, result: json({ code: "agent_execution_interrupted", outcome: "unknown" }) } });
    return "interrupted" as const;
  });
  if (result !== "interrupted") return { kind: result };
  await drainAgentRequests(database, input.runId);
  const binding = await database.agentRunBinding.findUnique({ where: { modelRunId: input.runId }, select: { failureCode: true } });
  return { kind: "interrupted", failureCode: agentFailureCode(binding?.failureCode) ?? "agent_execution_interrupted",
    usage: await loadAgentUsage(database, input.runId) };
}

import { Prisma, type PrismaClient } from "@prisma/client";
import { estimateCostMicros, normalizeTokenUsage, type TokenUsage } from "../../domain/usage";
import { storedTokenUsage } from "../usage";
import { resolveChatAccess } from "../projects/access";
import { lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import type { ToolLoopJsonValue } from "../runs/toolLoopPersistence";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ANALYZE_IMAGE_TOOL_NAME, VISION_ANALYSIS_LIMITS } from "../tools/analyzeImage";
import { hashCanonicalMcpValue } from "../mcp/definitions";

export type VisionExecutionHooks = {
  beforeDispatch?: () => Promise<void>;
  assertDispatch?: (tx: Prisma.TransactionClient) => Promise<void>;
  beforeSettlement?: (tx: Prisma.TransactionClient) => Promise<void>;
  onResult?: (tx: Prisma.TransactionClient, result: ToolExecutionResult) => Promise<void>;
};
/** Constructed at the confirmed local Vision boundary, never from provider prose. */
export class VisionAnalysisError extends Error {
  constructor(readonly code: string) { super(code); this.name = "VisionAnalysisError"; }
}
export type VisionAttemptContext = { runId: string; userId: string; chatId: string; toolCallId: string; call: ModelToolCall; requestHash: string };
export function visionFailure(call: ModelToolCall, code: string, unknown = code === "vision_analysis_outcome_unknown"): ToolExecutionResult {
  return { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: {
    error: code, provenance: "System Vision Model", ...(unknown ? { provider_outcome: "unknown" } : {}), hint: unknown
      ? "The provider outcome is unknown. Do not repeat this paid analysis."
      : "No successful visual analysis is available. Resolve this capability, input or access error before continuing."
  } }] };
}
export async function authorizeVisionPlan(db: Pick<Prisma.TransactionClient, "providerModel" | "providerCredentialVersion">, plan: AvailableVisionAnalysisPlan) {
  const [model, credential] = await Promise.all([
    db.providerModel.findFirst({ where: { id: plan.authority.providerModelId, connectionId: plan.authority.connectionId,
      enabled: true, connection: { enabled: true } }, select: { id: true } }),
    db.providerCredentialVersion.findFirst({ where: { id: plan.authority.credentialVersionId, credentialId: plan.authority.credentialId,
      revokedAt: null, credential: { enabled: true, connectionId: plan.authority.connectionId } }, select: { id: true } })
  ]);
  return Boolean(model && credential);
}

export function createVisionAnalysisStore(prisma: PrismaClient) {
  async function access(tx: Pick<Prisma.TransactionClient, "modelRun" | "chat" | "project" | "user">, c: VisionAttemptContext) {
    const [run, user, grant] = await Promise.all([
      tx.modelRun.findFirst({ where: { id: c.runId, userId: c.userId, chatId: c.chatId }, select: { status: true } }),
      tx.user.findFirst({ where: { id: c.userId, status: "active" }, select: { id: true } }),
      resolveChatAccess(tx, { chatId: c.chatId, userId: c.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" })
    ]);
    if (!run || !user || !grant) throw new VisionAnalysisError("vision_analysis_access_denied");
    return { active: ["streaming", "in_progress"].includes(run.status), projectId: grant.project?.projectId ?? null };
  }
  function previous(c: VisionAttemptContext, row: { requestHash: string; result: Prisma.JsonValue | null }) {
    if (row.requestHash !== c.requestHash) throw new VisionAnalysisError("vision_analysis_input_invalid");
    return parsePersistedToolExecutionResult(c.call, row.result as ToolLoopJsonValue | null) ?? visionFailure(c.call, "vision_analysis_outcome_unknown");
  }
  async function lock(tx: Prisma.TransactionClient, c: VisionAttemptContext, hooks?: VisionExecutionHooks) {
    await lockRunSettlementScope(tx, c.runId);
    await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${c.runId} FOR UPDATE`;
    await hooks?.beforeSettlement?.(tx);
  }
  return {
    async restore(c: VisionAttemptContext) {
      const { active } = await access(prisma, c);
      if (!active) throw new VisionAnalysisError("vision_analysis_cancelled");
      const row = await prisma.visionAnalysisAttempt.findFirst({ where: { toolCallId: c.toolCallId, modelRunId: c.runId } });
      return row ? previous(c, row) : null;
    },
    async dispatch(c: VisionAttemptContext, plan: AvailableVisionAnalysisPlan, images: Prisma.InputJsonValue, hooks?: VisionExecutionHooks) {
      return prisma.$transaction(async tx => {
        await lock(tx, c, hooks);
        await hooks?.assertDispatch?.(tx);
        const authority = await access(tx, c);
        if (!authority.active) throw new VisionAnalysisError("vision_analysis_cancelled");
        const existing = await tx.visionAnalysisAttempt.findFirst({ where: { toolCallId: c.toolCallId, modelRunId: c.runId } });
        if (existing) return { result: previous(c, existing) };
        const tool = await tx.modelRunToolCall.findFirst({ where: { id: c.toolCallId, modelRunId: c.runId,
          providerCallId: c.call.id, toolName: ANALYZE_IMAGE_TOOL_NAME, state: "running" }, select: { id: true } });
        const binding = await tx.providerRunBinding.findFirst({ where: { modelRunId: c.runId, bindingKey: "vision_analysis", role: "vision_analysis",
          connectionId: plan.authority.connectionId, providerModelId: plan.authority.providerModelId,
          credentialId: plan.authority.credentialId, credentialVersionId: plan.authority.credentialVersionId }, select: { executionSnapshot: true } });
        if (!tool || !binding || hashCanonicalMcpValue(binding.executionSnapshot) !== hashCanonicalMcpValue(plan.snapshot)) throw new VisionAnalysisError("vision_model_unavailable");
        if (!await authorizeVisionPlan(tx, plan)) throw new VisionAnalysisError("vision_model_unavailable");
        if (await tx.visionAnalysisAttempt.count({ where: { modelRunId: c.runId } }) >= VISION_ANALYSIS_LIMITS.callsPerRun) throw new VisionAnalysisError("vision_analysis_limit_exceeded");
        await tx.visionAnalysisAttempt.create({ data: { toolCallId: c.toolCallId, modelRunId: c.runId,
          providerBindingKey: "vision_analysis", requestHash: c.requestHash, images } });
        await tx.usageEvent.create({ data: { visionAnalysis: true, visionAnalysisAttemptId: c.toolCallId,
          userId: c.userId, chatId: c.chatId, modelRunId: c.runId, projectId: authority.projectId,
          provider: plan.snapshot.providerFamily, providerModelId: plan.authority.providerModelId, modelId: plan.snapshot.model.upstreamModelId } });
        return { result: null };
      });
    },
    async settle(c: VisionAttemptContext, result: ToolExecutionResult, usage: TokenUsage, unknown: boolean, hooks?: VisionExecutionHooks, signal?: AbortSignal) {
      return prisma.$transaction(async tx => {
        await lock(tx, c, hooks);
        const row = await tx.visionAnalysisAttempt.findFirst({ where: { toolCallId: c.toolCallId, modelRunId: c.runId } });
        if (!row) return visionFailure(c.call, "vision_analysis_cancelled");
        if (row.state !== "dispatched") return previous(c, row);
        // Accounting survives Stop and grant revocation, without publishing a late success.
        const allowed = await access(tx, c).catch(() => null);
        const agentActive = hooks?.assertDispatch ? await hooks.assertDispatch(tx).then(() => true).catch(() => false) : true;
        const tool = await tx.modelRunToolCall.findFirst({ where: { id: c.toolCallId, modelRunId: c.runId }, select: { state: true } });
        const publish = Boolean(allowed?.active && agentActive && tool && ["pending", "running"].includes(tool.state));
        const final = publish && (result.status === "error" || !signal?.aborted) ? result : visionFailure(c.call, "vision_analysis_cancelled");
        const stored = snapshotToolExecutionResult(final, 64 * 1024);
        if (!stored) throw new VisionAnalysisError("vision_analysis_response_invalid");
        const receipt = await tx.usageEvent.findUnique({ where: { visionAnalysisAttemptId: c.toolCallId }, select: { id: true, providerModelId: true } });
        if (receipt) {
          const normalized = normalizeTokenUsage(usage);
          const pricing = receipt.providerModelId ? await tx.providerModel.findUnique({ where: { id: receipt.providerModelId },
            select: { inputTokenPriceMicros: true, outputTokenPriceMicros: true } }) : null;
          const cost = pricing && (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0) ? estimateCostMicros(normalized, pricing) : null;
          await tx.usageEvent.update({ where: { id: receipt.id }, data: { ...storedTokenUsage(normalized), estimatedCostMicros: cost !== null && cost <= 2_147_483_647 ? cost : null } });
        }
        await tx.visionAnalysisAttempt.update({ where: { toolCallId: c.toolCallId }, data: { state: unknown ? "ambiguous" : "settled",
          result: stored as Prisma.InputJsonValue, settledAt: new Date(), failureCode: final.status === "error" ? String((final.content[0] as { value: { error: string } }).value.error) : null } });
        if (publish) await hooks?.onResult?.(tx, final);
        return final;
      });
    }
  };
}

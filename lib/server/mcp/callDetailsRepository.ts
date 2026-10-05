import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { resolveChatAccess } from "../projects/access";
import { decodeToolObservationSourceBinding } from "../toolObservations/contract";
import { displayedToolCallState } from "../runs/toolLoopPersistence";
import { acceptedMcpCallIdentity, canReadAcceptedMcpCall, mcpDetailRecord as record } from "./callDetailsAuthority";
import { mcpCallDisplayRedaction } from "./callDetailsRedaction";
import type { McpCallDetailsRepository } from "./callDetails";

/** Historical display authority is separate from execution/recall authority.
 * Completed and archived readable chats are allowed; exact initiator, source,
 * present grants and immutable call identity are required at every read. */
export function createPrismaMcpCallDetailsRepository(prisma: PrismaClient): McpCallDetailsRepository {
  return {
    async read(key) {
      return prisma.$transaction(async tx => {
        const user = await tx.user.findFirst({ where: { id: key.userId, status: "active" }, select: { id: true } });
        if (!user) return null;
        const run = await tx.modelRun.findFirst({ where: { id: key.runId, userId: key.userId },
          select: { id: true, chatId: true, normalizedRequest: true, status: true, workspaceRunBinding: { select: { agent: { select: { modelRunId: true } } } },
            chat: { select: { projectId: true, memoryMode: true, temporaryRetentionDeadline: true } } } });
        if (!run || run.workspaceRunBinding?.agent || record(run.normalizedRequest) && run.normalizedRequest.agent ||
          !await resolveChatAccess(tx, { chatId: run.chatId, userId: key.userId })) return null;
        const call = await tx.modelRunToolCall.findUnique({ where: { modelRunId_roundIndex_ordinal: {
          modelRunId: key.runId, roundIndex: key.roundIndex, ordinal: key.ordinal
        } }, include: { observation: true, mcpRunBinding: true } });
        if (!call || call.workspaceRunBindingId || call.mcpRunBinding?.modelRunId !== run.id) return null;
        const identity = acceptedMcpCallIdentity(run.normalizedRequest, call.toolName, call.mcpRunBinding.runtimeGenerationFingerprint);
        if (!identity || !await canReadAcceptedMcpCall(tx, { ...identity, projectId: run.chat.projectId, userId: key.userId })) return null;
        const redaction = await mcpCallDisplayRedaction(tx, identity, call.mcpRunBinding.runtimeGenerationId, key.userId, run.chat.projectId);
        const observation = call.observation;
        let original = null;
        if (observation) {
          const binding = decodeToolObservationSourceBinding(observation.sourceBinding, "mcp");
          if (observation.modelRunId === run.id && observation.toolCallId === call.id && observation.sourceKind === "mcp" &&
            observation.formatVersion === 1 && observation.state === "READY" && binding?.source === "mcp" &&
            binding.fingerprint === identity.fingerprint && binding.serverId === identity.serverId &&
            binding.revisionId === identity.revisionId && binding.originalName === identity.originalName) original = observation;
        }
        const unavailable = Boolean(run.chat.memoryMode === "TEMPORARY" && run.chat.temporaryRetentionDeadline &&
          run.chat.temporaryRetentionDeadline <= new Date());
        // Data removal, mutable call settlement and changes to redaction context
        // during storage I/O invalidate delivery without exposing internal ids.
        const revision = createHash("sha256").update(JSON.stringify([
          call.id, call.updatedAt, call.state, run.status, call.arguments, call.result,
          original?.id, original?.updatedAt, original?.checksum, original?.byteSize, redaction, unavailable
        ])).digest("hex");
        return { id: call.id, toolName: call.toolName, providerCallId: call.providerCallId, state: displayedToolCallState(call, run.status),
          arguments: call.arguments, result: call.result, ...redaction, observation: original, unavailable, revision };
      });
    }
  };
}

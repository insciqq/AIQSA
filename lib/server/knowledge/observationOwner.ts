import type { Prisma, ToolObservation } from "@prisma/client";
import { resolveChatAccess } from "../projects/access";
import { ObservationStoreError } from "../toolObservations/contract";
import type { ObservationActor } from "../toolObservations/repository";
import { loadKnowledgeToolReceipt } from "./receiptReader";
import { currentAuthorityForEvidence } from "./retainedEvidenceAccess";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "./retrievalTypes";
import { knowledgeToolResultContent } from "./toolResult";

const unavailable = () => new ObservationStoreError("tool_observation_unavailable");

async function receipt(tx: Prisma.TransactionClient, source: ToolObservation) {
  const call = await tx.modelRunToolCall.findFirst({ where: { id: source.toolCallId,
    modelRunId: source.modelRunId, toolName: KNOWLEDGE_SEARCH_TOOL_NAME }, select: { id: true } });
  const value = call && await loadKnowledgeToolReceipt(tx,
    { runId: source.modelRunId, modelRunToolCallId: source.toolCallId });
  // Historical focused operations keep their original reader. New admission
  // never reinterprets them as a current automatic-search observation.
  if (!value || value.operation !== "automatic_search") throw unavailable();
  return value;
}

export const knowledgeObservationOwner = {
  async authorize(tx: Prisma.TransactionClient, source: ToolObservation, actor: ObservationActor) {
    const run = await tx.modelRun.findUnique({ where: { id: source.modelRunId }, select: { chatId: true } });
    const access = run && await resolveChatAccess(tx, { chatId: run.chatId, userId: actor.userId, requireMutable: true });
    if (!access) throw unavailable();
    const evidence = await receipt(tx, source);
    // Metadata in the current protocol describes pinned profiles, not a new
    // publication grant. The returned excerpts still need live source access.
    for (const base of evidence.bases) {
      if (!await tx.knowledgeRunProfileBinding.findFirst({ where: {
        id: base.knowledgeBaseId, modelRunId: source.modelRunId, ordinal: base.ordinal
      }, select: { id: true } })) throw unavailable();
    }
    const seen = new Set<string>();
    for (const result of evidence.results) {
      if (!result.sourceArtifactId) throw unavailable();
      if (seen.has(result.sourceArtifactId)) continue;
      seen.add(result.sourceArtifactId);
      const authority = await currentAuthorityForEvidence(tx, { access, runId: source.modelRunId, userId: actor.userId,
        item: { knowledgeBaseId: result.knowledgeBaseId, sourceId: result.documentId,
          sourceVersionId: result.documentVersionId, sourceVersionNumber: result.documentVersionNumber,
          sourceArtifactId: result.sourceArtifactId } });
      const artifact = authority && await tx.knowledgeSourceIndexArtifact.findFirst({ where: {
        id: result.sourceArtifactId, state: "ready", sourceVersionId: result.documentVersionId,
        sourceVersion: { sourceId: result.documentId, source: { deletionRequestedAt: null } }
      }, select: { id: true } });
      if (!artifact) throw unavailable();
    }
  },

  async load(tx: Prisma.TransactionClient, source: ToolObservation) {
    const evidence = await receipt(tx, source);
    // The existing KnowledgeRun remains the bytes/evidence owner. Expose the
    // same accepted model content; private accounting and profile bindings are
    // neither a new raw-evidence archive nor part of the model reader protocol.
    return { status: evidence.outcome === "search_unavailable" ? "error" : "complete",
      content: knowledgeToolResultContent(evidence) };
  }
};

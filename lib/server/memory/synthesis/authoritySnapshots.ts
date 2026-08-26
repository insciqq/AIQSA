import type { Prisma } from "@prisma/client";
import { loadPersonalMemoryEvidenceSnapshots } from "../persistence/eligibility";

export type MemoryReusableFactSnapshotTarget = Readonly<{
  modality: string;
  sourceMode: string;
  versionId: string;
}>;

export type MemoryReusableFactSourceSnapshot =
  | Readonly<{
      branchGeneration: number | null;
      evidenceId: string;
      kind: "EXPLICIT_ACTION";
      safeSourceHash: string;
      sourceProjectionVersion: string;
    }>
  | Readonly<{
      branchGeneration: number;
      chatId: string;
      evidenceFingerprint: string;
      evidenceId: string;
      kind: "MESSAGE";
      messageId: string;
      safeSourceHash: string;
      sourceProjectionVersion: string;
    }>
  | Readonly<{
      kind: "SYNTHESIZED_FROM";
      pipelineVersion: string;
      sourceEligibilityHash: string;
      targetVersionId: string;
    }>;

/** Produces one deterministic provenance shape for incremental indexing and a
 * full rebuild. It deliberately exposes no provider-facing entity identity. */
export async function loadMemoryReusableFactSourceSnapshots(
  tx: Prisma.TransactionClient,
  userId: string,
  targets: readonly MemoryReusableFactSnapshotTarget[]
): Promise<ReadonlyMap<string, readonly MemoryReusableFactSourceSnapshot[]>> {
  const unique = [...new Map(targets.map((target) => [target.versionId, target])).values()];
  const result = new Map<string, MemoryReusableFactSourceSnapshot[]>(
    unique.map(({ versionId }) => [versionId, []])
  );
  if (unique.length === 0) return result;

  const automaticIds = unique.flatMap((target) =>
    target.sourceMode === "AUTOMATIC" && target.modality !== "PATTERN"
      ? [target.versionId]
      : []);
  const messageEvidence = await loadPersonalMemoryEvidenceSnapshots(
    tx,
    userId,
    automaticIds,
    { exactVNext: true }
  );
  for (const evidence of messageEvidence) {
    if (!evidence.evidenceFingerprint) continue;
    result.get(evidence.factVersionId)?.push(Object.freeze({
      branchGeneration: evidence.branchGeneration,
      chatId: evidence.chatId,
      evidenceFingerprint: evidence.evidenceFingerprint,
      evidenceId: evidence.id,
      kind: "MESSAGE",
      messageId: evidence.messageId,
      safeSourceHash: evidence.safeSourceHash,
      sourceProjectionVersion: evidence.sourceProjectionVersion
    }));
  }

  const explicitIds = unique.flatMap((target) =>
    target.sourceMode === "EXPLICIT" ? [target.versionId] : []);
  if (explicitIds.length > 0) {
    const explicitEvidence = await tx.memoryEvidence.findMany({
      orderBy: [{ factVersionId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        branchGeneration: true,
        factVersionId: true,
        id: true,
        safeSourceHash: true,
        sourceProjectionVersion: true
      },
      where: {
        factVersionId: { in: explicitIds },
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId
      }
    });
    for (const evidence of explicitEvidence) {
      result.get(evidence.factVersionId)?.push(Object.freeze({
        branchGeneration: evidence.branchGeneration,
        evidenceId: evidence.id,
        kind: "EXPLICIT_ACTION",
        safeSourceHash: evidence.safeSourceHash,
        sourceProjectionVersion: evidence.sourceProjectionVersion
      }));
    }
  }

  const patternIds = unique.flatMap((target) =>
    target.modality === "PATTERN" ? [target.versionId] : []);
  if (patternIds.length > 0) {
    const relations = await tx.memoryFactVersionRelation.findMany({
      orderBy: [
        { sourceVersionId: "asc" },
        { targetVersionId: "asc" },
        { id: "asc" }
      ],
      select: {
        pipelineVersion: true,
        sourceEligibilityHash: true,
        sourceVersionId: true,
        targetVersionId: true
      },
      where: {
        kind: "SYNTHESIZED_FROM",
        sourceEligibilityHash: { not: null },
        sourceVersionId: { in: patternIds },
        userId
      }
    });
    for (const relation of relations) {
      if (!relation.sourceEligibilityHash) continue;
      result.get(relation.sourceVersionId)?.push(Object.freeze({
        kind: "SYNTHESIZED_FROM",
        pipelineVersion: relation.pipelineVersion,
        sourceEligibilityHash: relation.sourceEligibilityHash,
        targetVersionId: relation.targetVersionId
      }));
    }
  }

  return new Map([...result].map(([versionId, snapshots]) => [
    versionId,
    Object.freeze([...snapshots])
  ]));
}

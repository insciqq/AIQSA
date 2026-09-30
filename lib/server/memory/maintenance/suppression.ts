import type { Prisma } from "@prisma/client";

type Span = Readonly<{
  messageId: string;
  sourceTextHash: string;
  startOffset: number;
  endOffset: number;
}>;

export function memoryMaintenanceSpanIntersects(
  fence: Readonly<{ sourceMessageId: string; sourceMessageContentHash: string; sourceStartOffset: number; sourceEndOffset: number }>,
  evidence: Span
): boolean {
  return fence.sourceMessageId === evidence.messageId &&
    fence.sourceMessageContentHash === evidence.sourceTextHash &&
    Number.isSafeInteger(evidence.startOffset) && Number.isSafeInteger(evidence.endOffset) &&
    evidence.startOffset < fence.sourceEndOffset && evidence.endOffset > fence.sourceStartOffset &&
    evidence.endOffset > evidence.startOffset;
}

/** A changed model paraphrase cannot revive the exact removed assertion.
 * The fence is confined to its original source bytes, never a whole message. */
export async function isMemoryMaintenanceEvidenceSuppressed(
  tx: Prisma.TransactionClient,
  input: Readonly<{ userId: string; evidence: readonly Span[] }>
): Promise<boolean> {
  if (input.evidence.length === 0) return false;
  const fences = await tx.memoryMaintenanceSuppression.findMany({
    where: { userId: input.userId, sourceMessageId: { in: [...new Set(input.evidence.map(({ messageId }) => messageId))] } },
    select: { sourceMessageId: true, sourceMessageContentHash: true, sourceStartOffset: true, sourceEndOffset: true }
  });
  return input.evidence.some((evidence) => fences.some((fence) => memoryMaintenanceSpanIntersects(fence, evidence)));
}

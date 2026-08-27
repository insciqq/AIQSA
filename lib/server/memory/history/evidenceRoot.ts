import { memorySha256 } from "../persistence/lexical";

type MemoryEvidenceRootJoin = Readonly<{
  messageId: string;
  safeTextHash: string;
  sourceEndOffset: number;
  sourceMessageContentHash: string;
  sourceMessageUpdatedAt: string;
  sourceStartOffset: number;
}>;

type MemoryChunkEvidenceRootJoin = Readonly<{
  endOffset: number;
  messageId: string;
  safeTextHash: string;
  sourceMessageContentHash: string;
  sourceMessageUpdatedAt: string;
  startOffset: number;
}>;

export function memoryHistoryEvidenceRootHash(input: Readonly<{
  chatId: string;
  messageJoins: readonly MemoryEvidenceRootJoin[];
  userId: string;
}>): string {
  if (!input.chatId || !input.userId || input.messageJoins.length === 0 ||
    input.messageJoins.some((join) =>
      !Number.isSafeInteger(join.sourceStartOffset) || join.sourceStartOffset < 0 ||
      !Number.isSafeInteger(join.sourceEndOffset) ||
      join.sourceEndOffset <= join.sourceStartOffset)) {
    throw new Error("memory_history_evidence_root_invalid");
  }
  return memorySha256({
    chatId: input.chatId,
    domain: "aiqsa.memory.history-evidence-root",
    messages: input.messageJoins.map((join) => ({
      messageId: join.messageId,
      safeTextHash: join.safeTextHash,
      sourceEndOffset: join.sourceEndOffset,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: join.sourceMessageUpdatedAt,
      sourceStartOffset: join.sourceStartOffset
    })),
    userId: input.userId,
    version: 1
  });
}

export function memoryHistoryChunkEvidenceRootHash(input: Readonly<{
  chatId: string;
  messageJoins: readonly MemoryChunkEvidenceRootJoin[];
  userId: string;
}>): string {
  return memoryHistoryEvidenceRootHash({
    chatId: input.chatId,
    messageJoins: input.messageJoins.map((join) => ({
      messageId: join.messageId,
      safeTextHash: join.safeTextHash,
      sourceEndOffset: join.endOffset,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: join.sourceMessageUpdatedAt,
      sourceStartOffset: join.startOffset
    })),
    userId: input.userId
  });
}

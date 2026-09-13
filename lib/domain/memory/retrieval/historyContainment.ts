import type { MemoryExpandedCandidate } from "./contracts";

function rawHistory(expansion: MemoryExpandedCandidate): boolean {
  return (expansion.itemType === "RECALL_CHUNK" || expansion.itemType === "RECALL_ROUND") &&
    expansion.projectionKind !== "CHAT_DIGEST_SAFE_TEXT" &&
    Boolean(expansion.sourceChatId && expansion.safeText.trim()) &&
    (expansion.sourceMessageIds?.length ?? 0) > 0;
}

/** Compare admitted raw projections from the same canonical source messages.
 * Containment proves redundancy only when the containing projection is packed.
 * Different chats/messages, summaries and distinct supporting evidence survive.
 */
export function memoryHistoryContains(
  outer: MemoryExpandedCandidate,
  inner: MemoryExpandedCandidate
): boolean {
  return rawHistory(outer) && rawHistory(inner) &&
    outer.sourceChatId === inner.sourceChatId &&
    outer.safeText.includes(inner.safeText) &&
    inner.sourceMessageIds!.every((id) => outer.sourceMessageIds!.includes(id)) &&
    (inner.supportingEvidence ?? []).every((support) =>
      (outer.supportingEvidence ?? []).some((other) =>
        other.itemId === support.itemId && other.sourceChatId === support.sourceChatId &&
        other.safeText === support.safeText));
}

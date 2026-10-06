import type { MemoryExpandedCandidate } from "./contracts";

function rawHistory(expansion: MemoryExpandedCandidate): boolean {
  return (expansion.itemType === "RECALL_CHUNK" || expansion.itemType === "RECALL_ROUND") &&
    Boolean(expansion.sourceChatId && expansion.safeText.trim()) &&
    (expansion.sourceMessageIds?.length ?? 0) > 0;
}

/** Compare admitted raw projections from the same canonical source messages.
 * Containment proves redundancy only when the containing projection is packed.
 * Different chats/messages survive.
 */
export function memoryHistoryContains(
  outer: MemoryExpandedCandidate,
  inner: MemoryExpandedCandidate
): boolean {
  return rawHistory(outer) && rawHistory(inner) &&
    outer.sourceChatId === inner.sourceChatId &&
    outer.safeText.includes(inner.safeText) &&
    inner.sourceMessageIds!.every((id) => outer.sourceMessageIds!.includes(id));
}

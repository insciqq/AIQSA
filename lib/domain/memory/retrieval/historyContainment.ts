import type { MemoryExpandedCandidate, MemoryRankedCandidate } from "./contracts";

function rawHistory(expansion: MemoryExpandedCandidate): boolean {
  return (expansion.itemType === "RECALL_CHUNK" || expansion.itemType === "RECALL_ROUND") &&
    expansion.projectionKind !== "CHAT_DIGEST_SAFE_TEXT" &&
    Boolean(expansion.sourceChatId && expansion.safeText.trim()) &&
    (expansion.sourceMessageIds?.length ?? 0) > 0;
}

/** Remove only provably repeated text from the same canonical source messages.
 * A containing excerpt keeps its own rank; no score is transferred. Different
 * chats/messages, derived summaries and distinct supporting evidence survive.
 */
export function deduplicateContainedHistory(
  candidates: readonly MemoryRankedCandidate[],
  expansions: readonly MemoryExpandedCandidate[]
): readonly MemoryRankedCandidate[] {
  const byKey = new Map(expansions.map((entry) => [
    `${entry.itemType}:${entry.itemId}`, entry
  ]));
  const entries = candidates.map((candidate) => {
    const expansion = byKey.get(`${candidate.itemType}:${candidate.itemId}`);
    return expansion && rawHistory(expansion) &&
      candidate.metadata.sourceChatId === expansion.sourceChatId
      ? expansion : null;
  });
  return candidates.filter((_candidate, index) => {
    const inner = entries[index];
    if (!inner) return true;
    return !entries.some((outer, outerIndex) => {
      if (!outer || outerIndex === index || outer.sourceChatId !== inner.sourceChatId ||
        outer.safeText.length < inner.safeText.length ||
        (outer.safeText === inner.safeText && outerIndex > index) ||
        !outer.safeText.includes(inner.safeText) ||
        !inner.sourceMessageIds!.every((id) => outer.sourceMessageIds!.includes(id))) {
        return false;
      }
      return (inner.supportingEvidence ?? []).every((support) =>
        (outer.supportingEvidence ?? []).some((other) =>
          other.itemId === support.itemId && other.sourceChatId === support.sourceChatId &&
          other.safeText === support.safeText));
    });
  });
}

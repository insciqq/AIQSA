/**
 * Quiet checks leave the feed (operator decision 2026-11-11): a monitoring
 * check that settled with no update is neither news nor a comparison basis,
 * so what the owner reads of a chat (its served history and pages, its branch
 * graph, exports and shares) leaves out that check's scheduled turn and every
 * answer to it, however old. The rows stay; the chat's summary line counts
 * them. A kept message whose parent left hangs from its nearest kept
 * ancestor, so the next result stays where it was on the branch.
 */
export type QuietCheckNode = Readonly<{ id: string; parentId: string | null; role: string }>;

export type QuietCheckOmission = Readonly<{
  /** The kept parent of every kept node whose parent was left out. */
  parents: ReadonlyMap<string, string | null>;
  removed: ReadonlySet<string>;
  /** The node a reference to `id` reads as: itself, or its nearest kept ancestor (null at the root). */
  resolve(id: string | null): string | null;
}>;

/** `quietTurnIds`: the scheduled turns whose check settled `no_update` (`lib/server/chats/quietScheduledChecks.ts`). */
export function omitQuietScheduledChecks(nodes: readonly QuietCheckNode[], quietTurnIds: ReadonlySet<string>): QuietCheckOmission {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const removed = new Set(nodes.filter((node) => node.role === "user" ? quietTurnIds.has(node.id)
    : node.role === "assistant" && node.parentId !== null && quietTurnIds.has(node.parentId)).map((node) => node.id));
  const resolve = (id: string | null): string | null => {
    let current = id;
    const seen = new Set<string>();
    while (current !== null && removed.has(current) && !seen.has(current)) {
      seen.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return current !== null && removed.has(current) ? null : current;
  };
  const parents = new Map<string, string | null>();
  for (const node of nodes) {
    if (!removed.has(node.id) && node.parentId !== null && removed.has(node.parentId)) parents.set(node.id, resolve(node.parentId));
  }
  return { parents, removed, resolve };
}

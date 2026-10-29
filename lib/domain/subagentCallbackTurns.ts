import { SUBAGENT_CALLBACK_TURN_KIND } from "../contracts/subagents";

export type CallbackTurnNode = Readonly<{ id: string; parentId: string | null; role: string; systemTurnKind: string | null }>;

/**
 * Leaves sub-agent wake-up turns out of a chat's message graph, for copies
 * that leave the chat (exports, shares): such a turn is the server's, never
 * the user's speech, so it never reads as a user message there. Its children
 * hang from its nearest kept ancestor, so the main agent's answer to the
 * callbacks stays where it was on the branch.
 */
export function omitSubagentCallbackTurns(nodes: readonly CallbackTurnNode[]): Readonly<{
  /** The kept parent of every kept node whose parent was left out. */
  parents: ReadonlyMap<string, string | null>;
  removed: ReadonlySet<string>;
  /** The node a reference to `id` reads as: itself, or its nearest kept ancestor (null at the root). */
  resolve(id: string | null): string | null;
}> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const removed = new Set(nodes.filter((node) => node.role === "user" && node.systemTurnKind === SUBAGENT_CALLBACK_TURN_KIND)
    .map((node) => node.id));
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

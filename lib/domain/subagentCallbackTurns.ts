import { BROWSER_SIGN_IN_TURN_KIND } from "../contracts/browserSignIn";
import { SUBAGENT_CALLBACK_TURN_KIND } from "../contracts/subagents";

export type CallbackTurnNode = Readonly<{ id: string; parentId: string | null; role: string; systemTurnKind: string | null }>;

/**
 * Server-written user turns that a copy leaving the chat leaves out: a sub-agent wake-up turn and a Sign in again
 * request (`lib/contracts/browserSignIn.ts`). Neither is the user's speech, and outside the chat nothing could show
 * that, so neither may read as a user message there. An approval continuation stays: its text says the user approved.
 */
const OMITTED_TURN_KINDS: ReadonlySet<string> = new Set([SUBAGENT_CALLBACK_TURN_KIND, BROWSER_SIGN_IN_TURN_KIND]);

/**
 * Leaves sub-agent wake-up turns and Sign in again requests out of a chat's
 * message graph, for copies that leave the chat (exports, shares). Their
 * children hang from their nearest kept ancestor, so the answer to such a
 * turn stays where it was on the branch.
 */
export function omitSubagentCallbackTurns(nodes: readonly CallbackTurnNode[]): Readonly<{
  /** The kept parent of every kept node whose parent was left out. */
  parents: ReadonlyMap<string, string | null>;
  removed: ReadonlySet<string>;
  /** The node a reference to `id` reads as: itself, or its nearest kept ancestor (null at the root). */
  resolve(id: string | null): string | null;
}> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const removed = new Set(nodes.filter((node) => node.role === "user" && node.systemTurnKind !== null &&
    OMITTED_TURN_KINDS.has(node.systemTurnKind)).map((node) => node.id));
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

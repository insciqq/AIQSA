import { branchLeafRevealingMessageV2 } from "@/features/branches-v2/branchModel";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";

/** How long a revealed search match keeps its highlight. */
export const SEARCH_MATCH_HIGHLIGHT_MS = 2_400;

export type MessageSearchMatchOutcome =
  | "branch_unavailable"
  | "chat_unavailable"
  | "message_unavailable"
  | "opened"
  | "superseded";

/**
 * Opens a sidebar message match: the chat first (one history entry), then
 * the version of the chat that contains the message (the newest leaf below
 * it, through the existing branch checkout) when it is off the active
 * branch, then earlier pages until the message is loaded, then the anchor.
 * A later navigation away from the chat supersedes the remaining steps.
 */
export async function openMessageSearchMatch(input: Readonly<{
  activateChat(chatId: string): Promise<boolean>;
  chatId: string;
  isCurrent(chatId: string): boolean;
  loadBranchGraph(chatId: string): Promise<ChatBranchGraphWire | null>;
  messageId: string;
  onAnchor(chatId: string, messageId: string): void;
  revealMessage(chatId: string, messageId: string): Promise<boolean>;
  showBranch(chatId: string, leafId: string, currentLeafId: string | null): Promise<boolean>;
}>): Promise<MessageSearchMatchOutcome> {
  const { chatId, messageId } = input;
  try {
    if (!await input.activateChat(chatId)) return "chat_unavailable";
    if (!input.isCurrent(chatId)) return "superseded";
    // Without a graph the message may still be on the active branch.
    const graph = await input.loadBranchGraph(chatId).catch(() => null);
    if (!input.isCurrent(chatId)) return "superseded";
    if (graph && !graph.nodes.some((node) => node.id === messageId)) return "message_unavailable";
    const leafId = graph ? branchLeafRevealingMessageV2(graph, messageId) : null;
    if (leafId && graph) {
      if (!await input.showBranch(chatId, leafId, graph.activeLeafMessageId)) return "branch_unavailable";
      if (!input.isCurrent(chatId)) return "superseded";
    }
    if (!await input.revealMessage(chatId, messageId)) return "message_unavailable";
    if (!input.isCurrent(chatId)) return "superseded";
    input.onAnchor(chatId, messageId);
    return "opened";
  } catch {
    return "message_unavailable";
  }
}

let highlightGeneration = 0;

/**
 * Briefly highlights the revealed message's turn. The attribute is
 * presentation only; a re-rendered or remounted turn simply drops it.
 */
export function highlightRevealedMessage(target: HTMLElement): void {
  const generation = String(++highlightGeneration);
  target.removeAttribute("data-search-reveal");
  // A repeated jump to the same message restarts the highlight; only the
  // latest one removes it.
  window.requestAnimationFrame(() => {
    target.setAttribute("data-search-reveal", generation);
    window.setTimeout(() => {
      if (target.getAttribute("data-search-reveal") === generation) target.removeAttribute("data-search-reveal");
    }, SEARCH_MATCH_HIGHLIGHT_MS);
  });
}

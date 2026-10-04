import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  SEARCH_MATCH_HIGHLIGHT_MS,
  highlightRevealedMessage,
  openMessageSearchMatch
} from "./messageSearchMatch";

const node = (id: string, parentMessageId: string | null, role: "assistant" | "user" = "user") =>
  ({ id, parentMessageId, preview: id, role, status: "complete" as const });
// q1 → a1 (active branch) and q1 → a2 → q2 (another branch).
const graph: ChatBranchGraphWire = {
  activeLeafMessageId: "a1",
  nodes: [node("q1", null), node("a1", "q1", "assistant"), node("a2", "q1", "assistant"), node("q2", "a2")],
  snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
};

function deps(overrides: Partial<Parameters<typeof openMessageSearchMatch>[0]> = {}) {
  const calls: string[] = [];
  const input: Parameters<typeof openMessageSearchMatch>[0] = {
    activateChat: vi.fn(async (chatId: string) => { calls.push(`activate:${chatId}`); return true; }),
    chatId: "chat-1",
    isCurrent: () => true,
    loadBranchGraph: vi.fn(async () => { calls.push("graph"); return graph; }),
    messageId: "q1",
    onAnchor: vi.fn((chatId: string, messageId: string) => { calls.push(`anchor:${chatId}:${messageId}`); }),
    revealMessage: vi.fn(async (_chatId: string, messageId: string) => { calls.push(`reveal:${messageId}`); return true; }),
    showBranch: vi.fn(async (_chatId: string, leafId: string, currentLeafId: string | null) => {
      calls.push(`branch:${leafId}<-${currentLeafId}`);
      return true;
    }),
    ...overrides
  };
  return { calls, input };
}

describe("opening a sidebar message match", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("opens the chat, loads earlier pages and anchors a message on the active branch", async () => {
    const { calls, input } = deps();
    await expect(openMessageSearchMatch(input)).resolves.toBe("opened");
    expect(calls).toEqual(["activate:chat-1", "graph", "reveal:q1", "anchor:chat-1:q1"]);
  });

  it("switches to the newest leaf below a message on another branch before revealing it", async () => {
    const { calls, input } = deps({ messageId: "a2" });
    await expect(openMessageSearchMatch(input)).resolves.toBe("opened");
    expect(calls).toEqual(["activate:chat-1", "graph", "branch:q2<-a1", "reveal:a2", "anchor:chat-1:a2"]);
  });

  it("reports what could not be opened and never anchors then", async () => {
    const missing = deps({ messageId: "deleted" });
    await expect(openMessageSearchMatch(missing.input)).resolves.toBe("message_unavailable");
    expect(missing.input.revealMessage).not.toHaveBeenCalled();

    const refused = deps({ messageId: "q2", showBranch: vi.fn(async () => false) });
    await expect(openMessageSearchMatch(refused.input)).resolves.toBe("branch_unavailable");
    expect(refused.input.revealMessage).not.toHaveBeenCalled();

    const gone = deps({ activateChat: vi.fn(async () => false) });
    await expect(openMessageSearchMatch(gone.input)).resolves.toBe("chat_unavailable");
    expect(gone.input.loadBranchGraph).not.toHaveBeenCalled();

    const unrevealed = deps({ revealMessage: vi.fn(async () => false) });
    await expect(openMessageSearchMatch(unrevealed.input)).resolves.toBe("message_unavailable");
    for (const { input } of [missing, refused, gone, unrevealed]) expect(input.onAnchor).not.toHaveBeenCalled();
  });

  it("still reveals on the open branch when the branch graph cannot be read", async () => {
    const { calls, input } = deps({ loadBranchGraph: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(openMessageSearchMatch(input)).resolves.toBe("opened");
    expect(calls).toEqual(["activate:chat-1", "reveal:q1", "anchor:chat-1:q1"]);
  });

  it("stops once the reader has moved to another chat", async () => {
    let current = true;
    const { input } = deps({
      isCurrent: () => current,
      loadBranchGraph: vi.fn(async () => { current = false; return graph; })
    });
    await expect(openMessageSearchMatch(input)).resolves.toBe("superseded");
    expect(input.revealMessage).not.toHaveBeenCalled();
    expect(input.onAnchor).not.toHaveBeenCalled();
  });

  it("highlights the revealed turn briefly, the latest highlight winning", async () => {
    vi.useFakeTimers();
    const target = document.createElement("article");
    target.dataset.messageId = "target";
    document.body.append(target);

    highlightRevealedMessage(target);
    vi.advanceTimersToNextFrame();
    expect(target).toHaveAttribute("data-search-reveal");

    vi.advanceTimersByTime(SEARCH_MATCH_HIGHLIGHT_MS / 2);
    highlightRevealedMessage(target);
    // A repeated jump restarts the highlight in the next frame.
    expect(target).not.toHaveAttribute("data-search-reveal");
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(SEARCH_MATCH_HIGHLIGHT_MS / 2 + 10);
    // The first highlight's timer does not cut the repeated one short.
    expect(target).toHaveAttribute("data-search-reveal");
    vi.advanceTimersByTime(SEARCH_MATCH_HIGHLIGHT_MS);
    expect(target).not.toHaveAttribute("data-search-reveal");
  });
});

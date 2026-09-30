import { afterEach, describe, expect, it } from "vitest";
import { resetComposerSessionStoreForTest } from "@/tests/support/appShellStores";
import { RUN_FOLLOWUP_MAX_CHARS } from "@/lib/contracts/runFollowups";
import { quoteSelectionInComposer } from "./composerQuoteSelection";
import { useComposerSessionStore, type ComposerSessionKey } from "./composerSessionStore";

afterEach(resetComposerSessionStoreForTest);

describe("quote into the active composer", () => {
  it.each<ComposerSessionKey>(["chat:personal", "chat:project", "blank:project:project:root", "blank:temporary:root"])("uses the existing keyed draft for %s", sessionKey => {
    const store = useComposerSessionStore.getState();
    store.activateSession(sessionKey);
    store.updateSession(sessionKey, { draft: "Current request" });
    expect(quoteSelectionInComposer({ sessionKey, markdown: "Selected text", followup: false })).toBeNull();
    expect(useComposerSessionStore.getState().sessionsByKey[sessionKey]?.draft).toBe("Current request\n\n> Selected text\n\n");
  });
  it("refuses stale navigation and inline edits without changing either draft", () => {
    const store = useComposerSessionStore.getState();
    store.activateSession("chat:old"); store.updateSession("chat:old", { draft: "Old" });
    store.activateSession("chat:current"); store.updateSession("chat:current", { draft: "Current", editingMessageId: "editing" });
    expect(quoteSelectionInComposer({ sessionKey: "chat:old", markdown: "Quote", followup: false })).not.toBeNull();
    expect(quoteSelectionInComposer({ sessionKey: "chat:current", markdown: "Quote", followup: false })).not.toBeNull();
    expect(useComposerSessionStore.getState().sessionsByKey["chat:old"]?.draft).toBe("Old");
    expect(useComposerSessionStore.getState().sessionsByKey["chat:current"]?.draft).toBe("Current");
  });
  it("enforces the complete follow-up size including quote syntax, without truncation", () => {
    const store = useComposerSessionStore.getState(); store.activateSession("chat:current");
    const markdown = "x".repeat(RUN_FOLLOWUP_MAX_CHARS - 4);
    expect(quoteSelectionInComposer({ sessionKey: "chat:current", markdown, followup: true })).toBeNull();
    const full = useComposerSessionStore.getState().sessionsByKey["chat:current"]!.draft;
    expect(full.length).toBe(RUN_FOLLOWUP_MAX_CHARS);
    expect(quoteSelectionInComposer({ sessionKey: "chat:current", markdown: "More", followup: true })).toContain("16,000");
    expect(useComposerSessionStore.getState().sessionsByKey["chat:current"]!.draft).toBe(full);
    expect(quoteSelectionInComposer({ sessionKey: "chat:current", markdown: "More", followup: false })).toBeNull();
  });
});

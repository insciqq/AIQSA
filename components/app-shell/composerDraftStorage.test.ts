import { afterEach, describe, expect, it, vi } from "vitest";
import { composerSessionKey, projectComposerSessionKey } from "./composerSessionStore";
import { MAX_PENDING_COMMENTS } from "./composerComments";
import { clearComposerDrafts, COMPOSER_DRAFT_INITIAL_EPOCH, COMPOSER_DRAFT_MAX_AGE_MS, COMPOSER_DRAFT_MAX_ENTRY_SIZE, COMPOSER_DRAFT_MAX_RECORD_SIZE,
  composerDraftEpochKey, composerDraftStorageKey, composerDraftTooLargeToStore, composerInputFitsStoredRecord, createInitialComposerDraftEpoch,
  readComposerDraftEpoch, readComposerDraftEpochState, readComposerDrafts, replaceComposerDraftEpoch, resumeComposerDraftEpoch,
  signOutComposerDraftEpoch, subscribeComposerDraftRefusals, writeComposerDrafts } from "./composerDraftStorage";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const key = composerSessionKey("one");

describe("account-scoped browser drafts", () => {
  it("retains the full comment count with long fragments and comments in one record", () => {
    const comments = Array.from({ length: MAX_PENDING_COMMENTS }, (_, index) => ({
      id: `max-comment-${index}`, quote: `q${"\u0001".repeat(index === 0 ? 9_999 : 99)}`,
      text: `c${"\u0001".repeat(index === 0 ? 4_999 : 99)}`,
      anchor: { messageId: "m".repeat(128), start: 9_000_000, end: 9_999_999, fingerprint: "0a1b2c3d" }
    }));
    const draft = "ordinary text ".repeat(4800);
    expect(composerInputFitsStoredRecord(key, { draft, comments })).toBe(true);
    expect(writeComposerDrafts("a", new Map([[key, { draft, comments }]]))).toEqual({ tooLarge: [], unsaved: [] });
    expect(readComposerDrafts("a")[0]).toMatchObject({ draft, comments });
    expect(localStorage.getItem(composerDraftStorageKey("a"))!.length).toBeLessThan(COMPOSER_DRAFT_MAX_RECORD_SIZE);
  });

  it("restores the draft and valid comments when one stored comment is invalid", () => {
    const now = 1_000;
    localStorage.setItem(composerDraftStorageKey("a"), JSON.stringify({ version: 1, records: [{ sessionKey: key, draft: "kept text", savedAt: now,
      comments: [{ id: "one", quote: "first", text: "kept" }, { id: "bad", quote: "second", text: "" }, { id: "two", quote: "third", text: "also kept" }] }] }));
    expect(readComposerDrafts("a", now)).toEqual([{ sessionKey: key, draft: "kept text", savedAt: now,
      comments: [{ id: "one", quote: "first", text: "kept" }, { id: "two", quote: "third", text: "also kept" }] }]);
    localStorage.setItem(composerDraftStorageKey("a"), JSON.stringify({ version: 1, records: [{ sessionKey: key, draft: "text only", savedAt: now, comments: "corrupt" }] }));
    expect(readComposerDrafts("a", now)).toEqual([{ sessionKey: key, draft: "text only", savedAt: now }]);
  });

  it("never stores input above the record bound and keeps the previous copy with a notice signal", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeComposerDraftRefusals(listener);
    writeComposerDrafts("a", new Map([[key, { draft: "previous copy", comments: [{ id: "c", quote: "q", text: "kept comment" }] }]]), 1);
    const oversized = "x".repeat(COMPOSER_DRAFT_MAX_RECORD_SIZE);
    expect(composerInputFitsStoredRecord(key, { draft: oversized })).toBe(false);
    expect(writeComposerDrafts("a", new Map([[key, oversized]]), 2)).toEqual({ tooLarge: [key], unsaved: [] });
    expect(readComposerDrafts("a", 3)).toEqual([{ sessionKey: key, draft: "previous copy", comments: [{ id: "c", quote: "q", text: "kept comment" }], savedAt: 1 }]);
    expect(composerDraftTooLargeToStore("a", key)).toBe(true);
    expect(composerDraftTooLargeToStore("b", key)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    // A repeated oversized write is the same notice, not a new one.
    writeComposerDrafts("a", new Map([[key, `${oversized}y`]]), 3);
    expect(listener).toHaveBeenCalledOnce();
    writeComposerDrafts("a", new Map([[key, "shortened"]]), 4);
    expect(composerDraftTooLargeToStore("a", key)).toBe(false);
    expect(readComposerDrafts("a", 5)[0]?.draft).toBe("shortened");
    writeComposerDrafts("a", new Map([[key, oversized]]), 6);
    writeComposerDrafts("a", new Map([[key, null]]), 7);
    expect(composerDraftTooLargeToStore("a", key)).toBe(false);
    expect(readComposerDrafts("a", 8)).toEqual([]);
    writeComposerDrafts("a", new Map([[key, oversized]]), 9);
    clearComposerDrafts("a");
    expect(composerDraftTooLargeToStore("a", key)).toBe(false);
    unsubscribe();
  });

  it("keeps root, folder, excluded, Project and saved-chat records separate across accounts", () => {
    const keys = [key, composerSessionKey(null), composerSessionKey(null, "folder"),
      composerSessionKey(null, null, "EXCLUDED"), projectComposerSessionKey("project"), projectComposerSessionKey("project", "folder")];
    writeComposerDrafts("a", new Map(keys.map((sessionKey, index) => [sessionKey, `text ${index}`])));
    writeComposerDrafts("b", new Map([[key, "other account"]]));
    expect(readComposerDrafts("a").map(record => record.draft)).toEqual(keys.map((_, i) => `text ${i}`));
    expect(readComposerDrafts("b")[0]?.draft).toBe("other account");
  });

  it("expires records after 30 days, rejects malformed values and strips non-text fields", () => {
    const now = 10 * COMPOSER_DRAFT_MAX_AGE_MS;
    localStorage.setItem(composerDraftStorageKey("a"), JSON.stringify({ version: 1, records: [
      { sessionKey: key, draft: "expired", savedAt: now - COMPOSER_DRAFT_MAX_AGE_MS },
      { sessionKey: "chat:future", draft: "future", savedAt: now + 1 },
      { sessionKey: "chat:%", draft: "invalid key", savedAt: now },
      { sessionKey: "blank:temporary:root", draft: "temporary", savedAt: now },
      { sessionKey: "chat:valid", draft: "kept", savedAt: now, attachments: [{ id: "never restore" }], workspaceEnabled: true }
    ] }));
    expect(readComposerDrafts("a", now)).toEqual([{ sessionKey: "chat:valid", draft: "kept", savedAt: now }]);
    expect(localStorage.getItem(composerDraftStorageKey("a"))).not.toMatch(/expired|future|attachments|workspaceEnabled|temporary/u);
    localStorage.setItem(composerDraftStorageKey("a"), "{broken");
    expect(readComposerDrafts("a", now)).toEqual([]);
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
  });

  it("evicts oldest records at count and serialized size bounds without truncating text", () => {
    for (let i = 0; i < 52; i++) writeComposerDrafts("a", new Map([[composerSessionKey(String(i)), `text${i}`]]), 100 + i);
    expect(readComposerDrafts("a", 200)).toHaveLength(50);
    expect(readComposerDrafts("a", 200)[0]?.draft).toBe("text2");
    const largeCount = Math.ceil(COMPOSER_DRAFT_MAX_ENTRY_SIZE / 60_000) + 2;
    for (let i = 0; i < largeCount; i++) writeComposerDrafts("large", new Map([[composerSessionKey(String(i)), "x".repeat(60_000)]]), 100 + i);
    expect(localStorage.getItem(composerDraftStorageKey("large"))!.length).toBeLessThanOrEqual(COMPOSER_DRAFT_MAX_ENTRY_SIZE);
    expect(readComposerDrafts("large", 200).at(-1)?.sessionKey).toBe(`chat:${largeCount - 1}`);
    expect(readComposerDrafts("large", 200)[0]?.sessionKey).not.toBe("chat:0");
    // A corrupt entry holding a record above the bound drops only that record.
    localStorage.setItem(composerDraftStorageKey("a"), JSON.stringify({ version: 1, records: [
      { sessionKey: key, draft: "x".repeat(COMPOSER_DRAFT_MAX_RECORD_SIZE), savedAt: 201 },
      { sessionKey: composerSessionKey("small"), draft: "small", savedAt: 201 }] }));
    expect(readComposerDrafts("a", 202).map(record => record.sessionKey)).toEqual(["chat:small"]);
  });

  it("merges a tab's changed keys with the latest entry and lets the last writer win", () => {
    writeComposerDrafts("a", new Map([[key, "tab one"]]), 1);
    writeComposerDrafts("a", new Map([[composerSessionKey("two"), "independent"]]), 2);
    writeComposerDrafts("a", new Map([[key, "tab two"]]), 3);
    expect(readComposerDrafts("a", 3).map(record => record.draft)).toEqual(["independent", "tab two"]);
    writeComposerDrafts("a", new Map([[key, null]]), 4);
    expect(readComposerDrafts("a", 4).map(record => record.draft)).toEqual(["independent"]);
  });

  it("tolerates blocked reads and writes, and evicts the oldest on quota failure", () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (value.length > 170) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, name, value);
    });
    writeComposerDrafts("a", new Map([[key, "first"]]), 1);
    expect(() => writeComposerDrafts("a", new Map([[composerSessionKey("second"), "latest".repeat(8)]]), 2)).not.toThrow();
    expect(readComposerDrafts("a", 2).map(record => record.sessionKey)).toEqual(["chat:second"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(readComposerDrafts("a")).toEqual([]);
    expect(() => writeComposerDrafts("a", new Map([[key, "x".repeat(200)]]))).not.toThrow();
  });

  it("rejects stale text left by an interrupted writer and bounds fences without reusing epochs", () => {
    const oldEpoch = replaceComposerDraftEpoch("a");
    writeComposerDrafts("a", new Map([[key, "stale text"]]));
    const staleRecord = localStorage.getItem(composerDraftStorageKey("a"))!;
    replaceComposerDraftEpoch("a");
    // Simulate a renderer writing its captured payload then terminating before
    // it can run the post-write check.
    localStorage.setItem(composerDraftStorageKey("a"), staleRecord);
    expect(readComposerDrafts("a")).toEqual([]);
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
    expect(readComposerDraftEpoch("a")).not.toBe(oldEpoch);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    for (let index = 0; index < 50; index++) replaceComposerDraftEpoch(`new-${index}`);
    expect(Object.keys(localStorage).filter(name => name.startsWith("aiqsa.composerDraftEpoch.v1:"))).toHaveLength(50);
    expect(readComposerDraftEpoch("a")).toBeNull();
    expect(replaceComposerDraftEpoch("a")).not.toBe(oldEpoch);
  });

  it("writes the same first fence in every tab and marks only a sign-out, which a later sign-in clears", () => {
    expect(createInitialComposerDraftEpoch("a")).toBe(COMPOSER_DRAFT_INITIAL_EPOCH);
    const first = localStorage.getItem(composerDraftEpochKey("a"));
    createInitialComposerDraftEpoch("a");
    expect(localStorage.getItem(composerDraftEpochKey("a"))).toBe(first);
    expect(readComposerDraftEpochState("a")).toEqual({ available: true, epoch: COMPOSER_DRAFT_INITIAL_EPOCH, savedAt: 0, signedOut: false });
    const signedOut = signOutComposerDraftEpoch("a")!;
    expect(signedOut).not.toBe(COMPOSER_DRAFT_INITIAL_EPOCH);
    expect(readComposerDraftEpochState("a")).toMatchObject({ epoch: signedOut, signedOut: true });
    expect(resumeComposerDraftEpoch("a", signedOut)).toBe(signedOut);
    expect(readComposerDraftEpochState("a")).toMatchObject({ epoch: signedOut, signedOut: false });
  });

  it("reports changes storage refused as unsaved, never an oversized input", () => {
    writeComposerDrafts("a", new Map([[key, "stored"]]), 1);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const oversized = "x".repeat(COMPOSER_DRAFT_MAX_RECORD_SIZE);
    const other = composerSessionKey("other");
    expect(writeComposerDrafts("a", new Map([[key, "newer"], [other, oversized]]), 2)).toEqual({ tooLarge: [other], unsaved: [key] });
    setItem.mockRestore();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(writeComposerDrafts("a", new Map([[key, null]]), 3)).toEqual({ tooLarge: [], unsaved: [key] });
  });
});

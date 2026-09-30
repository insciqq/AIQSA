import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerDraftEpochKey, createInitialComposerDraftEpoch, readComposerDraftEpoch, replaceComposerDraftEpoch, resumeComposerDraftEpoch,
  signOutComposerDraftEpoch } from "./composerDraftStorage";
import { AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY, clearSessionExpiredDraft, clearSessionExpiredDraftForSession, rememberSessionExpiredDraft, storedSessionExpiredDraft } from "./shellStorage";

describe("session-expired draft handoff", () => {
  beforeEach(() => { replaceComposerDraftEpoch("account-a"); });
  it.each(["rotated", "removed", "signed out"])("discards a login-page handoff whose logout boundary was %s in another tab", mode => {
    const epoch = readComposerDraftEpoch("account-a")!;
    rememberSessionExpiredDraft({ accountId: "account-a", epoch, draft: "Private draft",
      comments: [{ id: "comment", quote: "Fragment", text: "Private comment" }], savedAt: Date.now(), sessionKey: "blank:root" });
    if (mode === "rotated") replaceComposerDraftEpoch("account-a");
    else if (mode === "signed out") signOutComposerDraftEpoch("account-a");
    else localStorage.removeItem(composerDraftEpochKey("account-a"));
    expect(storedSessionExpiredDraft()).toBeNull();
    expect(sessionStorage.getItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY)).toBeNull();
    rememberSessionExpiredDraft({ accountId: "account-a", epoch, draft: "Stale late handoff", savedAt: Date.now(), sessionKey: "blank:root" });
    expect(sessionStorage.getItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY)).toBeNull();
  });
  it("keeps an account-only handoff while localStorage is unavailable", () => {
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (this === window.localStorage) throw new DOMException("Blocked", "SecurityError");
      return getItem.call(this, key);
    });
    const handoff = { accountId: "account-a", epoch: null, draft: "Unsent", savedAt: Date.now(), sessionKey: "blank:root" as const };
    rememberSessionExpiredDraft(handoff);
    expect(storedSessionExpiredDraft()).toEqual(handoff);
  });
  it("accepts an account-only handoff only while no sign-out follows it", () => {
    localStorage.removeItem(composerDraftEpochKey("account-a"));
    const handoff = { accountId: "account-a", epoch: null, draft: "Unsent", savedAt: Date.now(), sessionKey: "blank:root" as const };
    rememberSessionExpiredDraft(handoff);
    // The next document creates the first fence, dated before any handoff.
    createInitialComposerDraftEpoch("account-a");
    expect(storedSessionExpiredDraft()).toEqual(handoff);
    // A sign-out, then a sign-in, after the handoff was saved.
    vi.spyOn(Date, "now").mockReturnValue(handoff.savedAt + 1);
    const epoch = signOutComposerDraftEpoch("account-a")!;
    expect(storedSessionExpiredDraft()).toBeNull();
    rememberSessionExpiredDraft(handoff);
    resumeComposerDraftEpoch("account-a", epoch);
    expect(storedSessionExpiredDraft()).toBeNull();
    rememberSessionExpiredDraft(handoff);
    expect(storedSessionExpiredDraft()).toBeNull();
  });
  it("clears only the transferred session's handoff", () => {
    rememberSessionExpiredDraft({ accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!, draft: "Unsent", savedAt: Date.now(), sessionKey: "chat:source" });
    clearSessionExpiredDraftForSession("chat:other");
    expect(storedSessionExpiredDraft()?.draft).toBe("Unsent");
    clearSessionExpiredDraftForSession("chat:source");
    expect(storedSessionExpiredDraft()).toBeNull();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("round-trips one tab-scoped keyed draft and clears it explicitly", () => {
    rememberSessionExpiredDraft({
      accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    expect(storedSessionExpiredDraft(2_000)).toEqual({
      accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    clearSessionExpiredDraft();
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
  });

  it("discards expired, future, or malformed handoff data", () => {
    rememberSessionExpiredDraft({
      accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
      draft: "Expired",
      savedAt: 1_000,
      sessionKey: "blank:root"
    });
    expect(storedSessionExpiredDraft(1_000 + 31 * 60 * 1000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
        draft: "Future",
        savedAt: 5_000,
        sessionKey: "blank:root"
      })
    );
    expect(storedSessionExpiredDraft(4_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
        draft: "Invalid key",
        savedAt: 1_000,
        sessionKey: "foreign:chat-1"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountId: "account-a", epoch: readComposerDraftEpoch("account-a")!,
        draft: "Invalid encoded key",
        savedAt: 1_000,
        sessionKey: "chat:%E0%A4%A"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
  });
});

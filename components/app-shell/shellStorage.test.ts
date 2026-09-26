import { afterEach, describe, expect, it, vi } from "vitest";
import { AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY, clearSessionExpiredDraft, clearSessionExpiredDraftForSession, rememberSessionExpiredDraft, storedSessionExpiredDraft } from "./shellStorage";

describe("session-expired draft handoff", () => {
  it("clears only the transferred session's handoff", () => {
    rememberSessionExpiredDraft({ accountEmail: "operator@aiqsa.local", draft: "Unsent", savedAt: Date.now(), sessionKey: "chat:source" });
    clearSessionExpiredDraftForSession("chat:other");
    expect(storedSessionExpiredDraft()?.draft).toBe("Unsent");
    clearSessionExpiredDraftForSession("chat:source");
    expect(storedSessionExpiredDraft()).toBeNull();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("round-trips one tab-scoped keyed draft and clears it explicitly", () => {
    rememberSessionExpiredDraft({
      accountEmail: "operator@aiqsa.local",
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    expect(storedSessionExpiredDraft(2_000)).toEqual({
      accountEmail: "operator@aiqsa.local",
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    clearSessionExpiredDraft();
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
  });

  it("discards expired, future, or malformed handoff data", () => {
    rememberSessionExpiredDraft({
      accountEmail: "operator@aiqsa.local",
      draft: "Expired",
      savedAt: 1_000,
      sessionKey: "blank:root"
    });
    expect(storedSessionExpiredDraft(1_000 + 31 * 60 * 1000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Future",
        savedAt: 5_000,
        sessionKey: "blank:root"
      })
    );
    expect(storedSessionExpiredDraft(4_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Invalid key",
        savedAt: 1_000,
        sessionKey: "foreign:chat-1"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Invalid encoded key",
        savedAt: 1_000,
        sessionKey: "chat:%E0%A4%A"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
  });
});

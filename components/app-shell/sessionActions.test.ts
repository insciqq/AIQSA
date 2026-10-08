import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutCurrentSession } from "./sessionActions";
import { shellFetch, subscribeToSessionExpired } from "./shellApi";
import { clearSignedOutComposerDrafts, startComposerDraftPersistence } from "./composerDraftPersistence";
import { composerDraftEpochKey, composerDraftStorageKey, readComposerDraftEpoch, readComposerDrafts, replaceComposerDraftEpoch,
  writeComposerDrafts } from "./composerDraftStorage";
import { composerSessionKey, selectComposerSession, useComposerSessionStore } from "./composerSessionStore";
import { AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY } from "./shellStorage";

const root = composerSessionKey(null);
const comments = [{ id: "pending-comment", quote: "selected fragment", text: "pending comment" }];
const signedOut = () => vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

afterEach(() => {
  clearSignedOutComposerDrafts();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signOutCurrentSession", () => {
  it("preserves pending drafts on failed logout and clears them before successful navigation", async () => {
    startComposerDraftPersistence("logout-account");
    useComposerSessionStore.getState().setDraft("Unsent text");
    window.dispatchEvent(new Event("pagehide"));
    await signOutCurrentSession({ accountId: "logout-account", fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 503 })), navigate: vi.fn() });
    expect(readComposerDrafts("logout-account")[0]?.draft).toBe("Unsent text");
    useComposerSessionStore.getState().setDraft("Debounced change");
    const navigate = vi.fn(() => {
      window.dispatchEvent(new Event("pagehide"));
      expect(readComposerDrafts("logout-account")).toEqual([]);
      expect(localStorage.getItem("aiqsa.composerDrafts.v1:logout-account")).toBeNull();
    });
    await expect(signOutCurrentSession({ accountId: "logout-account", fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })), navigate })).resolves.toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("clears the named account's drafts, fence and handoff in a document without chat-shell draft state", async () => {
    // Control Center is a full page load: no draft observer ever started here.
    const adminEpoch = replaceComposerDraftEpoch("admin-account");
    const otherEpoch = replaceComposerDraftEpoch("other-account");
    writeComposerDrafts("admin-account", new Map([[root, { draft: "Admin draft", comments }]]));
    writeComposerDrafts("other-account", new Map([[root, "Other account draft"]]));
    sessionStorage.setItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY, "{}");
    const navigate = vi.fn();

    await expect(signOutCurrentSession({ accountId: "admin-account", fetcher: signedOut(), navigate })).resolves.toEqual({ ok: true });

    expect(localStorage.getItem(composerDraftStorageKey("admin-account"))).toBeNull();
    expect(readComposerDraftEpoch("admin-account")).toMatch(/^[a-f\d-]{36}$/u);
    expect(readComposerDraftEpoch("admin-account")).not.toBe(adminEpoch);
    expect(sessionStorage.getItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY)).toBeNull();
    expect(readComposerDrafts("other-account").map(record => record.draft)).toEqual(["Other account draft"]);
    expect(readComposerDraftEpoch("other-account")).toBe(otherEpoch);
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it.each(["timer", "storage"])("keeps another tab of the signed-out account from writing its draft back (%s)", async (trigger) => {
    vi.useFakeTimers();
    // This module instance is the chat tab; a reset module graph is the
    // freshly loaded Control Center document sharing the same localStorage.
    startComposerDraftPersistence("admin-account");
    useComposerSessionStore.getState().updateSession(root, { draft: "Chat tab text", comments });
    window.dispatchEvent(new Event("pagehide"));
    expect(readComposerDrafts("admin-account")[0]?.draft).toBe("Chat tab text");
    vi.resetModules();
    const controlCenter = await import("./sessionActions");

    await controlCenter.signOutCurrentSession({ accountId: "admin-account", fetcher: signedOut(), navigate: vi.fn() });
    expect(localStorage.getItem(composerDraftStorageKey("admin-account"))).toBeNull();

    if (trigger === "timer") {
      useComposerSessionStore.getState().setDraft("Typed in the chat tab after sign-out");
      vi.advanceTimersByTime(250);
    } else {
      window.dispatchEvent(new StorageEvent("storage", { key: composerDraftEpochKey("admin-account") }));
    }
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(composerDraftStorageKey("admin-account"))).toBeNull();
    expect(selectComposerSession(useComposerSessionStore.getState(), root)).toMatchObject({ draft: "", comments: [] });
  });

  it("clears every account's drafts and fences when the surface cannot name the account", async () => {
    replaceComposerDraftEpoch("first-account");
    writeComposerDrafts("first-account", new Map([[root, "First draft"]]));
    writeComposerDrafts("second-account", new Map([[root, { draft: "", comments }]]));
    localStorage.setItem("aiqsa.theme", "dark");

    await signOutCurrentSession({ accountId: null, fetcher: signedOut(), navigate: vi.fn() });

    expect(Object.keys(localStorage)).toEqual(["aiqsa.theme"]);
  });

  it("clears private and public artifact state only after successful logout, preserving other browser preferences", async () => {
    localStorage.setItem("aiqsa.artifact.state.private-id", "private progress");
    localStorage.setItem("aiqsa.artifact.state.pub.abcdef0123456789", "viewer progress");
    localStorage.setItem("aiqsa.artifact.state.$index", "[]");
    localStorage.setItem("aiqsa.theme", "dark");
    const navigate = vi.fn();
    await signOutCurrentSession({ accountId: null, fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 503 })), navigate });
    expect(localStorage.getItem("aiqsa.artifact.state.private-id")).toBe("private progress");
    await signOutCurrentSession({ accountId: null, fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })), navigate });
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("aiqsa.theme")).toBe("dark");
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("revokes through the JSON same-site route before navigating to login", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const navigate = vi.fn();

    await expect(signOutCurrentSession({ accountId: "account-1", fetcher, navigate })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", {
      body: "{}",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      signal: expect.any(AbortSignal)
    });
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("continues to the identity provider's logout page the server names, and to /login otherwise", async () => {
    const navigate = vi.fn();
    const target = "https://idp.example/realms/main/protocol/openid-connect/logout?client_id=aiqsa&post_logout_redirect_uri=https%3A%2F%2Faiqsa.example%2Flogin";
    await signOutCurrentSession({ accountId: null, fetcher: vi.fn().mockResolvedValue(Response.json({ redirectTo: target })), navigate });
    expect(navigate).toHaveBeenLastCalledWith(target);

    for (const redirectTo of ["javascript:alert(1)", "/relative", 42]) {
      await signOutCurrentSession({ accountId: null, fetcher: vi.fn().mockResolvedValue(Response.json({ redirectTo })), navigate });
      expect(navigate).toHaveBeenLastCalledWith("/login");
    }
  });

  it("keeps other requests' 401s from preempting the identity provider's logout; a failed sign-out resumes them", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSessionExpired(listener);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    try {
      const failed = await signOutCurrentSession({ accountId: null, fetcher: vi.fn().mockRejectedValue(new Error("offline")), navigate: vi.fn() });
      expect(failed.ok).toBe(false);
      await shellFetch("/api/chats");
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();

      const afterLogout = vi.fn();
      const unsubscribeAfter = subscribeToSessionExpired(afterLogout);
      let revoked: () => void = () => undefined;
      const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
        revoked = () => resolve(Response.json({ redirectTo: "https://idp.example/logout" }));
      }));
      const navigate = vi.fn();
      const signingOut = signOutCurrentSession({ accountId: null, fetcher, navigate });
      // The session is already revoked on the server; a request in flight answers 401.
      await shellFetch("/api/chats");
      revoked();
      await signingOut;
      expect(afterLogout).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenLastCalledWith("https://idp.example/logout");
      unsubscribeAfter();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the user in place and preserves a stable backend code on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        headers: { "content-type": "application/json" },
        status: 401
      })
    );
    const navigate = vi.fn();

    const result = await signOutCurrentSession({ accountId: "account-1", fetcher, navigate });

    expect(result).toEqual({
      error: "Your session is no longer valid. Refresh the page or sign in again. (unauthorized)",
      ok: false
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("returns actionable network feedback without navigating", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const navigate = vi.fn();

    const result = await signOutCurrentSession({ accountId: "account-1", fetcher, navigate });

    expect(result).toEqual({
      error: "Could not reach the server. Check your connection and try signing out again. (network_error)",
      ok: false
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("aborts and returns separate actionable timeout feedback when logout hangs", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>(() => {
          // Deliberately ignore the signal: the helper must still settle at its deadline.
        })
    );
    const navigate = vi.fn();

    const pending = signOutCurrentSession({ accountId: "account-1", fetcher, navigate, timeoutMs: 250 });
    const signal = fetcher.mock.calls[0]?.[1]?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual({
      error: "Sign out timed out. Check your connection and try again. (logout_timeout)",
      ok: false
    });
    expect(signal.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("always clears its deadline after a response or network failure", async () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    // No stored drafts: a fence write would add jsdom's storage-event timer.
    await signOutCurrentSession({
      accountId: null,
      fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      navigate,
      timeoutMs: 250
    });
    // Only the session-expiry suppression's own release stays, for a navigation that never leaves.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);

    await signOutCurrentSession({
      accountId: null,
      fetcher: vi.fn().mockRejectedValue(new Error("offline")),
      navigate,
      timeoutMs: 250
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

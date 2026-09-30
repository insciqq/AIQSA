import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSignedOutComposerDrafts, composerDraftRecoveryBoundary, removePersistedComposerDraft, startComposerDraftPersistence } from "./composerDraftPersistence";
import { clearComposerDrafts, COMPOSER_DRAFT_INITIAL_EPOCH, COMPOSER_DRAFT_MAX_RECORD_SIZE, composerDraftEpochKey, composerDraftStorageKey,
  readComposerDraftEpoch, readComposerDraftEpochState, readComposerDrafts, replaceComposerDraftEpoch, signOutComposerDraftEpoch,
  writeComposerDrafts } from "./composerDraftStorage";
import { composerSessionKey, projectComposerSessionKey, selectComposerSession, useComposerSessionStore } from "./composerSessionStore";
import { rememberSessionExpiredDraft, storedSessionExpiredDraft } from "./shellStorage";
import { useWorkspaceActions } from "./workspaceActions";
import { mergeWorkspaceProjectDrafts } from "./workspaceProjectDraftMerge";
import { useChatAssistantProjectionStore } from "./chatAssistantProjectionStore";
import { useWorkspaceStore } from "./workspaceStore";
import { resetChatAssistantProjectionStoreForTest, resetComposerSessionStoreForTest, resetThreadStoreForTest,
  resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";

const root = composerSessionKey(null);
const saved = composerSessionKey("one");
function chat(id: string, memoryMode: "NORMAL" | "TEMPORARY" = "NORMAL") {
  return { id, memoryMode, activeLeafMessageId: null, createdAt: "", defaultModelId: "", defaultProvider: "",
    folderId: null, messageCount: 0, title: "Synthetic", updatedAt: "" };
}
const draft = (key = root) => selectComposerSession(useComposerSessionStore.getState(), key).draft;
function flush() { window.dispatchEvent(new Event("pagehide")); }
function fenceChanged(accountId = "a") { window.dispatchEvent(new StorageEvent("storage", { key: composerDraftEpochKey(accountId) })); }
const otherTabs: (() => void)[] = [];
/** A fresh module graph is another document sharing this localStorage. */
async function openOtherTab() {
  vi.resetModules();
  const persistence = await import("./composerDraftPersistence");
  const { useComposerSessionStore: sessions } = await import("./composerSessionStore");
  otherTabs.push(() => persistence.clearSignedOutComposerDrafts("other-tab-cleanup"));
  return { ...persistence, draft: (key = root) => selectComposerSession(sessions.getState(), key).draft, sessions };
}
/** Everything the page loaded with preceded `time`. */
function documentLoadedAfter(time: number) { vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(time + 1); }
function blockLocalStorage() {
  const { getItem, setItem, removeItem } = Storage.prototype;
  const blocked = function (this: Storage) { if (this === window.localStorage) throw new DOMException("Blocked", "SecurityError"); };
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) { blocked.call(this); return getItem.call(this, key); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { blocked.call(this); setItem.call(this, key, value); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) { blocked.call(this); removeItem.call(this, key); });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of otherTabs.splice(0)) stop();
  clearSignedOutComposerDrafts();
  resetComposerSessionStoreForTest();
  resetWorkspaceStoreForTest();
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("composer draft persistence lifecycle", () => {
  it("never captures a replacement logout boundary for an expired-session handoff", () => {
    startComposerDraftPersistence("a");
    expect(composerDraftRecoveryBoundary("a")).toEqual({ epoch: readComposerDraftEpoch("a") });
    expect(composerDraftRecoveryBoundary("b")).toBeNull();
    replaceComposerDraftEpoch("a");
    // No storage event has arrived yet; the stale observer must still refuse.
    expect(composerDraftRecoveryBoundary("a")).toBeNull();
  });
  it("persists comment-only input through continuation, send rejection and logout", () => {
    const comments = [{ id: "stored-comment", quote: "selected fragment", text: "my comment" }];
    startComposerDraftPersistence("a");
    const store = useComposerSessionStore.getState();
    store.updateSession(root, { comments });
    flush();
    expect(readComposerDrafts("a")[0]).toMatchObject({ draft: "", comments });
    const target = composerSessionKey("comment-target");
    useWorkspaceStore.getState().setChats([chat("comment-target")]);
    expect(store.moveUnsentInputIfTargetEmpty(root, target)).toBe(true);
    expect(readComposerDrafts("a").find(record => record.sessionKey === target)?.comments).toEqual(comments);
    const token = store.beginSend(target)!;
    expect(readComposerDrafts("a")).toEqual([]);
    store.finishSend(token, "failed");
    flush();
    expect(readComposerDrafts("a")[0]?.comments).toEqual(comments);
    clearSignedOutComposerDrafts();
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
  });

  it("hydrates stored comments only when the target input is empty and excludes temporary comments", () => {
    const comments = [{ id: "restored-comment", quote: "fragment", text: "note" }];
    writeComposerDrafts("a", new Map([[root, { draft: "", comments }], [saved, { draft: "old", comments }]]));
    startComposerDraftPersistence("a");
    expect(selectComposerSession(useComposerSessionStore.getState(), root).comments).toEqual(comments);
    const store = useComposerSessionStore.getState();
    store.activateSession(saved);
    store.setDraft("newer typed text");
    useWorkspaceStore.getState().setChats([chat("one")]);
    expect(selectComposerSession(useComposerSessionStore.getState(), saved)).toMatchObject({ draft: "newer typed text", comments: [] });
    store.activateSession(composerSessionKey(null, null, "TEMPORARY"));
    store.addComment(composerSessionKey(null, null, "TEMPORARY"), { quote: "temporary", text: "private" });
    flush();
    expect(JSON.stringify(readComposerDrafts("a"))).not.toContain("private");
  });
  it("restores only text to existing sessions, without activation or focus, after workspace metadata arrives", () => {
    const project = projectComposerSessionKey("project");
    writeComposerDrafts("a", new Map([[root, "blank"], [saved, "saved"], [project, "project draft"]]));
    const store = useComposerSessionStore.getState();
    store.activateSession(saved);
    startComposerDraftPersistence("a");
    expect(draft()).toBe("blank");
    expect(draft(saved)).toBe("");
    useWorkspaceStore.getState().setChats([chat("one")]);
    expect(draft(saved)).toBe("saved");
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(saved);
    expect(selectComposerSession(useComposerSessionStore.getState(), saved)).toMatchObject({ attachments: [], editingDraft: "", workspaceEnabled: false });
    store.activateSession(project);
    expect(draft(project)).toBe("project draft");
    expect(document.activeElement).toBe(document.body);
  });

  it("never overwrites typing or an intentional clear before restoration becomes possible", () => {
    writeComposerDrafts("a", new Map([[saved, "old text"]]));
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.activateSession(saved);
    store.setDraft("new text");
    store.setDraft("");
    useWorkspaceStore.getState().setChats([chat("one")]);
    expect(draft(saved)).toBe("");
    flush();
    expect(readComposerDrafts("a")).toEqual([]);
  });

  it("debounces writes, flushes on hide, removes submitted text and stores a rejected send again", () => {
    vi.useFakeTimers();
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.setDraft("first");
    store.setDraft("latest");
    expect(readComposerDrafts("a")).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(readComposerDrafts("a")[0]?.draft).toBe("latest");
    const token = store.beginSend(root)!;
    expect(readComposerDrafts("a")).toEqual([]);
    store.finishSend(token, "failed", "Synthetic rejection");
    flush();
    expect(readComposerDrafts("a")[0]?.draft).toBe("latest");
    const retry = store.beginSend(root)!;
    store.setDraft("next message");
    store.finishSend(retry, "succeeded", null, true, "run");
    flush();
    expect(readComposerDrafts("a")[0]?.draft).toBe("next message");
  });

  it("moves continuation input and removes deleted chats even without a materialized session", () => {
    useWorkspaceStore.getState().setChats([chat("one"), chat("two")]);
    writeComposerDrafts("a", new Map([[composerSessionKey("unopened"), "delete me"]]));
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.activateSession(saved);
    store.setDraft("continue here");
    flush();
    expect(store.moveUnsentInputIfTargetEmpty(saved, composerSessionKey("two"))).toBe(true);
    expect(readComposerDrafts("a").find(record => record.sessionKey === saved)).toBeUndefined();
    expect(readComposerDrafts("a").find(record => record.sessionKey === "chat:two")?.draft).toBe("continue here");
    removePersistedComposerDraft(composerSessionKey("unopened"));
    store.removeSession(composerSessionKey("two"));
    expect(readComposerDrafts("a")).toEqual([]);
  });

  it("never stores temporary text, attachments or inline edits", () => {
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.startEdit("message", "inline edit");
    store.setAttachments([{ id: "file", fileName: "synthetic.txt", kind: "document" }]);
    flush();
    expect(readComposerDrafts("a")).toEqual([]);
    for (const key of [composerSessionKey(null, null, "TEMPORARY"), composerSessionKey("temporary")]) {
      useWorkspaceStore.getState().setChats([chat("temporary", "TEMPORARY")]);
      store.activateSession(key);
      store.setDraft("private temporary input");
      flush();
    }
    expect(readComposerDrafts("a")).toEqual([]);
  });

  it("isolates account changes and stops pending writes before explicit sign-out", () => {
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.setDraft("a draft");
    flush();
    writeComposerDrafts("b", new Map([[root, "b draft"]]));
    startComposerDraftPersistence("b");
    expect(draft()).toBe("b draft");
    store.setDraft("b changed");
    clearSignedOutComposerDrafts();
    flush();
    expect(readComposerDrafts("b")).toEqual([]);
    expect(readComposerDrafts("a")[0]?.draft).toBe("a draft");
    expect(draft()).toBe("");
  });

  it("clears the account the signing-out surface names and leaves another account's entry", () => {
    const store = useComposerSessionStore.getState();
    startComposerDraftPersistence("a");
    store.setDraft("a draft");
    flush();
    const bEpoch = replaceComposerDraftEpoch("b");
    writeComposerDrafts("b", new Map([[root, "b draft"]]));
    store.setDraft("a pending change");
    clearSignedOutComposerDrafts("b");
    flush();
    expect(localStorage.getItem(composerDraftStorageKey("b"))).toBeNull();
    expect(readComposerDraftEpoch("b")).not.toBe(bEpoch);
    // The stopped observer neither writes its pending change nor loses the stored entry.
    expect(readComposerDrafts("a")[0]?.draft).toBe("a draft");
    expect(draft()).toBe("");
  });

  it("does not overwrite another tab or renew savedAt when its observer remounts untouched", () => {
    vi.useFakeTimers();
    const savedAt = Date.now() - 1000;
    writeComposerDrafts("a", new Map([[root, "original"]]), savedAt);
    const stop = startComposerDraftPersistence("a");
    expect(draft()).toBe("original");
    stop();
    writeComposerDrafts("a", new Map([[root, "other tab"]]));
    const latest = readComposerDrafts("a");
    startComposerDraftPersistence("a");
    vi.advanceTimersByTime(500);
    flush();
    expect(readComposerDrafts("a")).toEqual(latest);
    expect(draft()).toBe("original");
  });

  it.each(["timer", "storage", "detached", "visible"])("fences a previous tab's draft after logout via %s", (trigger) => {
    vi.useFakeTimers();
    const stop = startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("saved input");
    flush();
    if (trigger === "timer") useComposerSessionStore.getState().setDraft("pending input");
    if (trigger === "detached") stop();
    // A different tab marks the content-free fence signed out before clearing drafts.
    signOutComposerDraftEpoch("a");
    clearComposerDrafts("a");
    if (trigger === "timer") vi.advanceTimersByTime(250);
    else if (trigger === "detached") startComposerDraftPersistence("a");
    else if (trigger === "visible") document.dispatchEvent(new Event("visibilitychange"));
    else fenceChanged();
    flush();
    expect(readComposerDrafts("a")).toEqual([]);
    expect(draft()).toBe("");
    // Until the account signs in again, nothing this tab holds is stored.
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("stale observer restart");
    flush();
    vi.advanceTimersByTime(500);
    expect(readComposerDrafts("a")).toEqual([]);
  });

  it("removes a stale write when another tab logs out between its storage read and write", () => {
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("pending before logout");
    const oldEpoch = readComposerDraftEpoch("a");
    const setItem = Storage.prototype.setItem;
    let interrupted = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (!interrupted && key === composerDraftStorageKey("a")) {
        interrupted = true;
        // Another renderer finishes logout after this tab read its record,
        // immediately before the native stale setItem commits.
        signOutComposerDraftEpoch("a");
        clearComposerDrafts("a");
      }
      setItem.call(this, key, value);
    });
    flush();
    expect(interrupted).toBe(true);
    expect(readComposerDraftEpoch("a")).not.toBe(oldEpoch);
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
    expect(draft()).toBe("");
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("stale tab cannot resume");
    flush();
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
  });

  it("does not classify the next account's chat from the preceding account's cached rows", () => {
    useWorkspaceStore.getState().setChats([chat("one")]);
    useWorkspaceStore.getState().setCatalog(null, "a");
    startComposerDraftPersistence("a");
    writeComposerDrafts("b", new Map([[saved, "b's stored input"]]));
    startComposerDraftPersistence("b");
    useComposerSessionStore.getState().activateSession(saved);
    expect(draft(saved)).toBe("");
    useWorkspaceStore.getState().setCatalog(null, "b");
    expect(draft(saved)).toBe("");
    useWorkspaceStore.getState().setChats([chat("one")]);
    expect(draft(saved)).toBe("b's stored input");
  });

  it("keeps in-memory input when epoch storage is temporarily unavailable", () => {
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("keep while storage is blocked");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    flush();
    expect(draft()).toBe("keep while storage is blocked");
  });
});

describe("composer draft persistence across tabs, sign-in and failing storage", () => {
  it("lets two tabs that start at the same moment without a fence both persist, and restores each draft after a reload", async () => {
    const project = projectComposerSessionKey("project");
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("first tab text");
    // The second document read the missing fence before the first one's write
    // became visible to it, and writes its own first fence afterwards.
    const getItem = Storage.prototype.getItem;
    let staleReads = 1;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (staleReads && key === composerDraftEpochKey("a")) { staleReads--; return null; }
      return getItem.call(this, key);
    });
    const second = await openOtherTab();
    second.startComposerDraftPersistence("a");
    expect(staleReads).toBe(0);
    fenceChanged();
    expect(readComposerDraftEpochState("a")).toMatchObject({ epoch: COMPOSER_DRAFT_INITIAL_EPOCH, signedOut: false });

    second.sessions.getState().activateSession(project);
    second.sessions.getState().setDraft("second tab text");
    flush();
    expect(draft()).toBe("first tab text");
    expect(second.draft(project)).toBe("second tab text");

    const reloaded = await openOtherTab();
    reloaded.startComposerDraftPersistence("a");
    reloaded.sessions.getState().activateSession(project);
    expect(reloaded.draft()).toBe("first tab text");
    expect(reloaded.draft(project)).toBe("second tab text");
  });

  it("keeps a signed-out tab from writing its text back and resumes it after the account signs in again", async () => {
    vi.useFakeTimers();
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("typed before sign-out");
    flush();
    const signingOut = await openOtherTab();
    signingOut.clearSignedOutComposerDrafts("a");
    fenceChanged();
    expect(draft()).toBe("");
    expect(composerDraftRecoveryBoundary("a")).toBeNull();
    useComposerSessionStore.getState().setDraft("typed while signed out");
    vi.advanceTimersByTime(250);
    flush();
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();

    // The sign-in loads a new document after the sign-out.
    documentLoadedAfter(readComposerDraftEpochState("a").savedAt);
    const signedIn = await openOtherTab();
    signedIn.startComposerDraftPersistence("a");
    expect(readComposerDraftEpochState("a").signedOut).toBe(false);
    fenceChanged();
    useComposerSessionStore.getState().setDraft("typed after sign-in");
    vi.advanceTimersByTime(250);
    expect(readComposerDrafts("a").map(record => record.draft)).toEqual(["typed after sign-in"]);
    expect(composerDraftRecoveryBoundary("a")).toEqual({ epoch: readComposerDraftEpoch("a") });
  });

  it("drops the memory of a tab that missed a sign-out and the sign-in after it before writing again", () => {
    vi.useFakeTimers();
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("typed before sign-out");
    flush();
    useComposerSessionStore.getState().setDraft("pending stale text");
    // Neither change reaches this frozen tab as a storage event.
    const epoch = signOutComposerDraftEpoch("a")!;
    clearComposerDrafts("a");
    writeComposerDrafts("a", new Map([[saved, "written after sign-in elsewhere"]]));
    localStorage.setItem(composerDraftEpochKey("a"), JSON.stringify({ epoch, savedAt: Date.now() }));
    vi.advanceTimersByTime(250);
    expect(draft()).toBe("");
    expect(JSON.stringify(readComposerDrafts("a"))).not.toContain("stale");
    useComposerSessionStore.getState().setDraft("typed after resuming");
    flush();
    expect(readComposerDrafts("a").map(record => record.draft).sort()).toEqual(["typed after resuming", "written after sign-in elsewhere"]);
  });

  it("starts a document revoked when a sign-out was stored after it loaded, and resumes one loaded after the sign-out", () => {
    signOutComposerDraftEpoch("a");
    const signedOutAt = readComposerDraftEpochState("a").savedAt;
    documentLoadedAfter(signedOutAt - 2);
    useComposerSessionStore.getState().setDraft("rendered before the sign-out");
    startComposerDraftPersistence("a");
    expect(draft()).toBe("");
    useComposerSessionStore.getState().setDraft("typed in the ended session");
    flush();
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
    expect(readComposerDraftEpochState("a").signedOut).toBe(true);

    clearSignedOutComposerDrafts("b");
    documentLoadedAfter(readComposerDraftEpochState("a").savedAt);
    startComposerDraftPersistence("a");
    expect(readComposerDraftEpochState("a").signedOut).toBe(false);
    useComposerSessionStore.getState().setDraft("typed after sign-in");
    flush();
    expect(readComposerDrafts("a")[0]?.draft).toBe("typed after sign-in");
  });

  it("keeps a failed write pending until a later flush stores it, and never retries an oversized input", () => {
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("older text");
    flush();
    useComposerSessionStore.getState().setDraft("newer text");
    const setItem = Storage.prototype.setItem;
    let failing = true;
    const writes = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (failing && key === composerDraftStorageKey("a")) throw new DOMException("Full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    flush();
    expect(readComposerDrafts("a")[0]?.draft).toBe("older text");
    failing = false;
    flush();
    expect(readComposerDrafts("a")[0]?.draft).toBe("newer text");

    useComposerSessionStore.getState().setDraft("x".repeat(COMPOSER_DRAFT_MAX_RECORD_SIZE));
    flush();
    writes.mockClear();
    flush();
    expect(writes).not.toHaveBeenCalled();
    expect(readComposerDrafts("a")[0]?.draft).toBe("newer text");
  });

  it("hands off an account-only draft while localStorage is unavailable and adopts the first fence once it returns", () => {
    blockLocalStorage();
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("kept in memory");
    flush();
    expect(draft()).toBe("kept in memory");
    expect(composerDraftRecoveryBoundary("a")).toEqual({ epoch: null });
    rememberSessionExpiredDraft({ accountId: "a", epoch: null, draft: "kept in memory", savedAt: Date.now(), sessionKey: root });
    expect(storedSessionExpiredDraft()?.draft).toBe("kept in memory");

    vi.restoreAllMocks();
    flush();
    expect(readComposerDraftEpoch("a")).toBe(COMPOSER_DRAFT_INITIAL_EPOCH);
    expect(readComposerDrafts("a")[0]?.draft).toBe("kept in memory");
  });

  it("keeps the memory of a tab whose storage was unreadable at start when the only sign-out preceded its load", () => {
    blockLocalStorage();
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("typed while storage was blocked");
    vi.restoreAllMocks();
    signOutComposerDraftEpoch("a");
    documentLoadedAfter(readComposerDraftEpochState("a").savedAt);
    flush();
    expect(readComposerDraftEpochState("a").signedOut).toBe(false);
    expect(readComposerDrafts("a")[0]?.draft).toBe("typed while storage was blocked");
  });

  it("stores the sign-out fence even when full storage first refuses it", () => {
    startComposerDraftPersistence("a");
    useComposerSessionStore.getState().setDraft("text filling the storage");
    flush();
    const { setItem, removeItem } = Storage.prototype;
    let full = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (full) throw new DOMException("Full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
      removeItem.call(this, key);
      if (key === composerDraftStorageKey("a")) full = false;
    });
    clearSignedOutComposerDrafts("a");
    expect(localStorage.getItem(composerDraftStorageKey("a"))).toBeNull();
    expect(readComposerDraftEpochState("a").signedOut).toBe(true);
  });
});

describe("a Project chat opened by its address", () => {
  it("restores its stored draft when the personal workspace refresh finishes first, and a later personal refresh keeps it", async () => {
    resetThreadStoreForTest();
    resetChatAssistantProjectionStoreForTest();
    const projectChat = { ...chat("project-chat"), projectId: "project-1" };
    const key = composerSessionKey(projectChat.id);
    writeComposerDrafts("a", new Map([[key, "stored Project draft"]]));
    window.history.replaceState(null, "", "/p/project-1/c/project-chat");
    let respond: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/chats") return Response.json({ error: "unexpected" }, { status: 500 });
      if (respond === null) return Response.json({ chats: [], contentMatches: [], folders: [] });
      return new Promise<Response>(resolve => { respond = () => resolve(Response.json({ chats: [], contentMatches: [], folders: [] })); });
    }));
    const actions = useWorkspaceActions({
      activeChatIdRef: { current: null }, applyModelControlDefaults: vi.fn(), chatDetailRequestsRef: { current: new Map() },
      chatHasActiveStream: () => false, chatMutation: { editingTitle: "", finishEditing: vi.fn() },
      loadingChatDetailIdRef: { current: null }, resumeChatRun: vi.fn(), setNotice: vi.fn(), setSelectedKnowledgePlan: vi.fn(),
      setSelectedModelId: vi.fn(), setSelectedProvider: vi.fn(), setSelectedSearchPlan: vi.fn(), workspaceRefreshPromiseRef: { current: null }
    });
    startComposerDraftPersistence("a");
    try {
      // A Project address first loads the personal workspace, which prunes.
      await actions.refreshWorkspace(null);
      expect(readComposerDrafts("a")[0]?.draft).toBe("stored Project draft");
      // Another personal read starts before the Project owner admits its chat.
      respond = () => {};
      const laterRefresh = actions.refreshWorkspace();
      const store = useWorkspaceStore.getState();
      store.setChats(mergeWorkspaceProjectDrafts({ currentChats: store.chats, incomingChats: [projectChat], projectId: "project-1" }).chats);
      useChatAssistantProjectionStore.getState().setProjection(projectChat.id, null);
      await actions.activateChat(projectChat, { preserveControls: true, resumeRuns: false });
      expect(draft(key)).toBe("stored Project draft");
      (respond as () => void)();
      await laterRefresh;
      flush();
      expect(draft(key)).toBe("stored Project draft");
      expect(readComposerDrafts("a").map(record => record.draft)).toEqual(["stored Project draft"]);
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", "/");
    }
  });
});

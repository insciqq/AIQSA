import { clearAllComposerDraftStorage, clearComposerDrafts, composerDraftEpochKey, createInitialComposerDraftEpoch,
  readComposerDraftEpochState, readComposerDrafts, resumeComposerDraftEpoch, signOutComposerDraftEpoch, writeComposerDrafts,
  type StoredComposerInput } from "./composerDraftStorage";
import { chatIdFromComposerSessionKey, composerSessionModeFromKey, useComposerSessionStore, type ComposerSessionKey } from "./composerSessionStore";
import { clearSessionExpiredDraft } from "./shellStorage";
import { useWorkspaceStore } from "./workspaceStore";

const WRITE_DELAY_MS = 250;
type DraftScope = {
  accountId: string;
  dirty: Map<ComposerSessionKey, StoredComposerInput | null>;
  /** The logout fence this document adopted; null while storage cannot hold one. */
  epoch: string | null;
  observedSessions: ReturnType<typeof useComposerSessionStore.getState>["sessionsByKey"];
  restored: Set<ComposerSessionKey>;
  revoked: boolean;
  staleChats: WeakSet<object>;
  touched: Set<ComposerSessionKey>;
};
// Keep restoration and edit bookkeeping across effect cleanup/restart. A
// remounted observer must not turn untouched restored text into a new write.
let scope: DraftScope | null = null;
let active: { accountId: string; dispose(): void; remove(key: ComposerSessionKey): void } | null = null;

function createScope(accountId: string, epoch: string | null, revoked: boolean, staleChats: WeakSet<object>): DraftScope {
  return { accountId, dirty: new Map(), epoch, observedSessions: {}, restored: new Set(), revoked, staleChats, touched: new Set() };
}

/** Navigation start: a sign-out stored before it preceded the request that
 * authenticated this document; a later one ended this document's session. */
function documentStartedAt(): number {
  return typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : 0;
}

function startupFence(accountId: string): { epoch: string | null; revoked: boolean } {
  const fence = readComposerDraftEpochState(accountId);
  if (!fence.available) return { epoch: null, revoked: false };
  if (fence.epoch === null) return { epoch: createInitialComposerDraftEpoch(accountId), revoked: false };
  if (!fence.signedOut) return { epoch: fence.epoch, revoked: false };
  if (fence.savedAt < documentStartedAt()) return { epoch: resumeComposerDraftEpoch(accountId, fence.epoch), revoked: false };
  return { epoch: null, revoked: true };
}

function resetComposerSessions() {
  useComposerSessionStore.setState({ sessionsByKey: useComposerSessionStore.getInitialState().sessionsByKey,
    activeSessionKey: useComposerSessionStore.getInitialState().activeSessionKey });
}

/** Unknown chats wait for the workspace's authorized classification. Temporary
 * chats are explicitly marked before their composer is opened/admitted. */
export function composerDraftPersistenceAllowed(key: ComposerSessionKey): boolean {
  if (composerSessionModeFromKey(key) === "TEMPORARY") return false;
  const chatId = chatIdFromComposerSessionKey(key);
  if (!chatId) return true;
  const workspace = useWorkspaceStore.getState();
  if (scope && workspace.catalogAccountId !== null && workspace.catalogAccountId !== scope.accountId) return false;
  const chat = workspace.chats.find(candidate => candidate.id === chatId);
  return Boolean(chat && !scope?.staleChats.has(chat) && chat.memoryMode !== "TEMPORARY" && chat.pendingInitialMemoryMode !== "TEMPORARY" &&
    chat.pendingPersonalDraft?.memoryMode !== "TEMPORARY");
}

/** Mounted after hydration, with the authenticated account. This observes the
 * existing session owner rather than adding a second draft state store. */
export function startComposerDraftPersistence(accountId: string): () => void {
  active?.dispose();
  const accountChanged = scope !== null && scope.accountId !== accountId;
  if (accountChanged) {
    const state = useComposerSessionStore.getState();
    useComposerSessionStore.setState({
      sessionsByKey: useComposerSessionStore.getInitialState().sessionsByKey,
      activeSessionKey: useComposerSessionStore.getInitialState().activeSessionKey,
      // Late async work from the old account cannot acquire a new token.
      sendGenerationCounter: state.sendGenerationCounter + 1,
      editGenerationCounter: state.editGenerationCounter + 1,
      uploadGenerationCounter: state.uploadGenerationCounter + 1
    });
  }
  if (!scope || accountChanged) {
    const fence = startupFence(accountId);
    scope = createScope(accountId, fence.epoch, fence.revoked, new WeakSet(accountChanged ? useWorkspaceStore.getState().chats : []));
  }
  let owned: DraftScope = scope;
  let restoring = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachSessions: (() => void) | null = null;

  /** Another tab signed out: drop this tab's pending and in-memory drafts. The
   * owner keeps listening, so a later sign-in of the account resumes it. */
  function revoke() {
    owned.revoked = true;
    owned.dirty.clear();
    clearTimeout(timer);
    timer = undefined;
    detachSessions?.();
    detachSessions = null;
    clearSessionExpiredDraft();
    resetComposerSessions();
  }

  function resume(epoch: string) {
    owned = scope = createScope(accountId, epoch, false, owned.staleChats);
    attachSessions();
  }

  /** Whether this tab may write now. Only a sign-out revokes: the initial
   * fence is identical in every tab, so a changed epoch always passed through
   * a sign-out, possibly followed by a sign-in this tab did not observe. */
  function reconcileFence(): boolean {
    if (disposed) return false;
    const fence = readComposerDraftEpochState(accountId);
    // Unavailable storage degrades to memory; pending changes wait.
    if (!fence.available) return false;
    if (!owned.revoked) {
      if (!fence.signedOut && owned.epoch !== null && fence.epoch === owned.epoch) return true;
      if (owned.epoch === null) {
        // Storage could not hold a fence at start: create the first one, or
        // adopt one that cannot hide a sign-out after this document loaded,
        // exactly as `startupFence` would have.
        if (fence.epoch === null) return (owned.epoch = createInitialComposerDraftEpoch(accountId)) !== null;
        if (fence.savedAt < documentStartedAt()) {
          owned.epoch = fence.signedOut ? resumeComposerDraftEpoch(accountId, fence.epoch) : fence.epoch;
          return owned.epoch !== null;
        }
      }
      revoke();
    }
    if (fence.signedOut || fence.epoch === null) return false;
    // Signed in again: memory was emptied at revocation, so start afresh.
    resume(fence.epoch);
    return true;
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || owned.revoked) return;
    const writer = owned;
    if (!reconcileFence() || owned !== writer) return;
    const { dirty } = writer;
    const changes = new Map([...dirty].filter(([key, draft]) => draft === null || composerDraftPersistenceAllowed(key)));
    if (!changes.size) return;
    const result = writeComposerDrafts(accountId, changes);
    // The fence has its own key, so writing this draft cannot undo a logout
    // that another renderer committed between read and setItem.
    const fence = readComposerDraftEpochState(accountId);
    if (fence.available && (fence.signedOut || fence.epoch !== writer.epoch)) {
      clearComposerDrafts(accountId);
      reconcileFence();
      return;
    }
    // A failed write stays pending for the next flush; a refused oversized
    // input stays refused until it changes.
    const unsaved = new Set(result.unsaved);
    for (const key of changes.keys()) if (!unsaved.has(key)) dirty.delete(key);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DELAY_MS);
  }
  function restore() {
    if (restoring || disposed || owned.revoked) return;
    restoring = true;
    const { dirty, restored, touched } = owned;
    try {
      const state = useComposerSessionStore.getState();
      let saved: ReturnType<typeof readComposerDrafts> | undefined;
      for (const key of Object.keys(state.sessionsByKey) as ComposerSessionKey[]) {
        const session = state.sessionsByKey[key]!;
        if (restored.has(key) || !composerDraftPersistenceAllowed(key)) continue;
        restored.add(key);
        if (touched.has(key) || session.draft || session.comments.length || session.pendingSend) {
          if (session.draft || session.comments.length) dirty.set(key, { draft: session.draft, comments: session.comments });
          continue;
        }
        saved ??= readComposerDrafts(accountId);
        const record = saved.find(candidate => candidate.sessionKey === key);
        if (record) state.updateSession(key, { draft: record.draft, comments: [...(record.comments ?? [])] });
      }
      if (dirty.size) schedule();
    } finally {
      owned.observedSessions = useComposerSessionStore.getState().sessionsByKey;
      restoring = false;
    }
  }

  function observeSessions(sessionsByKey: DraftScope["observedSessions"]) {
    if (restoring || disposed || owned.revoked) return;
    const { dirty, observedSessions: previous, restored, touched } = owned;
    let removed = false;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(sessionsByKey)]) as Set<ComposerSessionKey>) {
      const before = previous[key];
      const after = sessionsByKey[key];
      if (before && !after) {
        dirty.set(key, null);
        restored.delete(key);
        touched.delete(key);
        removed = true;
      } else if (after && (before?.draft !== after.draft || before?.comments !== after.comments) &&
        (before || after.draft || after.comments.length)) {
        touched.add(key);
        const empty = !after.draft && !after.comments.length;
        dirty.set(key, empty ? null : { draft: after.draft, comments: after.comments });
        removed ||= empty;
      }
    }
    restore();
    if (removed) flush();
    else if (dirty.size) schedule();
  }
  function attachSessions() {
    const unsubscribeSessions = useComposerSessionStore.subscribe((state, previous) => {
      if (state.sessionsByKey !== previous.sessionsByKey) observeSessions(state.sessionsByKey);
    });
    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
      if (state.chats !== previous.chats || state.catalogAccountId !== previous.catalogAccountId) restore();
    });
    window.addEventListener("pagehide", flush);
    detachSessions = () => {
      unsubscribeSessions();
      unsubscribeWorkspace();
      window.removeEventListener("pagehide", flush);
    };
    observeSessions(useComposerSessionStore.getState().sessionsByKey);
  }

  const visibility = () => {
    if (document.visibilityState === "hidden") flush();
    // A frozen or cached page may have missed the storage events meanwhile.
    else reconcileFence();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === composerDraftEpochKey(accountId)) reconcileFence();
  };
  window.addEventListener("storage", storageChanged);
  document.addEventListener("visibilitychange", visibility);
  const owner = {
    accountId,
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      clearTimeout(timer);
      detachSessions?.();
      detachSessions = null;
      window.removeEventListener("storage", storageChanged);
      document.removeEventListener("visibilitychange", visibility);
      if (active === owner) active = null;
    },
    remove(key: ComposerSessionKey) {
      if (owned.revoked) return;
      owned.dirty.set(key, null);
      owned.restored.add(key);
      flush();
    }
  };
  active = owner;
  const started = owned;
  // A revocation found here, now or while this observer was away, empties
  // memory; a sign-in since then resumes persistence with its own observer.
  if (started.revoked) revoke();
  reconcileFence();
  if (owned === started && !started.revoked) attachSessions();
  return owner.dispose;
}

export function removePersistedComposerDraft(key: ComposerSessionKey): void {
  active?.remove(key);
}

/** The logout boundary a session-expiry handoff carries. A stale tab never
 * adopts a replacement epoch here: the handoff text was read before. Null
 * refuses the handoff; `{ epoch: null }` is the account-only handoff of a tab
 * whose storage could not hold a fence, checked again at restore. */
export function composerDraftRecoveryBoundary(accountId: string): { epoch: string | null } | null {
  if (!scope || scope.accountId !== accountId || scope.revoked) return null;
  const fence = readComposerDraftEpochState(accountId);
  if (!fence.available) return { epoch: scope.epoch };
  if (fence.signedOut) return null;
  if (scope.epoch !== null) return fence.epoch === scope.epoch ? { epoch: scope.epoch } : null;
  if (fence.epoch === null) return { epoch: null };
  return fence.savedAt < documentStartedAt() && !fence.signedOut ? { epoch: fence.epoch } : null;
}

/** Explicit sign-out. The signing-out surface names its authenticated account:
 * a document without a draft observer (Control Center) must clear it too.
 * Without a name, this document's observer decides; with neither, every
 * stored account is cleared rather than leaving one behind. The fence moves
 * and observers stop first, so no pagehide or other tab recreates the entry. */
export function clearSignedOutComposerDrafts(signedOutAccountId?: string | null): void {
  const accountId = signedOutAccountId || active?.accountId || scope?.accountId || null;
  const fenced = accountId ? signOutComposerDraftEpoch(accountId) !== null : false;
  if (scope) scope.revoked = true;
  active?.dispose();
  if (accountId) clearComposerDrafts(accountId);
  else clearAllComposerDraftStorage();
  // Full storage may have refused the fence; the removed entry freed room.
  if (accountId && !fenced) signOutComposerDraftEpoch(accountId);
  clearSessionExpiredDraft();
  resetComposerSessions();
  scope = null;
}

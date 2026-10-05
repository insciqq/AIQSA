import { composerDraftEpochKey, readComposerDraftEpochState } from "@/components/app-shell/composerDraftStorage";
import { subscribeToSessionExpired } from "@/components/app-shell/shellApi";

/**
 * Calls `onEnded` once when the account that started an import is no longer
 * signed in to this browser profile. Sign-out in any tab moves the account's
 * logout fence (the composer-draft epoch the app already keeps for this):
 * the fence is marked signed out, rotated, or removed. An expired session is
 * signalled by the shell's requests. Without readable storage only the
 * session signal and the server's account check remain.
 */
export function watchImportAccount(accountId: string, onEnded: () => void): () => void {
  const started = readComposerDraftEpochState(accountId);
  let watching = true;
  let unsubscribeExpired: (() => void) | null = null;
  const stop = () => {
    watching = false;
    window.removeEventListener("storage", storageChanged);
    unsubscribeExpired?.();
    unsubscribeExpired = null;
  };
  const end = () => {
    if (!watching) return;
    stop();
    onEnded();
  };
  function storageChanged(event: StorageEvent) {
    if (event.key !== null && event.key !== composerDraftEpochKey(accountId)) return;
    const fence = readComposerDraftEpochState(accountId);
    if (!started.available || !fence.available) return;
    if (fence.signedOut || (started.epoch !== null && fence.epoch !== started.epoch)) end();
  }
  window.addEventListener("storage", storageChanged);
  // An already expired session calls back at once, before this returns.
  const unsubscribe = subscribeToSessionExpired(end);
  if (watching) unsubscribeExpired = unsubscribe;
  else unsubscribe();
  return stop;
}

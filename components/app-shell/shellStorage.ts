import type { ComposerSessionKey } from "@/components/app-shell/composerSessionStore";
import { isStoredComposerSessionKey, readComposerDraftEpochState } from "./composerDraftStorage";
import { decodeComposerComments, type PendingComposerComment } from "./composerComments";
import type { LibraryTabIdV2 } from "@/features/library-v2/contracts";

export const AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY = "aiqsa.sessionExpiredDraft.v1";
const SESSION_EXPIRED_DRAFT_MAX_AGE_MS = 30 * 60 * 1000;
const STUDIO_SECTION_KEY = "aiqsa.studio.section";

export function storedStudioSection(available: readonly LibraryTabIdV2[]): LibraryTabIdV2 | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(STUDIO_SECTION_KEY);
    return available.find(id => id === saved) ?? null;
  } catch {
    return null;
  }
}

export function rememberStudioSection(section: LibraryTabIdV2): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STUDIO_SECTION_KEY, section);
  } catch {
    // Browser storage is optional presentation state.
  }
}

export function initialStudioSection(available: readonly LibraryTabIdV2[], target?: LibraryTabIdV2): LibraryTabIdV2 | undefined {
  return (target && available.includes(target) ? target : undefined)
    ?? storedStudioSection(available)
    ?? (available.includes("assistants") ? "assistants" : available[0]);
}

export type StoredSessionExpiredDraft = {
  accountId: string;
  /** The logout fence the tab held; null when its localStorage could not hold one. */
  epoch: string | null;
  draft: string;
  comments?: readonly PendingComposerComment[];
  savedAt: number;
  sessionKey: ComposerSessionKey;
};

export function clearSessionExpiredDraft(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY);
  } catch {
    // A re-auth handoff cannot preserve a draft when tab storage is unavailable.
  }
}

/** Whether no sign-out of the account is known since the handoff was saved.
 * With the tab's fence, that fence must still be current. Without one (the
 * account-only handoff of release 0.2.31), a readable fence must predate the
 * handoff; the initial fence is dated 0. Unreadable localStorage cannot
 * record a sign-out either, so it keeps the handoff. */
function handoffSignedIn(accountId: string, epoch: string | null, savedAt: number): boolean {
  const current = readComposerDraftEpochState(accountId);
  if (!current.available) return true;
  if (current.signedOut) return false;
  return epoch ? current.epoch === epoch : current.epoch === null || current.savedAt <= savedAt;
}

export function rememberSessionExpiredDraft(input: StoredSessionExpiredDraft): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if ((!input.draft && !input.comments?.length) || !isStoredComposerSessionKey(input.sessionKey) ||
      !input.accountId || !handoffSignedIn(input.accountId, input.epoch, input.savedAt)) {
      window.sessionStorage.removeItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify(input)
    );
  } catch {
    // A re-auth handoff cannot preserve a draft when tab storage is unavailable.
  }
}

export function clearSessionExpiredDraftForSession(sessionKey: ComposerSessionKey): void {
  if (storedSessionExpiredDraft()?.sessionKey === sessionKey) clearSessionExpiredDraft();
}

export function storedSessionExpiredDraft(
  now = Date.now()
): StoredSessionExpiredDraft | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<StoredSessionExpiredDraft>;
    const comments = decodeComposerComments(value.comments);
    if (
      typeof value.accountId !== "string" || !value.accountId ||
      value.epoch !== null && (typeof value.epoch !== "string" || !value.epoch) ||
      typeof value.draft !== "string" ||
      !comments ||
      (!value.draft && !comments.length) ||
      typeof value.savedAt !== "number" ||
      !Number.isFinite(value.savedAt) ||
      value.savedAt > now ||
      now - value.savedAt > SESSION_EXPIRED_DRAFT_MAX_AGE_MS ||
      !isStoredComposerSessionKey(value.sessionKey)
    ) {
      clearSessionExpiredDraft();
      return null;
    }

    if (!handoffSignedIn(value.accountId, value.epoch, value.savedAt)) {
      clearSessionExpiredDraft();
      return null;
    }

    return { ...value, ...(comments.length ? { comments } : {}) } as StoredSessionExpiredDraft;
  } catch {
    clearSessionExpiredDraft();
    return null;
  }
}

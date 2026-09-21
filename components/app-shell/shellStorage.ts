import type { ComposerSessionKey } from "@/components/app-shell/composerSessionStore";
import type { LibraryTabIdV2 } from "@/features/library-v2/contracts";

const AIQSA_ACTIVE_CHAT_STORAGE_KEY = "aiqsa.activeChatId";
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
  accountEmail: string;
  draft: string;
  savedAt: number;
  sessionKey: ComposerSessionKey;
};

function isComposerSessionKey(value: unknown): value is ComposerSessionKey {
  if (value === "blank:root") {
    return true;
  }
  if (typeof value !== "string" || value.length > 512) {
    return false;
  }

  const encodedSegment = value.startsWith("blank:folder:")
    ? value.slice("blank:folder:".length)
    : value.startsWith("chat:")
      ? value.slice("chat:".length)
      : null;
  if (!encodedSegment) {
    return false;
  }

  try {
    return Boolean(decodeURIComponent(encodedSegment));
  } catch {
    return false;
  }
}

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

export function rememberSessionExpiredDraft(input: StoredSessionExpiredDraft): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (!input.draft) {
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
    if (
      typeof value.accountEmail !== "string" ||
      !value.accountEmail ||
      typeof value.draft !== "string" ||
      !value.draft ||
      typeof value.savedAt !== "number" ||
      !Number.isFinite(value.savedAt) ||
      value.savedAt > now ||
      now - value.savedAt > SESSION_EXPIRED_DRAFT_MAX_AGE_MS ||
      !isComposerSessionKey(value.sessionKey)
    ) {
      clearSessionExpiredDraft();
      return null;
    }

    return value as StoredSessionExpiredDraft;
  } catch {
    clearSessionExpiredDraft();
    return null;
  }
}

export function storedActiveChatId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(AIQSA_ACTIVE_CHAT_STORAGE_KEY);
}

export function rememberActiveChatId(chatId: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (chatId) {
    window.localStorage.setItem(AIQSA_ACTIVE_CHAT_STORAGE_KEY, chatId);
  } else {
    window.localStorage.removeItem(AIQSA_ACTIVE_CHAT_STORAGE_KEY);
  }
}

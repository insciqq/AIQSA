import type { ComposerSessionKey } from "@/components/app-shell/composerSessionStore";

const AIQSA_ACTIVE_CHAT_STORAGE_KEY = "aiqsa.activeChatId";
const AIQSA_COLLAPSED_FOLDERS_STORAGE_KEY = "aiqsa.collapsedFolderIds";
export const AIQSA_WORKSPACE_RAIL_STORAGE_KEY = "aiqsa.workspacePane";
export const AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY = "aiqsa.sessionExpiredDraft.v1";
const SESSION_EXPIRED_DRAFT_MAX_AGE_MS = 30 * 60 * 1000;

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

export function storedCollapsedFolderIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const value = JSON.parse(
      window.localStorage.getItem(AIQSA_COLLAPSED_FOLDERS_STORAGE_KEY) ?? "[]"
    ) as unknown;
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

export function rememberCollapsedFolderIds(ids: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    AIQSA_COLLAPSED_FOLDERS_STORAGE_KEY,
    JSON.stringify(Array.from(ids))
  );
}

export function storedWorkspaceRailHidden(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY) === "hidden";
  } catch {
    return false;
  }
}

export function rememberWorkspaceRailHidden(hidden: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      AIQSA_WORKSPACE_RAIL_STORAGE_KEY,
      hidden ? "hidden" : "visible"
    );
  } catch {
    // Local UI preferences fall back to the visible rail when storage is unavailable.
  }
}

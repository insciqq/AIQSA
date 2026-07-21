import type { InspectorMode } from "@/components/app-shell/types";

const AIQSA_ACTIVE_CHAT_STORAGE_KEY = "aiqsa.activeChatId";
const AIQSA_COLLAPSED_FOLDERS_STORAGE_KEY = "aiqsa.collapsedFolderIds";
export const AIQSA_DETAILS_MODE_STORAGE_KEY = "aiqsa.detailsMode";

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

function storeClosedDetailsMode() {
  try {
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "closed");
  } catch {
    // Local UI preferences fail closed when storage is unavailable.
  }
}

export function storedInspectorMode(pinningAvailable = false): InspectorMode {
  if (typeof window === "undefined") {
    return "closed";
  }

  let value: string | null;
  try {
    value = window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY);
  } catch {
    return "closed";
  }

  if (value !== null) {
    if (value === "pinned") {
      return pinningAvailable ? "pinned" : "closed";
    }

    if (value === "overlay") {
      storeClosedDetailsMode();
    }

    return "closed";
  }

  return "closed";
}

export function rememberInspectorMode(mode: InspectorMode) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      AIQSA_DETAILS_MODE_STORAGE_KEY,
      mode === "pinned" ? "pinned" : "closed"
    );
  } catch {
    // Local UI preferences fail closed when storage is unavailable.
  }
}

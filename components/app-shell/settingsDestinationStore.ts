import { create } from "zustand";
import type { LibraryTabIdV2 } from "@/features/library-v2/contracts";

/**
 * A request to open Settings from a caller that has no handle on the shell's
 * Settings navigation (`useStudioNavigation`), which alone owns what is
 * open: the chat shell opens the request and clears it. A null section opens
 * Settings as the gear does.
 */
export type SettingsRequest = Readonly<{ section: LibraryTabIdV2 | null }>;

export type SettingsDestinationSnapshot = {
  memoryOpen: boolean;
  settingsRequest: SettingsRequest | null;
};

export type SettingsDestinationStore = SettingsDestinationSnapshot & {
  clearSettingsRequest(request: SettingsRequest): void;
  closeMemory(): void;
  openMemoryLibrary(): void;
  openSettings(section?: LibraryTabIdV2): void;
};

export const initialSettingsDestinationSnapshot: SettingsDestinationSnapshot = {
  memoryOpen: false,
  settingsRequest: null
};

export const useSettingsDestinationStore = create<SettingsDestinationStore>((set) => ({
  ...initialSettingsDestinationSnapshot,
  clearSettingsRequest(request) {
    set((state) => state.settingsRequest === request ? { settingsRequest: null } : {});
  },
  closeMemory() {
    set({ memoryOpen: false });
  },
  openMemoryLibrary() {
    set({ memoryOpen: true });
  },
  openSettings(section) {
    set({ settingsRequest: { section: section ?? null } });
  }
}));

/**
 * Settings sections the `?settings=<section>` addresses of the former
 * Settings dialog name, as answers and bookmarks still carry them.
 */
const LEGACY_SETTINGS_SECTIONS: Readonly<Record<string, LibraryTabIdV2>> = {
  account: "account",
  connected_apps: "apps",
  connections: "mcp",
  data: "data",
  general: "general",
  mcp: "mcp",
  proxies: "proxies"
};

/** The Settings section a `?settings=` value names; anything else names none. */
export function legacySettingsSection(value: string | null): LibraryTabIdV2 | null {
  return value !== null && Object.hasOwn(LEGACY_SETTINGS_SECTIONS, value) ? LEGACY_SETTINGS_SECTIONS[value]! : null;
}

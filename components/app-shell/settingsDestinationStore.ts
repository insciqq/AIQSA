import { create } from "zustand";

export type SettingsSection =
  | "account"
  | "connected_apps"
  | "data"
  | "defaults"
  | "general"
  | "mcp"
  | "memory";

export type SettingsDestinationSnapshot = {
  memoryOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
};

export type SettingsDestinationStore = SettingsDestinationSnapshot & {
  closeMemory(): void;
  closeSettings(): void;
  openMemoryLibrary(): void;
  openMemoryTab(): void;
  openMcpSettings(): void;
  openSettings(): void;
};

export const initialSettingsDestinationSnapshot: SettingsDestinationSnapshot = {
  memoryOpen: false,
  settingsOpen: false,
  settingsSection: "general"
};

export const useSettingsDestinationStore = create<SettingsDestinationStore>((set) => ({
  ...initialSettingsDestinationSnapshot,
  closeMemory() {
    set({ memoryOpen: false });
  },
  closeSettings() {
    set({ settingsOpen: false });
  },
  openMemoryLibrary() {
    set({ memoryOpen: true, settingsOpen: false });
  },
  openMemoryTab() {
    set({ settingsOpen: true, settingsSection: "memory" });
  },
  openMcpSettings() {
    set({ memoryOpen: false, settingsOpen: true, settingsSection: "mcp" });
  },
  openSettings() {
    set({ memoryOpen: false, settingsOpen: true, settingsSection: "general" });
  }
}));

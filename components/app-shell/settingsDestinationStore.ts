import { create } from "zustand";

export type SettingsSection = "account" | "data" | "defaults" | "general" | "mcp" | "memory";

export type SettingsDestinationSnapshot = {
  memoryOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
};

export type SettingsDestinationStore = SettingsDestinationSnapshot & {
  closeMemory(): void;
  closeSettings(): void;
  openMemorySettings(): void;
  openMcpSettings(): void;
  openSettings(): void;
  openSettingsSection(section: SettingsSection): void;
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
  openMemorySettings() {
    set({ memoryOpen: true, settingsOpen: false });
  },
  openMcpSettings() {
    set({ memoryOpen: false, settingsOpen: true, settingsSection: "mcp" });
  },
  openSettings() {
    set({ memoryOpen: false, settingsOpen: true, settingsSection: "general" });
  },
  openSettingsSection(section) {
    set({ memoryOpen: false, settingsOpen: true, settingsSection: section });
  }
}));

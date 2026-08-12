import { create } from "zustand";

export type SettingsSection = "appearance" | "mcp";

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
};

export const initialSettingsDestinationSnapshot: SettingsDestinationSnapshot = {
  memoryOpen: false,
  settingsOpen: false,
  settingsSection: "appearance"
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
    set({ memoryOpen: false, settingsOpen: true, settingsSection: "appearance" });
  }
}));

export function resetSettingsDestinationStoreForTest() {
  useSettingsDestinationStore.setState({ ...initialSettingsDestinationSnapshot });
}

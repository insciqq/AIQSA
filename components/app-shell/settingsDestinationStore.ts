import { create } from "zustand";

export type SettingsSection = "appearance" | "mcp";

export type SettingsDestinationSnapshot = {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
};

export type SettingsDestinationStore = SettingsDestinationSnapshot & {
  closeSettings(): void;
  openMcpSettings(): void;
  openSettings(): void;
};

export const initialSettingsDestinationSnapshot: SettingsDestinationSnapshot = {
  settingsOpen: false,
  settingsSection: "appearance"
};

export const useSettingsDestinationStore = create<SettingsDestinationStore>((set) => ({
  ...initialSettingsDestinationSnapshot,
  closeSettings() {
    set({ settingsOpen: false });
  },
  openMcpSettings() {
    set({ settingsOpen: true, settingsSection: "mcp" });
  },
  openSettings() {
    set({ settingsOpen: true, settingsSection: "appearance" });
  }
}));

export function resetSettingsDestinationStoreForTest() {
  useSettingsDestinationStore.setState({ ...initialSettingsDestinationSnapshot });
}

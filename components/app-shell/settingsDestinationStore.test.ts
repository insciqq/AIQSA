import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSettingsDestinationSnapshot,
  useSettingsDestinationStore
} from "./settingsDestinationStore";

describe("Settings destination store", () => {
  beforeEach(() => {
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  });

  it.each(["openSettings", "openMcpSettings"] as const)("%s retains the Studio background", (action) => {
    useSettingsDestinationStore.getState().openMemoryLibrary();
    useSettingsDestinationStore.getState()[action]();
    expect(useSettingsDestinationStore.getState()).toMatchObject({ memoryOpen: true, settingsOpen: true });
    useSettingsDestinationStore.getState().closeSettings();
    expect(useSettingsDestinationStore.getState()).toMatchObject({ memoryOpen: true, settingsOpen: false });
  });

  it("opens the Memory tab over Library and returns to the Library when Settings closes", () => {
    useSettingsDestinationStore.getState().openMemoryLibrary();
    expect(useSettingsDestinationStore.getState()).toMatchObject({
      memoryOpen: true,
      settingsOpen: false
    });

    useSettingsDestinationStore.getState().openMemoryTab();
    expect(useSettingsDestinationStore.getState()).toMatchObject({
      memoryOpen: true,
      settingsOpen: true,
      settingsSection: "memory"
    });

    useSettingsDestinationStore.getState().closeSettings();
    expect(useSettingsDestinationStore.getState()).toMatchObject({
      memoryOpen: true,
      settingsOpen: false
    });
  });
});

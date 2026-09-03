import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSettingsDestinationSnapshot,
  useSettingsDestinationStore
} from "./settingsDestinationStore";

describe("Settings destination store", () => {
  beforeEach(() => {
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
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

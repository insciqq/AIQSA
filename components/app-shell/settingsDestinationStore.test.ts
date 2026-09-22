import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSettingsDestinationSnapshot,
  useSettingsDestinationStore
} from "./settingsDestinationStore";

describe("Settings destination store", () => {
  beforeEach(() => {
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  });

  it("retains the Studio background when opening Settings", () => {
    useSettingsDestinationStore.getState().openMemoryLibrary();
    useSettingsDestinationStore.getState().openSettings();
    expect(useSettingsDestinationStore.getState()).toMatchObject({ memoryOpen: true, settingsOpen: true });
    useSettingsDestinationStore.getState().closeSettings();
    expect(useSettingsDestinationStore.getState()).toMatchObject({ memoryOpen: true, settingsOpen: false });
  });

});

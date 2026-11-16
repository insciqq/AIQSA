import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSettingsDestinationSnapshot,
  legacySettingsSection,
  useSettingsDestinationStore
} from "./settingsDestinationStore";

describe("Settings destination store", () => {
  beforeEach(() => {
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  });

  it("holds only a request for the shell's Settings navigation, never a second open state", () => {
    useSettingsDestinationStore.getState().openMemoryLibrary();
    useSettingsDestinationStore.getState().openSettings("apps");
    const request = useSettingsDestinationStore.getState().settingsRequest;
    expect(request).toEqual({ section: "apps" });
    expect(useSettingsDestinationStore.getState().memoryOpen).toBe(true);
    expect(Object.keys(useSettingsDestinationStore.getState()).filter(key => /settings(Open|Section)$/u.test(key))).toEqual([]);

    // A newer request survives the shell clearing the one it handled.
    useSettingsDestinationStore.getState().openSettings();
    useSettingsDestinationStore.getState().clearSettingsRequest(request!);
    expect(useSettingsDestinationStore.getState().settingsRequest).toEqual({ section: null });
    useSettingsDestinationStore.getState().clearSettingsRequest(useSettingsDestinationStore.getState().settingsRequest!);
    expect(useSettingsDestinationStore.getState().settingsRequest).toBeNull();
  });

  it("maps the former Settings dialog's sections to Settings sections", () => {
    expect(["general", "account", "data", "proxies", "connections", "connected_apps", "mcp"].map(legacySettingsSection))
      .toEqual(["general", "account", "data", "proxies", "mcp", "apps", "mcp"]);
    for (const value of [null, "", "studio", "toString", "constructor", "Proxies", "secrets"]) {
      expect(legacySettingsSection(value)).toBeNull();
    }
  });
});

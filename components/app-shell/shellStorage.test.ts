import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIQSA_DETAILS_MODE_STORAGE_KEY,
  rememberActiveChatId,
  rememberCollapsedFolderIds,
  rememberInspectorMode,
  storedActiveChatId,
  storedCollapsedFolderIds,
  storedInspectorMode
} from "./shellStorage";

describe("shell storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("stores and removes the active chat id", () => {
    expect(storedActiveChatId()).toBeNull();

    rememberActiveChatId("chat-1");
    expect(storedActiveChatId()).toBe("chat-1");

    rememberActiveChatId(null);
    expect(storedActiveChatId()).toBeNull();
  });

  it("round-trips collapsed folder ids and rejects malformed storage", () => {
    rememberCollapsedFolderIds(new Set(["folder-2", "folder-1"]));
    expect(storedCollapsedFolderIds()).toEqual(new Set(["folder-2", "folder-1"]));

    window.localStorage.setItem("aiqsa.collapsedFolderIds", "not-json");
    expect(storedCollapsedFolderIds()).toEqual(new Set());

    window.localStorage.setItem(
      "aiqsa.collapsedFolderIds",
      JSON.stringify(["folder-1", 2, null])
    );
    expect(storedCollapsedFolderIds()).toEqual(new Set(["folder-1"]));
  });
});

describe("Details mode preferences", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(AIQSA_DETAILS_MODE_STORAGE_KEY);
  });

  it("defaults to closed when no preference exists", () => {
    expect(storedInspectorMode()).toBe("closed");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBeNull();
  });

  it("fails closed for an invalid value", () => {
    window.localStorage.setItem(
      AIQSA_DETAILS_MODE_STORAGE_KEY,
      "invalid-details-mode"
    );

    expect(storedInspectorMode(true)).toBe("closed");
  });

  it("restores a new closed preference", () => {
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "closed");

    expect(storedInspectorMode(true)).toBe("closed");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe(
      "closed"
    );
  });

  it("restores pinned only when pinning is available without destroying the preference", () => {
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "pinned");

    expect(storedInspectorMode()).toBe("closed");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe(
      "pinned"
    );
    expect(storedInspectorMode(true)).toBe("pinned");
  });

  it("normalizes a transient overlay preference to closed", () => {
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "overlay");

    expect(storedInspectorMode(true)).toBe("closed");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe(
      "closed"
    );
  });

  it.each([
    ["closed", "closed"],
    ["overlay", "closed"],
    ["pinned", "pinned"]
  ] as const)("stores %s as the durable %s preference", (mode, storedMode) => {
    rememberInspectorMode(mode);

    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe(
      storedMode
    );
  });

  it("fails closed when storage reads throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(storedInspectorMode(true)).toBe("closed");
  });

  it("does not throw when preference writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(() => rememberInspectorMode("pinned")).not.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIQSA_DETAILS_MODE_STORAGE_KEY,
  AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
  AIQSA_WORKSPACE_RAIL_STORAGE_KEY,
  clearSessionExpiredDraft,
  rememberActiveChatId,
  rememberCollapsedFolderIds,
  rememberInspectorMode,
  rememberSessionExpiredDraft,
  rememberWorkspaceRailHidden,
  storedActiveChatId,
  storedCollapsedFolderIds,
  storedInspectorMode,
  storedSessionExpiredDraft,
  storedWorkspaceRailHidden
} from "./shellStorage";

describe("shell storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
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

  it("carries the legacy Workspace rail key and values into wide-pane visibility", () => {
    expect(storedWorkspaceRailHidden()).toBe(false);

    rememberWorkspaceRailHidden(true);
    expect(window.localStorage.getItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY)).toBe("hidden");
    expect(storedWorkspaceRailHidden()).toBe(true);

    rememberWorkspaceRailHidden(false);
    expect(window.localStorage.getItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY)).toBe("visible");
    expect(storedWorkspaceRailHidden()).toBe(false);

    window.localStorage.setItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY, "invalid");
    expect(storedWorkspaceRailHidden()).toBe(false);
  });
});

describe("session-expired draft handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("round-trips one tab-scoped keyed draft and clears it explicitly", () => {
    rememberSessionExpiredDraft({
      accountEmail: "operator@aiqsa.local",
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    expect(storedSessionExpiredDraft(2_000)).toEqual({
      accountEmail: "operator@aiqsa.local",
      draft: "Keep this question",
      savedAt: 1_000,
      sessionKey: "chat:chat-1"
    });

    clearSessionExpiredDraft();
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
  });

  it("discards expired, future, or malformed handoff data", () => {
    rememberSessionExpiredDraft({
      accountEmail: "operator@aiqsa.local",
      draft: "Expired",
      savedAt: 1_000,
      sessionKey: "blank:root"
    });
    expect(storedSessionExpiredDraft(1_000 + 31 * 60 * 1000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Future",
        savedAt: 5_000,
        sessionKey: "blank:root"
      })
    );
    expect(storedSessionExpiredDraft(4_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Invalid key",
        savedAt: 1_000,
        sessionKey: "foreign:chat-1"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();

    window.sessionStorage.setItem(
      AIQSA_SESSION_EXPIRED_DRAFT_STORAGE_KEY,
      JSON.stringify({
        accountEmail: "operator@aiqsa.local",
        draft: "Invalid encoded key",
        savedAt: 1_000,
        sessionKey: "chat:%E0%A4%A"
      })
    );
    expect(storedSessionExpiredDraft(2_000)).toBeNull();
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

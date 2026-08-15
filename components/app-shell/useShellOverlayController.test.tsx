import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChatSummary, FolderSummary } from "./types";
import {
  isShellShortcutTextEntryTarget,
  useShellOverlayController,
  type ShellOverlayControllerInput
} from "./useShellOverlayController";

const chat = (id: string): WorkspaceChatSummary => ({
  activeLeafMessageId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  defaultModelId: "fake-qsa",
  defaultProvider: "fake",
  folderId: null,
  id,
  messageCount: 1,
  pinned: false,
  title: `Chat ${id}`,
  updatedAt: "2026-07-13T00:00:00.000Z"
});

const folder = (id: string): FolderSummary => ({
  id,
  name: `Folder ${id}`,
  parentId: null,
  projectMemory: "",
  sortOrder: 0
});

function controllerInput(overrides: {
  blockers?: Partial<ShellOverlayControllerInput["blockers"]>;
} = {}): ShellOverlayControllerInput {
  return {
    blockers: {
      projectSettingsOpen: false,
      settingsOpen: false,
      ...overrides.blockers
    }
  };
}

function globalShortcut(target: Element, options: { metaKey?: boolean } = {}) {
  const wasConnected = target.isConnected;
  if (!wasConnected) {
    document.body.appendChild(target);
  }
  const handled = fireEvent.keyDown(target, {
    ctrlKey: !options.metaKey,
    key: "k",
    metaKey: Boolean(options.metaKey)
  });
  if (!wasConnected) {
    target.remove();
  }
  return handled;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shell shortcut target ownership", () => {
  it("keeps text entry, selects, and nested contenteditable surfaces local", () => {
    const textInput = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    const editableChild = document.createElement("span");
    editable.setAttribute("contenteditable", "true");
    editable.appendChild(editableChild);

    expect(isShellShortcutTextEntryTarget(textInput)).toBe(true);
    expect(isShellShortcutTextEntryTarget(textarea)).toBe(true);
    expect(isShellShortcutTextEntryTarget(select)).toBe(true);
    expect(isShellShortcutTextEntryTarget(editableChild)).toBe(true);
  });

  it("allows shortcuts from controls that do not accept text", () => {
    const button = document.createElement("button");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(isShellShortcutTextEntryTarget(button)).toBe(false);
    expect(isShellShortcutTextEntryTarget(checkbox)).toBe(false);
    expect(isShellShortcutTextEntryTarget(document.createTextNode("text"))).toBe(false);
  });
});

describe("useShellOverlayController confirmations", () => {
  it("settles a replaced request and cancellation as false", async () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    let firstRequest!: Promise<boolean>;
    let replacementRequest!: Promise<boolean>;

    act(() => {
      firstRequest = result.current.confirmations.chat.request(chat("first"));
    });
    expect(result.current.confirmations.chat.target?.id).toBe("first");

    act(() => {
      replacementRequest = result.current.confirmations.chat.request(chat("replacement"));
    });
    await expect(firstRequest).resolves.toBe(false);
    expect(result.current.confirmations.chat.target?.id).toBe("replacement");

    act(() => result.current.confirmations.chat.cancel());
    await expect(replacementRequest).resolves.toBe(false);
    expect(result.current.confirmations.chat.target).toBeNull();
  });

  it("exposes semantic nested owners without a root setter bag", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));

    expect(Object.keys(result.current).sort()).toEqual([
      "branches",
      "confirmations",
      "palette"
    ]);
    expect(Object.keys(result.current.branches).sort()).toEqual([
      "close",
      "open",
      "show",
      "toggle"
    ]);
    expect(Object.keys(result.current.palette).sort()).toEqual(["close", "open", "show"]);
  });
});

describe("useShellOverlayController shortcuts", () => {
  it("opens from a non-typing control and ignores Cmd/Ctrl+K while typing", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    const input = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(input, button);

    expect(globalShortcut(input)).toBe(true);
    expect(result.current.palette.open).toBe(false);

    expect(globalShortcut(button, { metaKey: true })).toBe(false);
    expect(result.current.palette.open).toBe(true);

    act(() => result.current.palette.close());
    input.remove();
    button.remove();
  });

  it.each([
    "projectSettingsOpen",
    "settingsOpen"
  ] as const)("blocks the palette while %s is active", (blocker) => {
    const { result } = renderHook(() =>
      useShellOverlayController(controllerInput({ blockers: { [blocker]: true } }))
    );
    const button = document.createElement("button");

    expect(globalShortcut(button)).toBe(true);
    expect(result.current.palette.open).toBe(false);
  });

  it("blocks the palette for every owned confirmation", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    const button = document.createElement("button");

    for (const [request, cancel] of [
      [() => result.current.confirmations.chat.request(chat("blocked")), result.current.confirmations.chat.cancel],
      [() => result.current.confirmations.folder.request(folder("blocked")), result.current.confirmations.folder.cancel],
      [() => result.current.confirmations.message.request("blocked"), result.current.confirmations.message.cancel]
    ] as const) {
      act(() => {
        void request();
      });
      expect(globalShortcut(button)).toBe(true);
      expect(result.current.palette.open).toBe(false);
      act(() => cancel());
    }
  });

  it("closes Branches before opening the palette on the next task", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    const button = document.createElement("button");

    act(() => result.current.branches.show());
    expect(result.current.branches.open).toBe(true);
    expect(globalShortcut(button)).toBe(false);
    expect(result.current.branches.open).toBe(false);
    expect(result.current.palette.open).toBe(false);

    act(() => vi.runOnlyPendingTimers());
    expect(result.current.palette.open).toBe(true);
  });

  it("lets Escape close an open palette even from its text field", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    const input = document.createElement("input");
    document.body.appendChild(input);

    act(() => result.current.palette.show());
    expect(result.current.palette.open).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(result.current.palette.open).toBe(false);
    input.remove();
  });
});

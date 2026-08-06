import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSummary, FolderSummary, InspectorMode } from "./types";
import {
  isShellShortcutTextEntryTarget,
  useShellOverlayController,
  type ShellOverlayControllerInput
} from "./useShellOverlayController";

const chat = (id: string): ChatSummary => ({
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
  changeMode?: (mode: InspectorMode) => void;
  mode?: InspectorMode;
  onMobileWorkspaceClosed?: () => void;
} = {}): ShellOverlayControllerInput {
  return {
    appearance: {
      changeMode: overrides.changeMode ?? vi.fn(),
      mode: overrides.mode ?? "closed"
    },
    blockers: {
      projectSettingsOpen: false,
      settingsOpen: false,
      ...overrides.blockers
    },
    onMobileWorkspaceClosed: overrides.onMobileWorkspaceClosed ?? vi.fn()
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

  it("confirms chat and folder before closing mobile Workspace, but keeps it open for messages", async () => {
    const onMobileWorkspaceClosed = vi.fn();
    const { result } = renderHook(() =>
      useShellOverlayController(controllerInput({ onMobileWorkspaceClosed }))
    );
    let chatRequest!: Promise<boolean>;
    let folderRequest!: Promise<boolean>;
    let messageRequest!: Promise<boolean>;

    act(() => {
      result.current.mobileWorkspace.show();
      chatRequest = result.current.confirmations.chat.request(chat("confirm"));
    });
    act(() => result.current.confirmations.chat.confirm());
    await expect(chatRequest).resolves.toBe(true);
    expect(result.current.confirmations.chat.target).toBeNull();
    expect(result.current.mobileWorkspace.open).toBe(false);
    expect(onMobileWorkspaceClosed).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.mobileWorkspace.show();
      folderRequest = result.current.confirmations.folder.request(folder("confirm"));
    });
    act(() => result.current.confirmations.folder.confirm());
    await expect(folderRequest).resolves.toBe(true);
    expect(result.current.confirmations.folder.target).toBeNull();
    expect(result.current.mobileWorkspace.open).toBe(false);
    expect(onMobileWorkspaceClosed).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.mobileWorkspace.show();
      messageRequest = result.current.confirmations.message.request("message-confirm");
    });
    act(() => result.current.confirmations.message.confirm());
    await expect(messageRequest).resolves.toBe(true);
    expect(result.current.confirmations.message.target).toBeNull();
    expect(result.current.mobileWorkspace.open).toBe(true);
    expect(onMobileWorkspaceClosed).toHaveBeenCalledTimes(2);

    act(() => result.current.mobileWorkspace.close());
    expect(onMobileWorkspaceClosed).toHaveBeenCalledTimes(3);
  });

  it("exposes semantic nested owners without a root setter bag", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));

    expect(Object.keys(result.current).sort()).toEqual([
      "confirmations",
      "mobileWorkspace",
      "palette"
    ]);
    expect(Object.keys(result.current.palette).sort()).toEqual(["close", "open", "show"]);
    expect(Object.keys(result.current.mobileWorkspace).sort()).toEqual([
      "close",
      "dialogRef",
      "open",
      "show"
    ]);
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

  it("blocks the palette for mobile Workspace and every owned confirmation", () => {
    const { result } = renderHook(() => useShellOverlayController(controllerInput()));
    const button = document.createElement("button");

    act(() => result.current.mobileWorkspace.show());
    expect(globalShortcut(button)).toBe(true);
    expect(result.current.palette.open).toBe(false);
    act(() => result.current.mobileWorkspace.close());

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

  it("closes overlay Details before opening the palette on the next task", () => {
    vi.useFakeTimers();
    const changeMode = vi.fn();
    const { result } = renderHook(() =>
      useShellOverlayController(controllerInput({ changeMode, mode: "overlay" }))
    );
    const button = document.createElement("button");

    expect(globalShortcut(button)).toBe(false);
    expect(changeMode).toHaveBeenCalledWith("closed");
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

describe("useShellOverlayController mobile dialog focus", () => {
  it("autofocuses, closes through Escape, calls cleanup, and restores its opener", () => {
    vi.useFakeTimers();
    const onMobileWorkspaceClosed = vi.fn();

    function Harness() {
      const controller = useShellOverlayController(
        controllerInput({ onMobileWorkspaceClosed })
      );

      return (
        <>
          <button type="button" onClick={controller.mobileWorkspace.show}>
            Open Workspace
          </button>
          {controller.mobileWorkspace.open ? (
            <div
              ref={controller.mobileWorkspace.dialogRef}
              aria-label="Mobile Workspace"
              role="dialog"
            >
              <button type="button">Workspace action</button>
            </div>
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open Workspace" });
    opener.focus();
    fireEvent.click(opener);
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByRole("button", { name: "Workspace action" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Mobile Workspace" }), {
      key: "Escape"
    });

    expect(screen.queryByRole("dialog", { name: "Mobile Workspace" })).not.toBeInTheDocument();
    expect(onMobileWorkspaceClosed).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });
});

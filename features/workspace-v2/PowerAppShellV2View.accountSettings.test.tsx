import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PowerAppShellV2Props } from "@/components/app-shell/powerAppShellV2Contracts";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import { resetComposerControlStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { PowerAppShellV2View } from "./PowerAppShellV2View";

afterEach(() => {
  resetComposerControlStoreForTest();
  resetWorkspaceStoreForTest();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

// Only the view-consumed state of a blank chat is needed; Settings ownership
// stays with the shell's settings controller.
function shellProps(): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: { accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null },
    composer: {
      attachments: [], catalog: null, draft: "", currentParameterControls: defaultParameterControls(),
      assistant: { current: null, pickerItems: [], recentIds: [], openPicker: false, stripItems: [] },
      memory: { mode: "NORMAL" }, workspace: { available: false, enabled: false },
      composerActions: {}, selectedSearchOptionIds: []
    },
    settings: { memory: { open: false }, settings: { open: false }, open: vi.fn() },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }
    }
  } as unknown as PowerAppShellV2Props;
}

describe("account Settings", () => {
  it("opens the account's Settings from the chat list footer's gear, not from the account menu", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ announcements: [] })));
    const props = shellProps();
    render(<PowerAppShellV2View {...props} />);
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    const footer = screen.getByTestId("navigation-footer");

    expect(within(footer).queryByRole("button", { name: "Projects" })).toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Account menu" }));
    expect(within(screen.getByRole("menu", { name: "Account" })).queryByRole("menuitem", { name: "Settings" })).toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Account menu" }));

    fireEvent.click(within(footer).getByRole("button", { name: "Settings" }));
    expect(props.settings.open).toHaveBeenCalledOnce();
  });
});

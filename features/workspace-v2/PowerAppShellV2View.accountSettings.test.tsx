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
  it("opens the account's Settings from the account menu and from the rail", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ announcements: [] })));
    const props = shellProps();
    render(<PowerAppShellV2View {...props} />);
    const rail = screen.getByRole("navigation", { name: "Workspace" });

    expect(within(rail).queryByRole("button", { name: "Projects" })).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "Account menu" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Account" })).getByRole("menuitem", { name: "Settings" }));
    expect(props.settings.open).toHaveBeenCalledOnce();

    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(props.settings.open).toHaveBeenCalledTimes(2);
  });
});

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

// Only the view-consumed Project state is needed; Settings ownership stays
// with the shell's settings and Project controllers.
function projectShellProps(): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: { accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null },
    composer: {
      attachments: [], catalog: null, draft: "", currentParameterControls: defaultParameterControls(),
      assistant: { current: null, pickerItems: [], recentIds: [], openPicker: false },
      knowledge: { bases: [], sources: [], documentTotal: null },
      memory: { mode: "NORMAL" }, workspace: { available: false, enabled: false },
      composerActions: {}, selectedSearchOptionIds: []
    },
    settings: { memory: { open: false }, settings: { open: false }, open: vi.fn() },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }, projectSettings: { folder: null },
      projects: {
        selectedProjectId: "project-1", projects: [], workspace: { chats: [], folders: [] },
        detail: { id: "project-1", name: "Project", status: "DELETING", deletionStatus: "pending",
          directRole: "OWNER", capabilities: {}, resources: [], policy: { externalToolsEnabled: false } },
        actions: { deleteProject: vi.fn(), leave: vi.fn(), openSettings: vi.fn(), refresh: vi.fn() }
      }
    }
  } as unknown as PowerAppShellV2Props;
}

describe("account Settings inside a Project", () => {
  it("opens the account's Settings from the account menu while the rail Settings keeps the Project's", () => {
    window.history.replaceState(null, "", "/p/project-1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ announcements: [] })));
    const props = projectShellProps();
    render(<PowerAppShellV2View {...props} />);
    const rail = screen.getByRole("navigation", { name: "Workspace" });

    fireEvent.click(within(rail).getByRole("button", { name: "Account menu" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Account" })).getByRole("menuitem", { name: "Settings" }));
    expect(props.settings.open).toHaveBeenCalledOnce();
    expect(props.workspace.projects.actions.openSettings).not.toHaveBeenCalled();

    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(props.workspace.projects.actions.openSettings).toHaveBeenCalledExactlyOnceWith("general");
    expect(props.settings.open).toHaveBeenCalledOnce();
  });
});

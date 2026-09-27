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

// Only the view-consumed blank Project state is needed; network/controller
// ownership stays covered by the controller and direct-route browser tests.
function shellProps(deletionStatus: "failed" | "pending"): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: { accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null },
    composer: {
      attachments: [], catalog: null, draft: "", currentParameterControls: defaultParameterControls(),
      assistant: { selected: null, pickerItems: [], recentIds: [], openPicker: false },
      knowledge: { bases: [], sources: [], documentTotal: null },
      memory: { mode: "NORMAL" }, workspace: { available: false, enabled: false },
      composerActions: {}, selectedSearchOptionIds: []
    },
    settings: { memory: { open: false }, settings: { open: false } },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }, projectSettings: { folder: null },
      projects: {
        selectedProjectId: "project-1", projects: [], workspace: { chats: [], folders: [] },
        detail: { id: "project-1", name: "Deleting Project", status: "DELETING", deletionStatus,
          directRole: "OWNER", capabilities: {}, resources: [], policy: { externalToolsEnabled: false } },
        actions: { deleteProject: vi.fn(), refresh: vi.fn(), leave: vi.fn() }
      }
    }
  } as unknown as PowerAppShellV2Props;
}

describe("Project deletion shell composition", () => {
  it.each(["failed", "pending"] as const)("opens %s deletion status on direct Project entry without opening Projects", (status) => {
    window.history.replaceState(null, "", "/p/project-1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ announcements: [] })));
    const props = shellProps(status);
    const { unmount } = render(<PowerAppShellV2View {...props} />);
    const overview = screen.getByTestId("project-overview-page");
    expect(within(overview).getByRole("heading", { name: "Deleting Project" })).toBeVisible();
    expect(within(overview).getByRole("status")).toHaveTextContent(status === "failed"
      ? "Deletion needs another attempt" : "Deletion in progress");
    expect(screen.queryByTestId("composer-v2")).toBeNull();
    fireEvent.click(within(overview).getByRole("button", { name: status === "failed" ? "Retry deletion" : "Check status" }));
    expect(status === "failed" ? props.workspace.projects.actions.deleteProject : props.workspace.projects.actions.refresh).toHaveBeenCalledOnce();
    unmount();
  });
});

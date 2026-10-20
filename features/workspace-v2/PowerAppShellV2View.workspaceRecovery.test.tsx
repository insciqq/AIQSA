import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import type { PowerAppShellV2Props } from "@/components/app-shell/powerAppShellV2Contracts";
import type { ComposerOperationRecovery } from "@/components/app-shell/composerSessionStore";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import { deactivatePersonalMcp } from "@/components/app-shell/personalMcpStore";
import {
  resetComposerControlStoreForTest,
  resetMcpSettingsStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { PowerAppShellV2View } from "./PowerAppShellV2View";

afterEach(() => {
  cleanup();
  deactivatePersonalMcp();
  resetComposerControlStoreForTest();
  resetMcpSettingsStoreForTest();
  resetWorkspaceStoreForTest();
  vi.unstubAllGlobals();
});

// Only the view-consumed state of a blank personal chat whose send was refused.
function shellProps(input: Readonly<{
  recoveries: readonly ComposerOperationRecovery[];
  reset?(): Promise<boolean>;
  sendWithoutWorkspace?(): void;
}>): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: { accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null },
    composer: {
      attachments: [], catalog: composerGalleryConfig.catalog, draft: "Use the files", currentParameterControls: defaultParameterControls(),
      assistant: { current: null, pickerItems: [], recentIds: [], openPicker: false, stripItems: [] },
      knowledge: { bases: [], sources: [], documentTotal: null },
      memory: { mode: "NORMAL" },
      workspace: { available: true, busy: false, enabled: true, reset: input.reset ?? vi.fn(async () => true), sessionState: "failed" },
      composerActions: {}, selectedSearchOptionIds: [],
      operationError: "Workspace in this chat stopped working.",
      operationErrorLive: true,
      operationErrorRecoveries: input.recoveries,
      operationErrorRetryable: false,
      submitComposer: vi.fn(),
      submitComposerWithoutWorkspace: input.sendWithoutWorkspace ?? vi.fn()
    },
    settings: {
      memory: { open: false },
      settings: { open: false, section: "connections", themeId: "dark" },
      closeSettings: vi.fn(), dismissNotice: vi.fn(), notice: null, updateTheme: vi.fn()
    },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }, projectSettings: { folder: null },
      projects: {
        selectedProjectId: null, projects: [], workspace: { chats: [], folders: [] }, detail: null,
        actions: { refresh: vi.fn(), leave: vi.fn() }
      }
    }
  } as unknown as PowerAppShellV2Props;
}

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ announcements: [], servers: [] })));
}

describe("Workspace refusal recovery", () => {
  it("opens the chat's one Reset workspace confirmation and sends without Workspace on request", async () => {
    stubFetch();
    const reset = vi.fn(async () => true);
    const sendWithoutWorkspace = vi.fn();
    render(<PowerAppShellV2View {...shellProps({
      recoveries: ["reset_workspace", "send_without_workspace"], reset, sendWithoutWorkspace
    })} />);

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Workspace in this chat stopped working.");
    expect(within(notice).queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(within(notice).getByRole("button", { name: "Send without Workspace" }));
    expect(sendWithoutWorkspace).toHaveBeenCalledOnce();

    expect(screen.queryByTestId("reset-workspace-confirmation")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Reset workspace…" }));
    const confirmation = await screen.findByTestId("reset-workspace-confirmation");
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm reset workspace" }));
    await waitFor(() => expect(reset).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId("reset-workspace-confirmation")).toBeNull());
  });

  it("shows no recovery action for a refusal without one", async () => {
    stubFetch();
    render(<PowerAppShellV2View {...shellProps({ recoveries: [] })} />);

    const notice = await screen.findByRole("alert");
    expect(within(notice).queryByRole("button", { name: "Send without Workspace" })).toBeNull();
    expect(within(notice).queryByRole("button", { name: "Reset workspace…" })).toBeNull();
  });
});

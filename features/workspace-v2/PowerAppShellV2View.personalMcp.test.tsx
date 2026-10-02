import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import type { PowerAppShellV2Props } from "@/components/app-shell/powerAppShellV2Contracts";
import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import { deactivatePersonalMcp, usePersonalMcpStore } from "@/components/app-shell/personalMcpStore";
import type { PersonalMcpConnection } from "@/components/app-shell/personalMcpApi";
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
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

const personalConnection: PersonalMcpConnection = {
  accountLabel: null, authHeaderName: null, authMode: "none", availableTools: [], description: "",
  enabled: true, fields: [], id: "personal-notes", knownToolCount: 2, name: "Personal notes",
  oauthAvailable: false, oauthState: null, readiness: "idle", runtimeErrorCode: null,
  sourceType: "personal", tools: [], userDisabledToolNames: []
};

// Only the view-consumed blank-chat state is needed; the composer reads its
// MCP disclosure from the shared stores and the Project detail.
function shellProps(project: boolean): PowerAppShellV2Props {
  return {
    branches: { open: false },
    session: { accountId: "owner", accountDisplayName: "Owner", accountEmail: null, activeChatId: null, notice: null },
    composer: {
      attachments: [], catalog: composerGalleryConfig.catalog, draft: "", currentParameterControls: defaultParameterControls(),
      assistant: { current: null, pickerItems: [], recentIds: [], openPicker: false, stripItems: [] },
      knowledge: { bases: [], sources: [], documentTotal: null },
      memory: { mode: "NORMAL" }, workspace: { available: false, enabled: false },
      composerActions: {}, selectedSearchOptionIds: []
    },
    settings: { memory: { open: false }, settings: { open: false } },
    thread: { visibleMessages: [], events: [], refreshLayout: vi.fn() },
    overlays: { share: { target: null }, confirmations: {} },
    workspace: {
      pane: { state: {}, actions: {} }, projectSettings: { folder: null },
      projects: project ? {
        selectedProjectId: "project-1", projects: [], syncState: "idle", workspace: { chats: [], folders: [] },
        detail: { id: "project-1", name: "Shared Project", status: "ACTIVE", directRole: "OWNER",
          effectiveRole: "OWNER", capabilities: { mutateChats: true }, resources: [], policy: { externalToolsEnabled: true },
          defaults: { knowledgePlan: { baseIds: [], sourceIds: [] }, providerModelId: null, searchPlan: { optionIds: [] } },
          composer: { mcpServers: [{ description: "", enabled: true, id: "project-tracker", knownToolCount: 1,
            name: "Project tracker", readiness: "idle", source: "installation" }] } },
        actions: { refresh: vi.fn(), leave: vi.fn(), openSettings: vi.fn() }
      } : {
        selectedProjectId: null, projects: [], workspace: { chats: [], folders: [] }, detail: null,
        actions: { refresh: vi.fn(), leave: vi.fn() }
      }
    }
  } as unknown as PowerAppShellV2Props;
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input).split("?")[0];
    if (path === "/api/me/mcp-connections") return Response.json({ servers: [personalConnection] });
    if (path === "/api/me/mcp") return Response.json({ servers: [] });
    return Response.json({ announcements: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const personalReads = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls
  .filter(([input]) => String(input).startsWith("/api/me/mcp-connections"));

function mcpSources(): (string | null)[] {
  fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
  const tags = screen.queryByTestId("composer-v2-mcp-servers");
  return tags ? [...tags.querySelectorAll(".v2-composer-tag")].map((tag) => tag.getAttribute("data-source")) : [];
}

describe("personal MCP connections in the composer disclosure", () => {
  it("loads and discloses the personal store in a personal chat", async () => {
    const fetchMock = stubFetch();
    render(<PowerAppShellV2View {...shellProps(false)} />);
    await waitFor(() => expect(usePersonalMcpStore.getState().loadState).toBe("ready"));
    expect(personalReads(fetchMock)).toHaveLength(1);
    expect(mcpSources()).toEqual(["personal"]);
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("Personal notes (your connection)");
  });

  it("never loads or discloses personal connections in a Project chat", async () => {
    window.history.replaceState(null, "", "/p/project-1");
    const fetchMock = stubFetch();
    render(<PowerAppShellV2View {...shellProps(true)} />);
    await act(async () => undefined);
    expect(personalReads(fetchMock)).toEqual([]);
    expect(usePersonalMcpStore.getState().loadState).toBe("idle");
    // Rows a personal chat loaded earlier stay out of the Project's list.
    act(() => { usePersonalMcpStore.setState({ connections: [personalConnection], loadState: "ready" }); });
    expect(mcpSources()).toEqual(["installation"]);
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("Project tracker");
    expect(screen.getByTestId("composer-v2-mcp-servers")).not.toHaveTextContent("Personal notes");
  });
});

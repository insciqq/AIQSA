import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions
} from "@/components/app-shell/assistantLibraryController";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantContent,
  assistantControllerInput,
  assistantDetail,
  assistantList,
  assistantSummary,
  installAssistantEditor
} from "@/tests/support/assistantLibraryFixtures";
import { AssistantsTabV2, assistantsTabSubviewV2 } from "./AssistantsTabV2";

const mocks = vi.hoisted(() => ({
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  loadUserMcpServers: vi.fn(),
  publishAssistant: vi.fn(),
  setAssistantFeaturedOrder: vi.fn()
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  publishAssistant: mocks.publishAssistant,
  setAssistantFeaturedOrder: mocks.setAssistantFeaturedOrder
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

const store = () => useAssistantLibraryStore.getState();

function composer(sendStarter = vi.fn()) {
  return {
    assistant: { pickerItems: [], sendStarter, startFromCurrentSetup: vi.fn() }
  } as unknown as ShellComposerView;
}

function libraryView() {
  const input = assistantControllerInput();
  return buildAssistantLibraryView(input, createAssistantLibraryActions(input), store());
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({ data: assistantList(), ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
});

afterEach(() => resetSkillLibraryStoreForTest());

const liveInput = assistantControllerInput();
const liveActions = createAssistantLibraryActions(liveInput);

function LiveTab() {
  useAssistantLibraryStore();
  return (
    <AssistantsTabV2
      composer={composer()}
      onOpenMcpSettings={vi.fn()}
      onRequestClose={vi.fn()}
      view={buildAssistantLibraryView(liveInput, liveActions, store())}
    />
  );
}

/** An administrator's own Assistant, listed only to its owner; Save lists it and features it. */
function installAdministrator(extra: Partial<ReturnType<typeof store>> = {}) {
  const viewer = { canPublishInstallation: true, defaultAssistantId: null };
  store().patch({
    data: assistantList({ assistants: [assistantSummary()], viewer }),
    dataState: "ready",
    open: true,
    ...extra
  });
  mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(), ok: true });
  const listed = assistantDetail(3, {
    audience: { everyone: true, groupNames: [] },
    featured: true,
    featuredOrder: 0,
    publications: [{ groupId: null, groupName: null, id: "pub-installation", scope: "installation", updatedAt: "2026-09-20T00:00:00.000Z" }]
  });
  mocks.fetchAssistantDetail.mockResolvedValue({ data: listed, ok: true });
  mocks.fetchAssistantList.mockResolvedValue({
    data: assistantList({
      assistants: [assistantSummary({ audience: { everyone: true, groupNames: [] }, featured: true, featuredOrder: 0, published: true })],
      viewer
    }),
    ok: true
  });
  mocks.publishAssistant.mockResolvedValue({ data: undefined, ok: true });
  mocks.setAssistantFeaturedOrder.mockResolvedValue({ data: [{ assistantId: "assistant-1", featuredOrder: 0 }], ok: true });
}

async function saveEveryoneAndFeatured() {
  const sharing = await screen.findByRole("dialog", { name: "Sharing · Code reviewer" });
  await waitFor(() => expect(within(sharing).getByRole("radio", { name: "Only me" })).toBeChecked());
  fireEvent.click(within(sharing).getByRole("radio", { name: "Everyone in this installation" }));
  fireEvent.click(within(sharing).getByRole("switch", { name: "Featured" }));
  const save = within(sharing).getByRole("button", { name: "Save" });
  save.focus();
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByTestId("assistant-sharing-sheet")).toBeNull());
  expect(mocks.publishAssistant).toHaveBeenCalledWith("assistant-1", { scope: "installation" });
  expect(mocks.setAssistantFeaturedOrder).toHaveBeenCalledWith("assistant-1", 0);
}

describe("Assistants tab seam", () => {
  it("shows the gallery loading until Studio loads the section", () => {
    render(<AssistantsTabV2 composer={composer()} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={null} />);

    expect(screen.getByRole("status", { name: "Loading Assistants" })).toBeInTheDocument();
    expect(assistantsTabSubviewV2(null, vi.fn())).toBeNull();
  });

  it("renders the gallery from the view and routes its actions", () => {
    store().patch({
      data: assistantList({ assistants: [assistantSummary({ name: "API Reviewer" })] }),
      dataState: "ready",
      open: true
    });
    const view = libraryView()!;
    const onEdit = vi.spyOn(view.gallery, "onEdit").mockImplementation(() => undefined);
    const onStartChat = vi.spyOn(view.gallery, "onStartChat").mockResolvedValue(true);
    const onOpen = vi.spyOn(view.newAssistant, "onOpen").mockImplementation(() => undefined);

    render(<AssistantsTabV2 composer={composer()} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={view} />);

    fireEvent.click(screen.getByRole("button", { name: "Start chat with API Reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for API Reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "New assistant" }));
    expect(onStartChat).toHaveBeenCalledWith("assistant-1");
    expect(onEdit).toHaveBeenCalledWith("assistant-1");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("sends a sheet starter into the new chat only once its Assistant is chosen, and never when it became unavailable", async () => {
    const events: string[] = [];
    const input = assistantControllerInput();
    // Studio was opened from an existing chat; Start chat leaves it for a new one.
    input.activateBlankWorkspace = vi.fn(() => { events.push("new chat"); });
    input.chooseAssistant = vi.fn(async (chosen) => {
      events.push(`chose ${chosen.id}`);
      return null;
    });
    const sendStarter = vi.fn((prompt: string) => { events.push(`sent ${prompt}`); });
    const detail = assistantDetail(3, { content: assistantContent({ starterPrompts: ["Say hello"] }) });
    const openSheet = () => {
      store().patch({
        data: assistantList({ assistants: [assistantSummary({ starterPrompts: ["Say hello"] })] }),
        dataState: "ready",
        detail: { assistantId: "assistant-1", detail, error: null, requestId: 1, state: "ready" },
        notice: null,
        open: true
      });
      return buildAssistantLibraryView(input, createAssistantLibraryActions(input), store());
    };

    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail, ok: true });
    const first = render(<AssistantsTabV2 composer={composer(sendStarter)} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={openSheet()} />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("button", { name: "Say hello" }));
    await waitFor(() => expect(sendStarter).toHaveBeenCalledOnce());
    expect(events).toEqual(["new chat", "chose assistant-1", "sent Say hello"]);
    expect(store().open).toBe(false);
    first.unmount();

    // The Assistant stopped being usable between opening the sheet and the click.
    events.length = 0;
    sendStarter.mockClear();
    mocks.fetchAssistantDetail.mockResolvedValue({
      data: { ...detail, availability: { ok: false, reason: "tools_access" } },
      ok: true
    });
    const second = render(<AssistantsTabV2 composer={composer(sendStarter)} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={openSheet()} />);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("button", { name: "Say hello" }));
    await waitFor(() => expect(store().notice).toEqual({
      kind: "error",
      text: "This assistant needs access you do not currently have."
    }));
    second.rerender(<AssistantsTabV2 composer={composer(sendStarter)} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={buildAssistantLibraryView(input, createAssistantLibraryActions(input), store())} />);
    expect(within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("alert"))
      .toHaveTextContent("This assistant needs access you do not currently have.");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(sendStarter).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("mounts the delete dialog from the view", () => {
    store().patch({
      data: assistantList({ assistants: [assistantSummary()] }),
      dataState: "ready",
      deletion: {
        assistantId: "assistant-1",
        consequences: null,
        error: null,
        name: "Code reviewer",
        requestId: 1,
        state: "loading"
      },
      open: true
    });

    render(<AssistantsTabV2 composer={composer()} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={libraryView()} />);

    expect(screen.getByRole("dialog", { name: "Delete “Code reviewer”?" })).toBeInTheDocument();
  });

  it("renders the editor page over the rows draft and names its crumb", () => {
    installAssistantEditor();
    const view = libraryView()!;
    const onRowChange = vi.spyOn(view.editor!, "onRowChange");
    const onRequestClose = vi.fn();

    render(<AssistantsTabV2 composer={composer()} onOpenMcpSettings={vi.fn()} onRequestClose={onRequestClose} view={view} />);

    expect(screen.getByTestId("assistant-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByLabelText("Model")).toHaveValue("model-1");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
    expect(onRowChange).toHaveBeenCalledWith("model", { value: { mode: "inherit" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(assistantsTabSubviewV2(view, onRequestClose)).toMatchObject({
      backLabel: "Back to Assistants",
      key: "assistant-editor",
      label: "Code reviewer"
    });
    // A cleared name field keeps the saved name in the crumb.
    store().patchEditor({ draft: { ...store().editor!.draft, name: "" } });
    expect(assistantsTabSubviewV2(libraryView()!, onRequestClose)?.label).toBe("Code reviewer");
  });

  it("opens Sharing over the detail sheet and returns to it on close", async () => {
    const detail = assistantDetail();
    store().patch({
      data: assistantList({ assistants: [assistantSummary()] }),
      dataState: "ready",
      detail: { assistantId: "assistant-1", detail, error: null, requestId: 1, state: "ready" },
      open: true
    });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: detail, ok: true });
    render(<LiveTab />);

    const manage = within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("button", { name: "Manage sharing…" });
    manage.focus();
    fireEvent.click(manage);
    const sharing = await screen.findByRole("dialog", { name: "Sharing · Code reviewer" });
    await waitFor(() => expect(within(sharing).getByRole("radio", { name: "Only me" })).toBeChecked());
    // One layer on top: the detail sheet stays mounted under it, inert.
    expect(screen.getByTestId("assistant-detail-sheet")).toHaveAttribute("aria-hidden", "true");

    fireEvent.keyDown(sharing, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("assistant-sharing-sheet")).toBeNull());
    await waitFor(() => expect(manage).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Code reviewer" })).toBeInTheDocument();
  });

  it("returns focus to Manage sharing… of the detail sheet after Save", async () => {
    installAdministrator({
      detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" }
    });
    render(<LiveTab />);
    const manage = within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("button", { name: "Manage sharing…" });
    manage.focus();
    fireEvent.click(manage);

    await saveEveryoneAndFeatured();

    await waitFor(() => expect(manage).toHaveFocus());
    expect(within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("status")).toHaveTextContent("Sharing updated.");
  });

  it("returns focus to the card's menu button after Save moved the card into Featured", async () => {
    installAdministrator();
    render(<LiveTab />);
    const trigger = screen.getByRole("button", { name: "More actions for Code reviewer" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Share…" }));

    await saveEveryoneAndFeatured();

    // The card is rendered anew in the Featured group; focus follows it.
    await waitFor(() => expect(screen.getByRole("button", { name: "More actions for Code reviewer" })).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
  });

  it("returns focus to the editor's Manage sharing… on Cancel", async () => {
    installAssistantEditor();
    store().patch({ data: assistantList({ assistants: [assistantSummary()] }), dataState: "ready" });
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(), ok: true });
    render(<LiveTab />);
    const manage = screen.getByRole("button", { name: "Manage sharing…" });
    manage.focus();
    fireEvent.click(manage);
    const sharing = await screen.findByRole("dialog", { name: "Sharing · Code reviewer" });
    await waitFor(() => expect(within(sharing).getByRole("radio", { name: "Only me" })).toBeChecked());

    fireEvent.click(within(sharing).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByTestId("assistant-sharing-sheet")).toBeNull());
    await waitFor(() => expect(manage).toHaveFocus());
  });

  it("opens the New assistant sheet from the view", () => {
    store().patch({ newAssistantOpen: true, open: true });
    const view = libraryView()!;
    const onTemplate = vi.spyOn(view.newAssistant, "onTemplate").mockImplementation(() => undefined);

    render(<AssistantsTabV2 composer={composer()} onOpenMcpSettings={vi.fn()} onRequestClose={vi.fn()} view={view} />);

    fireEvent.click(screen.getByRole("radio", { name: "Meeting notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: "Meeting notes" }), undefined);
  });
});

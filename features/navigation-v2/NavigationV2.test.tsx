import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  resetRunLifecycleStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import type { ChatMessageMatchWire, ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import { AnnouncementsProvider } from "@/components/announcements/AnnouncementsProvider";
import * as announcementsApi from "@/components/announcements/api";
import {
  flattenFolderTree,
  NavigationSidebar,
  NavigationSidebarContainer,
  ReadingRoomShellV2
} from "./NavigationV2";

const now = new Date("2026-08-13T12:00:00.000Z");
const chats: ChatNavigationSummaryWire[] = [
  {
    activeRun: true,
    assistant: null,
    folderId: null,
    id: "today",
    title: "Running answer",
    updatedAt: "2026-08-13T08:00:00.000Z"
  },
  {
    activeRun: false,
    assistant: null,
    folderId: null,
    id: "yesterday",
    title: "Selected brief",
    updatedAt: "2026-08-12T08:00:00.000Z"
  }
];

const messageMatch: ChatMessageMatchWire = {
  chatId: "found",
  createdAt: "2026-08-10T09:00:00.000Z",
  matchCount: 3,
  messageId: "message-7",
  snippet: "…we moved the Budget review to Friday…",
  title: "Planning"
};

function responsiveMatchMedia(getWidth: () => number) {
  return vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: query.includes("767px")
      ? getWidth() <= 767
      : query.includes("1023px")
        ? getWidth() <= 1023
        : false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  } as unknown as MediaQueryList));
}

function sidebar(overrides: Partial<Parameters<typeof NavigationSidebar>[0]> = {}) {
  const props: Parameters<typeof NavigationSidebar>[0] = {
    activeChatId: "yesterday",
    chats,
    error: null,
    folders: [],
    hasMore: false,
    loading: false,
    now,
    onClose: vi.fn(),
    onLoadMore: vi.fn(),
    onNewChat: vi.fn(),
    onRetry: vi.fn(),
    onSearch: vi.fn(),
    onSelectChat: vi.fn(),
    ready: true,
    searchError: null,
    searchLoading: false,
    searchQuery: "",
    ...overrides
  };
  return { props, view: render(<NavigationSidebar {...props} />) };
}

describe("Navigation v2", () => {
  afterEach(() => {
    resetRunLifecycleStoreForTest();
    resetWorkspaceStoreForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["Chats", "New chat", "Projects", "shortcut", "chat"])("defers the entire %s exit until Studio releases it", (destination) => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 1440));
    useWorkspaceStore.getState().applyNavigationPage({ chats, folders: [], nextCursor: null }, false);
    let pending: (() => void) | undefined;
    const guard = vi.fn((proceed: () => void) => { pending = proceed; });
    const onNewChat = vi.fn();
    const onSelectChat = vi.fn();
    const onChats = vi.fn();
    const onProjectsSectionChange = vi.fn();
    const onLeaveProject = vi.fn();
    render(<ReadingRoomShellV2 section="library" onRequestNavigation={guard} onNewChat={onNewChat}
      onSelectChat={onSelectChat} onChats={onChats} onProjectsSectionChange={onProjectsSectionChange}
      onLeaveProject={onLeaveProject} projectsSlot={<p>Project catalog</p>}>
      <main>Draft</main>
    </ReadingRoomShellV2>);
    if (destination === "shortcut") fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "O" });
    else if (destination === "chat") fireEvent.click(screen.getByRole("treeitem", { name: "Selected brief" }));
    else fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: destination }));
    expect(guard).toHaveBeenCalledOnce();
    for (const callback of [onNewChat, onSelectChat, onChats, onProjectsSectionChange, onLeaveProject]) expect(callback).not.toHaveBeenCalled();
    act(() => pending?.());
    if (destination === "chat") expect(onSelectChat).toHaveBeenCalledWith(chats[1]);
    else if (destination === "New chat" || destination === "shortcut") expect(onNewChat).toHaveBeenCalledWith("NORMAL");
    else if (destination === "Projects") expect(onProjectsSectionChange).toHaveBeenLastCalledWith(true);
    else expect(onChats).toHaveBeenCalledOnce();
  });

  it("disables pending exits without invoking a discard guard, while Settings remains an overlay", () => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 1440));
    const guard = vi.fn();
    const onSettings = vi.fn();
    render(<ReadingRoomShellV2 section="library" navigationBusy onRequestNavigation={guard} onNewChat={vi.fn()}
      onSelectChat={vi.fn()} onLibrary={vi.fn()} onSettings={onSettings} projectsSlot={<p>Projects</p>}><main>Saving</main></ReadingRoomShellV2>);
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    for (const name of ["Chats", "New chat", "Projects", "Studio"]) expect(within(rail).getByRole("button", { name })).toBeDisabled();
    fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "O" });
    expect(guard).not.toHaveBeenCalled();
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("shares the announcement count between the closed mobile trigger and drawer bell", async () => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 390));
    const count = vi.spyOn(announcementsApi, "getAnnouncementUnreadCount").mockResolvedValue(3);
    try {
      render(<AnnouncementsProvider accountId="navigation-reader"><ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()}
        sidebar={close => <NavigationSidebar {...sidebarProps({ drawerDestinations: true, onClose: close })} />}>
        <main>Conversation</main>
      </ReadingRoomShellV2></AnnouncementsProvider>);
      const trigger = screen.getByRole("button", { name: "Open sidebar" });
      await waitFor(() => expect(trigger).toHaveAttribute("data-announcements-unread", "true"));
      expect(trigger).toHaveAccessibleDescription("Unread announcements");
      fireEvent.click(trigger);
      expect(screen.getByRole("button", { name: "Announcements, 3 unread" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
      count.mockResolvedValue(0);
      fireEvent.focus(window);
      await waitFor(() => expect(trigger).not.toHaveAttribute("data-announcements-unread"));
      expect(trigger).not.toHaveAttribute("aria-describedby");
    } finally { count.mockRestore(); }
  });

  it("renders stable date groups, selected state, and an active-run cue", () => {
    sidebar();

    expect(screen.getByText("Today")).toBeVisible();
    expect(screen.getByText("Yesterday")).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "Selected brief" })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByLabelText("Answer in progress")).toBeVisible();
  });

  it("leads a chat with its Assistant's 16px avatar and leaves other rows unchanged", () => {
    const assistant = {
      avatar: {
        accents: [0, 4],
        backgroundShape: "circle",
        foregroundShape: "diamond",
        kind: "generated",
        paletteId: "ocean",
        recipeVersion: 1,
        rotations: [0, 2]
      },
      name: "Research partner"
    } as const satisfies NonNullable<ChatNavigationSummaryWire["assistant"]>;
    sidebar({ chats: [{ ...chats[0], assistant }, { ...chats[1], assistant }, {
      activeRun: false,
      assistant: null,
      folderId: null,
      id: "plain",
      title: "Plain chat",
      updatedAt: "2026-08-12T07:00:00.000Z"
    }] });

    const running = screen.getByRole("treeitem", { name: "Running answer" });
    const settled = screen.getByRole("treeitem", { name: "Selected brief" });
    const plain = screen.getByRole("treeitem", { name: "Plain chat" });
    for (const row of [running, settled]) {
      const avatar = within(row).getByTestId("assistant-avatar");
      expect(avatar).toHaveAttribute("width", "16");
      expect(avatar).toHaveAttribute("aria-hidden", "true");
      expect(row).not.toHaveTextContent("Research partner");
    }
    // The live dot stays first; the avatar follows it.
    expect(within(running).getByLabelText("Answer in progress").nextElementSibling)
      .toBe(within(running).getByTestId("assistant-avatar"));
    expect(within(plain).queryByTestId("assistant-avatar")).toBeNull();
    expect(plain.firstElementChild).toBeEmptyDOMElement();
    expect(plain.querySelector(".v2-chat-title")).toHaveTextContent("Plain chat");
  });

  it("describes an unopened scheduled result without renaming the row", () => {
    sidebar({ chats: [
      { ...chats[0], scheduledTask: { taskId: "task-1", unseen: true } },
      { ...chats[1], scheduledTask: { taskId: "task-2", unseen: false } }
    ] });
    const unread = screen.getByRole("treeitem", { name: chats[0].title });
    const read = screen.getByRole("treeitem", { name: chats[1].title });
    expect(unread).toHaveAccessibleDescription("New scheduled result");
    expect(unread.querySelector(".v2-chat-unread")).toHaveAttribute("aria-hidden", "true");
    expect(read).not.toHaveAttribute("aria-describedby");
    expect(read.querySelector(".v2-chat-unread")).toBeNull();
  });

  it("uses one roving Tab stop and opens the focused row menu with Shift+F10", async () => {
    sidebar();
    const tree = screen.getByRole("tree", { name: "Personal chats" });
    const running = within(tree).getByRole("treeitem", { name: "Running answer" });
    const selected = within(tree).getByRole("treeitem", { name: "Selected brief" });
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0))
      .toEqual([selected]);

    selected.focus();
    fireEvent.keyDown(selected, { key: "ArrowUp" });
    expect(running).toHaveFocus();
    fireEvent.keyDown(running, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Chat actions: Running answer" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    });
  });

  it("offers a bounded skip path from navigation to the enabled composer", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <>
        <NavigationSidebar {...sidebarProps({ onClose })} />
        <div data-testid="composer-v2"><textarea aria-label="Message" /></div>
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip to message composer" }));
    act(() => vi.runAllTimers());

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("presents a persisted default-title chat as New chat", () => {
    sidebar({
      activeChatId: "blank",
      chats: [{
        activeRun: false,
        assistant: null,
        folderId: null,
        id: "blank",
        title: "New Chat",
        updatedAt: "2026-08-13T08:00:00.000Z"
      }]
    });

    expect(document.querySelector('[data-navigation-chat-id="blank"] .v2-chat-row'))
      .toHaveAttribute("data-selected", "true");
    expect(screen.queryByText("New Chat")).toBeNull();
  });

  it("keeps loading, error, empty, and search-empty states explicit", () => {
    const { view } = sidebar({ chats: [], loading: true, ready: false });
    expect(screen.getByLabelText("Loading chats")).toBeVisible();

    view.rerender(<NavigationSidebar {...{
      ...sidebarProps({ chats: [], error: "failed", ready: false })
    }} />);
    expect(screen.getByText("Could not load chats")).toBeVisible();

    view.rerender(<NavigationSidebar {...sidebarProps({ chats: [] })} />);
    expect(screen.getByText("Start your first chat")).toBeVisible();

    view.rerender(<NavigationSidebar {...sidebarProps({ chats: [], searchQuery: "missing" })} />);
    expect(screen.getByText("Nothing found")).toBeVisible();
  });

  it("gives the sidebar list region to a selected Project", () => {
    sidebar({
      chats: [],
      drawerDestinations: true,
      onSettings: vi.fn(),
      projectContextActive: true,
      projectTitle: <><span aria-hidden="true">I</span><span>Ingest pipeline</span></>,
      projectsSlot: <div>Project chat tree</div>
    });

    expect(screen.getByText("Project chat tree")).toBeVisible();
    expect(screen.getByText("Ingest pipeline")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Project navigation" })).toBeVisible();
    expect(screen.queryByText("Start your first chat")).toBeNull();
    // Archived chat management belongs to Settings › Data, not the drawer.
    expect(screen.queryByRole("button", { name: "Archived chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "New chat mode" })).toBeNull();
    expect(screen.queryByText(/Memory off|Normal memory|Exclude from Memory|Resume Memory/)).toBeNull();
  });

  it("omits the composer skip path when the selected Project cannot start a chat", () => {
    sidebar({
      chats: [],
      projectComposerAvailable: false,
      projectContextActive: true,
      projectsSlot: <div>Read-only Project tree</div>
    });

    expect(screen.getByText("Read-only Project tree")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Skip to message composer" })).toBeNull();
  });

  it("routes Normal, Memory-off, and Temporary new-chat intents and marks the current mode", () => {
    const onNewChat = vi.fn();
    sidebar({ currentNewChatMode: "EXCLUDED", onNewChat });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenLastCalledWith("NORMAL");
    fireEvent.click(screen.getByRole("button", { name: "New chat mode" }));
    expect(screen.getByRole("menuitem", { name: /Memory off/ })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(screen.getByRole("menuitem", { name: /Normal/ })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("menuitem", { name: /Memory off/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("EXCLUDED");
    fireEvent.click(screen.getByRole("button", { name: "New chat mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Temporary chat/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("TEMPORARY");
  });

  it("creates a root folder from the Folders header, not from the New-chat mode menu", () => {
    const onCreateFolder = vi.fn(async () => undefined);
    sidebar({ onCreateFolder });

    // The mode menu carries only chat modes (UX audit F16).
    fireEvent.click(screen.getByRole("button", { name: "New chat mode" }));
    expect(screen.queryByRole("menuitem", { name: "New folder" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu", { name: "New chat mode" }), { key: "Escape" });

    // Reachable in one click even before the first folder exists.
    expect(screen.getByText("Folders")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "Исследования" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect(onCreateFolder).toHaveBeenCalledWith(null, "Исследования");
  });

  it("filters chats through the server search with a debounce and clears on Escape", () => {
    vi.useFakeTimers();
    try {
      const onSearch = vi.fn();
      const { view } = sidebar({ onSearch });
      const field = screen.getByRole("searchbox", { name: "Filter chats" });

      fireEvent.change(field, { target: { value: "bri" } });
      fireEvent.change(field, { target: { value: "brief" } });
      expect(onSearch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenLastCalledWith("brief");

      view.rerender(<NavigationSidebar {...sidebarProps({ onSearch, searchQuery: "brief" })} />);
      fireEvent.keyDown(field, { key: "Escape" });
      expect(onSearch).toHaveBeenLastCalledWith("");
      expect(field).toHaveValue("");

      // The owner resetting the query (a result was opened) empties the field.
      fireEvent.change(field, { target: { value: "note" } });
      vi.advanceTimersByTime(250);
      view.rerender(<NavigationSidebar {...sidebarProps({ onSearch, searchQuery: "note" })} />);
      view.rerender(<NavigationSidebar {...sidebarProps({ onSearch, searchQuery: "" })} />);
      const empty = screen.getByRole("searchbox", { name: "Filter chats" });
      expect(empty).toHaveValue("");

      // Escape in an empty field leaves it (UX audit 2026-09-02 A15).
      empty.focus();
      expect(empty).toHaveFocus();
      fireEvent.keyDown(empty, { key: "Escape" });
      expect(empty).not.toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches a query typed right after a background render, before that render's effects ran", async () => {
    // The store-connected owner passes a new `onSearch` on every render, and a
    // loading workspace commits renders all the time. An input event that
    // arrives between such a commit and its effects makes React run those
    // effects first, with the field as that render saw it: typed while the
    // workspace loaded, the query was dropped and never searched.
    const onSearch = vi.fn();
    let renderInBackground!: () => void;
    function Owner() {
      const [renders, setRenders] = useState(0);
      renderInBackground = () => setRenders((count) => count + 1);
      useLayoutEffect(() => {
        if (renders !== 1) return;
        // Typed inside the background commit, whose effects have not run yet.
        const field = screen.getByRole("searchbox", { name: "Filter chats" });
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "blocks");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, [renders]);
      return <NavigationSidebar {...sidebarProps({ onSearch: (value) => onSearch(value) })} />;
    }
    render(<Owner />);
    await act(async () => renderInBackground());

    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toHaveValue("blocks");
    await waitFor(() => expect(onSearch).toHaveBeenCalledExactlyOnceWith("blocks"));
  });

  it("toggles the sidebar with Ctrl/⌘+Shift+S", () => {
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    fireEvent.keyDown(window, { ctrlKey: true, key: "S", shiftKey: true });
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });
    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
  });

  it("keeps the filter out of a selected Project's sidebar", () => {
    sidebar({ chats: [], projectContextActive: true, projectsSlot: <div>Project chat tree</div> });
    expect(screen.queryByRole("searchbox", { name: "Filter chats" })).toBeNull();
  });

  it("hides the Folders header when folder creation is unavailable and no folder exists", () => {
    sidebar({ folders: [] });
    expect(screen.queryByText("Folders")).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
  });

  it("does not submit chat or folder rename forms when they are cancelled", () => {
    const onCancelChatRename = vi.fn();
    const onCancelFolderRename = vi.fn();
    const onSaveChatRename = vi.fn();
    const onSaveFolderRename = vi.fn();
    sidebar({
      editingChatId: "yesterday",
      editingChatTitle: "Changed chat",
      editingFolderId: "folder-research",
      editingFolderName: "Changed folder",
      folders: [{ id: "folder-research", name: "Research", parentId: null }],
      onCancelChatRename,
      onCancelFolderRename,
      onSaveChatRename,
      onSaveFolderRename
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(onCancelChatRename).toHaveBeenCalledOnce();
    expect(onCancelFolderRename).toHaveBeenCalledOnce();
    expect(onSaveChatRename).not.toHaveBeenCalled();
    expect(onSaveFolderRename).not.toHaveBeenCalled();
  });

  it("keeps a rejected rename and a failed folder creation in their fields", async () => {
    const fieldError = "Use at most 120 characters for the chat title (chat_title_too_long)";
    const onChangeChatRename = vi.fn();
    const onSaveChatRename = vi.fn(async () => ({ fieldError, ok: false as const }));
    const onCreateFolder = vi.fn()
      .mockResolvedValueOnce({ fieldError: null, ok: false })
      .mockResolvedValueOnce({ ok: true });
    sidebar({
      editingChatId: "yesterday",
      editingChatTitle: "Rejected title",
      onChangeChatRename,
      onCreateFolder,
      onSaveChatRename
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    });
    const titleField = screen.getByRole("textbox", { name: "New title: Selected brief" });
    expect(screen.getByRole("alert")).toHaveTextContent(fieldError);
    expect(titleField).toHaveValue("Rejected title");
    expect(titleField).toHaveAttribute("aria-invalid", "true");
    expect(titleField).toHaveAccessibleDescription(fieldError);
    fireEvent.change(titleField, { target: { value: "Shorter" } });
    expect(onChangeChatRename).toHaveBeenCalledWith("Shorter");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "Research notes" }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    });
    expect(screen.getByRole("textbox", { name: "New folder name" })).toHaveValue("Research notes");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    });
    expect(onCreateFolder).toHaveBeenCalledTimes(2);
    expect(onCreateFolder).toHaveBeenLastCalledWith(null, "Research notes");
    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();
  });

  it("does not create root or nested folders when their forms are cancelled", () => {
    const onCreateFolder = vi.fn();
    sidebar({
      folders: [{ id: "folder-research", name: "Research", parentId: null }],
      onCreateFolder
    });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "Root draft" }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.getByRole("menuitem", { name: "Default Knowledge…" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Project settings" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "New subfolder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Subfolder name in Research" }), {
      target: { value: "Nested draft" }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(onCreateFolder).not.toHaveBeenCalled();
  });

  it("keeps the row menu to five object actions and fences mutations during a run", () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const onMemoryMode = vi.fn();
    sidebar({
      chatStateFor: (chat) => chat.id === "today"
        ? { favorite: true, memoryMode: "NORMAL" }
        : { favorite: false, memoryMode: "EXCLUDED" },
      onArchive,
      onBranches: vi.fn(),
      onCopyThread: vi.fn(),
      onDelete,
      onExport: vi.fn(),
      onMemoryMode
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions: Running answer" }));
    const menu = screen.getByRole("menu", { name: "Chat actions: Running answer" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Move to…",
      "Favorite",
      "Archive",
      "Delete…"
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Delete…" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Favorite" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(within(menu).queryByRole("menuitem", { name: "Exclude from Memory" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Branches" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Export" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Share" })).toBeNull();
    expect(onMemoryMode).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("shows Delete… only with the capability and routes it to the confirm opener", () => {
    const onDelete = vi.fn();
    const { view } = sidebar();

    fireEvent.click(screen.getByRole("button", { name: "Actions: Selected brief" }));
    expect(screen.queryByRole("menuitem", { name: "Delete…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), { key: "Escape" });

    view.rerender(<NavigationSidebar {...sidebarProps({ onDelete })} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions: Selected brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(onDelete).toHaveBeenCalledWith(chats[1]);

    // A running chat cannot be deleted directly either.
    fireEvent.click(screen.getByRole("button", { name: "Actions: Running answer" }));
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeDisabled();
  });

  it("lists every nested folder with indentation inside Move to…", () => {
    const onMove = vi.fn();
    sidebar({
      folders: [
        { id: "root-a", name: "Research", parentId: null },
        { id: "child-a", name: "Recall", parentId: "root-a" },
        { id: "grand-a", name: "Evidence", parentId: "child-a" },
        { id: "root-b", name: "Ops", parentId: null }
      ],
      onMove
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions: Selected brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const options = screen.getByLabelText("Move to…");
    const labels = [...options.querySelectorAll("[role='menuitem']")]
      .map((item) => item.textContent);
    expect(labels).toEqual(["No folder", "Research", "Recall", "Evidence", "Ops"]);
    const nested = [...options.querySelectorAll("[role='menuitem']")]
      .find((item) => item.textContent === "Evidence") as HTMLElement;
    expect(nested.style.paddingLeft).toBe("2rem");
    fireEvent.click(nested);
    expect(onMove).toHaveBeenCalledWith(chats[1], "grand-a");
  });

  it("flattens the folder tree and excludes a moved folder's own subtree", () => {
    const folders = [
      { id: "root-a", name: "Research", parentId: null },
      { id: "child-a", name: "Recall", parentId: "root-a" },
      { id: "grand-a", name: "Evidence", parentId: "child-a" },
      { id: "root-b", name: "Ops", parentId: null },
      { id: "orphan", name: "Detached", parentId: "missing" }
    ];

    expect(flattenFolderTree(folders).map(({ depth, folder }) => `${depth}:${folder.id}`))
      .toEqual(["0:root-a", "1:child-a", "2:grand-a", "0:root-b", "0:orphan"]);
    expect(flattenFolderTree(folders, "child-a").map(({ folder }) => folder.id))
      .toEqual(["root-a", "root-b", "orphan"]);
  });

  it("offers only the scoped chat filter, never a global search or command trigger", () => {
    sidebar();

    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Search|Commands/ })).toBeNull();
    expect(screen.queryByText(/⌘K|Ctrl\+K/)).toBeNull();
  });

  it("resets the search query when a result is selected", () => {
    const onSearch = vi.fn();
    const onSelectChat = vi.fn();
    sidebar({ onSearch, onSelectChat, searchQuery: "brief" });

    expect(screen.getByText("Results")).toBeVisible();
    fireEvent.click(screen.getByRole("treeitem", { name: "Selected brief" }));
    expect(onSearch).toHaveBeenCalledWith("");
    expect(onSelectChat).toHaveBeenCalledWith(chats[1]);
  });

  it("lists message matches after the title results, marks the query and opens the match", () => {
    const onOpenMessageMatch = vi.fn();
    const onSearch = vi.fn();
    sidebar({
      chats: [chats[1]!],
      messageMatches: [messageMatch, { ...messageMatch, chatId: "markup", matchCount: 1, messageId: "message-8",
        snippet: "<b>budget</b> stays text", title: "Markup" }],
      onOpenMessageMatch,
      onSearch,
      searchQuery: "budget"
    });

    const results = screen.getByRole("group", { name: "Results" });
    const inMessages = screen.getByRole("group", { name: "In messages" });
    expect(results.compareDocumentPosition(inMessages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = within(inMessages).getByRole("treeitem", { name: "Planning" });
    expect(row).toHaveAccessibleDescription(/we moved the Budget review to Friday… · 3 matches Aug 10/u);
    expect(within(row).getByText("Budget", { selector: "mark" })).toBeVisible();
    expect(row.querySelector("time")).toHaveAttribute("dateTime", messageMatch.createdAt);
    // Server text never becomes markup.
    const markup = within(inMessages).getByRole("treeitem", { name: "Markup" });
    expect(markup.querySelector("b")).toBeNull();
    expect(markup).toHaveTextContent("<b>budget</b> stays text");

    fireEvent.click(row);
    expect(onSearch).toHaveBeenCalledWith("");
    expect(onOpenMessageMatch).toHaveBeenCalledWith(messageMatch);
  });

  it("reads as searching, not as nothing found, while a new query waits for its request", () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().applyNavigationPage({ chats, folders: [], nextCursor: null }, false);
    render(<NavigationSidebarContainer onClose={vi.fn()} onNewChat={vi.fn()} onSelectChat={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter chats" }), { target: { value: "budget" } });
    act(() => vi.advanceTimersByTime(300));

    expect(useWorkspaceStore.getState().navigationSearchQuery).toBe("budget");
    expect(screen.getByText("Searching chats…")).toBeVisible();
    expect(within(screen.getByRole("group", { name: "In messages" })).getByText("Searching messages…")).toBeVisible();
    expect(screen.queryByText("Nothing found")).toBeNull();

    // Below three characters only the titles are searched.
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter chats" }), { target: { value: "bu" } });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("Searching chats…")).toBeVisible();
    expect(screen.queryByRole("group", { name: "In messages" })).toBeNull();
  });

  it("gives the message section its own searching, empty and failure states beside the titles", () => {
    const onRetry = vi.fn();
    const onRetryMessageMatches = vi.fn();
    const props = (overrides: Partial<Parameters<typeof NavigationSidebar>[0]>) => sidebarProps({
      chats: [chats[1]!], messageMatches: [], onRetry, onRetryMessageMatches, searchQuery: "budget", ...overrides
    });
    const inMessages = () => within(screen.getByRole("group", { name: "In messages" }));
    const { view } = sidebar(props({ messageMatchesLoading: true }));
    // Title results never wait for the message query.
    expect(screen.getByRole("treeitem", { name: "Selected brief" })).toBeVisible();
    expect(inMessages().getByText("Searching messages…")).toBeVisible();

    view.rerender(<NavigationSidebar {...props({ messageMatchesReady: true })} />);
    expect(inMessages().getByText("No messages match.")).toBeVisible();
    expect(screen.queryByText("Nothing found")).toBeNull();

    view.rerender(<NavigationSidebar {...props({ messageMatchesError: "chat_navigation_search_timeout" })} />);
    expect(inMessages().getByText("Search in messages took too long. Try a more specific phrase.")).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "Selected brief" })).toBeVisible();
    fireEvent.click(inMessages().getByRole("button", { name: "Retry" }));
    expect(onRetryMessageMatches).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();

    view.rerender(<NavigationSidebar {...props({ messageMatchesError: "chat_navigation_failed" })} />);
    expect(inMessages().getByText("Could not search messages.")).toBeVisible();

    // Messages first: the title search still runs or failed on its own.
    view.rerender(<NavigationSidebar {...props({ chats: [], messageMatches: [messageMatch], searchLoading: true })} />);
    expect(screen.getByText("Searching chats…")).toBeVisible();
    expect(inMessages().getByRole("treeitem", { name: "Planning" })).toBeVisible();
    view.rerender(<NavigationSidebar {...props({
      chats: [], messageMatches: [messageMatch], searchError: "chat_navigation_failed"
    })} />);
    expect(screen.getByText("Search is unavailable.")).toBeVisible();
    expect(inMessages().getByRole("treeitem", { name: "Planning" })).toBeVisible();

    // Only both lists settled empty read as nothing found.
    view.rerender(<NavigationSidebar {...props({ chats: [], messageMatchesReady: true })} />);
    expect(screen.getByText("Nothing found")).toBeVisible();
    expect(screen.queryByRole("group", { name: "In messages" })).toBeNull();
    view.rerender(<NavigationSidebar {...props({ chats: [], messageMatchesLoading: true })} />);
    expect(screen.queryByText("Nothing found")).toBeNull();
    expect(inMessages().getByText("Searching messages…")).toBeVisible();
  });

  it("continues message matches at the end of the list and title results in their section", () => {
    const onLoadMore = vi.fn();
    const onLoadMoreMessageMatches = vi.fn();
    const { view } = sidebar({
      chats: [chats[1]!],
      hasMore: true,
      messageMatches: [messageMatch],
      messageMatchesHasMore: true,
      onLoadMore,
      onLoadMoreMessageMatches,
      searchQuery: "budget"
    });

    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(onLoadMoreMessageMatches).toHaveBeenCalledOnce();
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: "Results" }))
      .getByRole("treeitem", { name: "Show more chats" }));
    expect(onLoadMore).toHaveBeenCalledOnce();

    view.rerender(<NavigationSidebar {...sidebarProps({
      chats: [chats[1]!],
      messageMatches: [messageMatch],
      messageMatchesError: "chat_navigation_failed",
      messageMatchesHasMore: true,
      onLoadMoreMessageMatches,
      searchQuery: "budget"
    })} />);
    expect(screen.getByText("Could not load earlier chats.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onLoadMoreMessageMatches).toHaveBeenCalledTimes(2);
  });

  it("moves between title results and message matches with the arrow keys", () => {
    sidebar({ chats: [chats[1]!], messageMatches: [messageMatch], searchQuery: "budget" });
    const titleRow = screen.getByRole("treeitem", { name: "Selected brief" });
    act(() => titleRow.focus());
    fireEvent.keyDown(titleRow, { key: "ArrowDown" });
    const matchRow = screen.getByRole("treeitem", { name: "Planning" });
    expect(matchRow).toHaveFocus();
    fireEvent.keyDown(matchRow, { key: "ArrowUp" });
    expect(titleRow).toHaveFocus();
  });

  it("opens a message match from the mobile drawer and closes the drawer", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true } as MediaQueryList)));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const store = useWorkspaceStore.getState();
    store.applyNavigationPage({ chats, folders: [], nextCursor: null }, false);
    store.setNavigationSearchQuery("budget");
    useWorkspaceStore.getState().applyNavigationMessageMatchPage({ matches: [messageMatch], nextCursor: null }, false);
    const onOpenMessageMatch = vi.fn();
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onOpenMessageMatch={onOpenMessageMatch} onSelectChat={vi.fn()}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(shell).toHaveAttribute("data-mobile-sidebar", "true");

    fireEvent.click(within(screen.getByRole("group", { name: "In messages" }))
      .getByRole("treeitem", { name: "Planning" }));
    expect(onOpenMessageMatch).toHaveBeenCalledWith(messageMatch);
    expect(shell).not.toHaveAttribute("data-mobile-sidebar");
    expect(useWorkspaceStore.getState().navigationSearchQuery).toBe("");
  });

  it("keeps the rail with its destinations beside the list and hides it on mobile", () => {
    const onLibrary = vi.fn();
    const onSettings = vi.fn();
    const { rerender } = render(
      <ReadingRoomShellV2
        accountLabel="operator@aiqsa.local"
        adminEntryVisible
        onLibrary={onLibrary}
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        onSettings={onSettings}
        sidebar={(close) => <NavigationSidebar {...sidebarProps({ onClose: close })} />}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(rail).getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(rail).getByRole("button", { name: "Studio" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(onLibrary).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    expect(within(rail).queryByRole("button", { name: "Archived chats" })).toBeNull();
    expect(within(rail).getByRole("link", { name: "Control Center" })).toHaveAttribute("href", "/admin");
    fireEvent.click(within(rail).getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu", { name: "Account" })).toHaveTextContent("Sign out");
    // The sidebar itself no longer carries the footer destinations on desktop.
    const navigation = screen.getByRole("complementary", { name: "Chat navigation" });
    expect(within(navigation).queryByRole("button", { name: "Studio" })).toBeNull();
    expect(within(navigation).getByText("Chats")).toBeVisible();

    // Collapsing hides only the list: the rail and the reopen control stay.
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();

    rerender(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        section="library"
        sidebar={(close) => <NavigationSidebar {...sidebarProps({ onClose: close })} />}
      >
        <main>Library</main>
      </ReadingRoomShellV2>
    );
    expect(screen.getByRole("main").closest(".v2-workspace-shell"))
      .toHaveAttribute("data-shell-section", "library");
    expect(within(screen.getByRole("navigation", { name: "Workspace" }))
      .getByRole("button", { name: "Chats" })).not.toHaveAttribute("aria-current");
  });

  it.each([1440, 390])("gives the account menu its own Settings beside the Settings destination at width %s", (width) => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    const onSettings = vi.fn();
    const onAccountSettings = vi.fn();
    render(
      <ReadingRoomShellV2
        accountLabel="operator@aiqsa.local"
        onAccountSettings={onAccountSettings}
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        onSettings={onSettings}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const owner = () => width > 390
      ? screen.getByRole("navigation", { name: "Workspace" })
      : screen.getByRole("complementary", { name: "Chat navigation" });
    if (width <= 390) fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(within(owner()).getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onAccountSettings).toHaveBeenCalledOnce();
    expect(onSettings).not.toHaveBeenCalled();

    if (width <= 390) fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(within(owner()).getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onAccountSettings).toHaveBeenCalledOnce();
  });

  it("moves the rail destinations into the drawer footer on mobile", () => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 390));
    render(
      <ReadingRoomShellV2
        accountLabel="operator@aiqsa.local"
        onLibrary={vi.fn()}
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        onSettings={vi.fn()}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const navigation = screen.getByRole("complementary", { name: "Chat navigation" });
    // Settings is a footer destination too (one tap, UX audit 2026-09-02 B8);
    // Control Center stays in the account menu, as on the rail.
    for (const name of ["Projects", "Studio", "Settings", "Account menu"]) {
      expect(within(navigation).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(navigation).queryByRole("button", { name: "Archived chats" })).toBeNull();
    fireEvent.click(within(navigation).getByRole("button", { name: "Account menu" }));
    expect(within(navigation).getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(within(navigation).getByTestId("account-menu-identity")).toHaveTextContent("operator@aiqsa.local");
    expect(within(navigation).getByText("AIQSA")).toBeInTheDocument();
  });

  it.each([900, 1440])("starts a personal chat from the Library or Projects rail at width %s", (width) => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    useWorkspaceStore.getState().applyNavigationPage({ chats: [], folders: [], nextCursor: null }, false);
    const onChats = vi.fn();
    const onNewChat = vi.fn();
    const onLeaveProject = vi.fn();
    const onProjectsSectionChange = vi.fn();
    const shell = (section: "chats" | "library") => (
      <ReadingRoomShellV2
        onChats={onChats}
        onLeaveProject={onLeaveProject}
        onNewChat={onNewChat}
        onProjectsSectionChange={onProjectsSectionChange}
        onSelectChat={vi.fn()}
        projectsSectionOpen={section === "chats"}
        projectsSlot={<div>Project catalog</div>}
        section={section}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const view = render(shell("library"));
    const activateBrand = () => fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" }))
      .getByRole("button", { name: "New chat" }));

    activateBrand();
    expect(onChats).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith("NORMAL");
    expect(onLeaveProject).toHaveBeenCalledOnce();
    expect(onProjectsSectionChange).toHaveBeenLastCalledWith(false);

    view.rerender(shell("chats"));
    activateBrand();
    expect(onNewChat).toHaveBeenCalledTimes(2);
    expect(onNewChat).toHaveBeenLastCalledWith("NORMAL");
    expect(onLeaveProject).toHaveBeenCalledTimes(2);
    expect(onProjectsSectionChange).toHaveBeenLastCalledWith(false);
  });

  it.each([390, 900, 1440])("focuses the composer after New chat and drawer dismissal at width %s", async (width) => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    useWorkspaceStore.getState().applyNavigationPage({ chats: [], folders: [], nextCursor: null }, false);
    const onNewChat = vi.fn();
    render(<ReadingRoomShellV2 onNewChat={onNewChat} onSelectChat={vi.fn()}>
      <div data-testid="composer-v2"><textarea aria-label="Message" /></div>
    </ReadingRoomShellV2>);
    if (width < 1024) fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Chat navigation" }))
      .getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledExactlyOnceWith("NORMAL");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
  });

  it("leaves a Project for Library but opens Projects as its own shell section", () => {
    const onLeaveProject = vi.fn();
    const onLibrary = vi.fn();
    const onProjectsSectionChange = vi.fn();
    render(
      <ReadingRoomShellV2
        onLeaveProject={onLeaveProject}
        onLibrary={onLibrary}
        onNewChat={vi.fn()}
        onProjectsSectionChange={onProjectsSectionChange}
        onSelectChat={vi.fn()}
        projectsSlot={(
          <div className="v2-project-navigation">
            <button type="button">Create project</button>
          </div>
        )}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    fireEvent.click(within(rail).getByRole("button", { name: "Studio" }));
    expect(onLeaveProject).toHaveBeenCalledTimes(1);
    expect(onLibrary).toHaveBeenCalledTimes(1);
    expect(onLeaveProject.mock.invocationCallOrder[0]).toBeLessThan(onLibrary.mock.invocationCallOrder[0]!);

    fireEvent.click(within(rail).getByRole("button", { name: "Projects" }));
    expect(onLeaveProject).toHaveBeenCalledTimes(1);
    expect(onProjectsSectionChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("complementary", { name: "Project navigation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create project" })).toBeVisible();
    expect(within(screen.getByRole("complementary", { name: "Project navigation" }))
      .queryByRole("button", { name: "New chat" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  });

  it("accepts a controlled Projects destination when the reading surface returns to chat", () => {
    const shell = (open: boolean) => (
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        projectsSectionOpen={open}
        projectsSlot={<div>Project catalog</div>}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const view = render(shell(true));

    expect(screen.getByText("Project catalog")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Project navigation" })).toBeVisible();
    expect(within(screen.getByRole("complementary", { name: "Project navigation" }))
      .queryByRole("button", { name: "New chat" })).toBeNull();

    view.rerender(shell(false));
    expect(screen.queryByText("Project catalog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "New chat" })).not.toHaveLength(0);
  });

  it("restores focus to the opener after collapse", () => {
    const onClose = vi.fn();
    const customSidebar = (close: () => void) => (
      <NavigationSidebar {...sidebarProps({ onClose: close })} />
    );
    render(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        sidebar={customSidebar}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(screen.getByRole("main")).toHaveTextContent("Conversation");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps shared-project navigation visible after a desktop destination is selected", () => {
    const onProjectsSectionChange = vi.fn();
    render(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onProjectsSectionChange={onProjectsSectionChange}
        onSelectChat={vi.fn()}
        projectContextActive
        projectsSlot={(onNavigate) => (
          <button type="button" onClick={onNavigate}>Project destination</button>
        )}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    fireEvent.click(screen.getByRole("button", { name: "Project destination" }));
    expect(shell).not.toHaveAttribute("data-sidebar-collapsed");
    expect(screen.getByRole("complementary", { name: "Project navigation" })).toBeVisible();
    expect(onProjectsSectionChange).toHaveBeenLastCalledWith(false);
  });

  it("moves focus into the mobile drawer and keeps its edge Tab cycle contained", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true
    } as MediaQueryList)));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ drawerDestinations: true, onClose: close })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const close = screen.getByRole("button", { name: "Close sidebar" });
    const skip = screen.getByRole("button", { name: "Skip to message composer" });
    expect(close).toHaveFocus();
    skip.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    // The drawer footer's account entry is the last control of the cycle.
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(skip).toHaveFocus();
    fireEvent.click(close);
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();
  });

  it("dismisses the mobile drawer after every personal new-chat mode", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true
    } as MediaQueryList)));
    useWorkspaceStore.getState().applyNavigationPage({ chats, folders: [], nextCursor: null }, false);
    const onNewChat = vi.fn();
    render(
      <ReadingRoomShellV2 onNewChat={onNewChat} onSelectChat={vi.fn()}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    const openDrawer = () => {
      fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
      expect(shell).toHaveAttribute("data-mobile-sidebar", "true");
      return within(screen.getByRole("complementary", { name: "Chat navigation" }));
    };

    fireEvent.click(openDrawer().getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenLastCalledWith("NORMAL");
    expect(shell).not.toHaveAttribute("data-mobile-sidebar");

    let drawer = openDrawer();
    fireEvent.click(drawer.getByRole("button", { name: "New chat mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Memory off/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("EXCLUDED");
    expect(shell).not.toHaveAttribute("data-mobile-sidebar");

    drawer = openDrawer();
    fireEvent.click(drawer.getByRole("button", { name: "New chat mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Temporary chat/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("TEMPORARY");
    expect(shell).not.toHaveAttribute("data-mobile-sidebar");
  });

  it("keeps the mobile drawer open when Escape only cancels an inline rename", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true
    } as MediaQueryList)));
    const onCancelChatRename = vi.fn();
    const onCancelFolderRename = vi.fn();
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({
          editingChatId: "yesterday",
          editingChatTitle: "Changed chat",
          editingFolderId: "folder-research",
          editingFolderName: "Changed folder",
          folders: [{ id: "folder-research", name: "Research", parentId: null }],
          onCancelChatRename,
          onCancelFolderRename,
          onClose: close
        })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New title: Selected brief" }), {
      key: "Escape"
    });
    expect(onCancelChatRename).toHaveBeenCalledOnce();
    expect(shell).toHaveAttribute("data-mobile-sidebar", "true");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "New folder name: Research" }), {
      key: "Escape"
    });
    expect(onCancelFolderRename).toHaveBeenCalledOnce();
    expect(shell).toHaveAttribute("data-mobile-sidebar", "true");
  });

  it("defaults 768–1023px to compact and preserves one sidebar owner when expanded", () => {
    let width = 768;
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ onClose: close })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    expect(shell).toHaveAttribute("data-sidebar-composition", "compact");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    const opener = screen.getByRole("button", { name: "Open sidebar" });
    fireEvent.click(opener);
    expect(shell).toHaveAttribute("data-sidebar-compact-expanded", "true");
    expect(screen.getByRole("button", { name: "Close sidebar" })).toHaveFocus();
  });

  it("moves focus to the mobile opener below 768px and restores the exact desktop source", () => {
    let width = 1281;
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ onClose: close })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const source = screen.getByRole("treeitem", { name: "Selected brief" });
    const opener = screen.getByRole("button", { name: "Open sidebar" });
    source.focus();

    width = 767;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByRole("main").closest(".v2-workspace-shell"))
      .toHaveAttribute("data-sidebar-composition", "mobile");
    expect(opener).toHaveFocus();

    width = 1281;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(source).toHaveFocus();
  });

  it("settles compact drawers after a destination or scrim is selected", () => {
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 820));
    const onLibrary = vi.fn();
    const onSettings = vi.fn();
    render(
      <ReadingRoomShellV2
        onLibrary={onLibrary}
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        onSettings={onSettings}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    const shell = screen.getByRole("main").closest(".v2-workspace-shell");
    const openDrawer = () => {
      fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
      expect(shell).toHaveAttribute("data-sidebar-compact-expanded", "true");
      expect(screen.getByRole("main").closest(".v2-workspace-content")).toHaveAttribute("inert");
    };

    openDrawer();
    const scrim = document.querySelector<HTMLButtonElement>(".v2-navigation-scrim");
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute("tabindex", "-1");
    fireEvent.click(scrim!);
    expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded");
    expect(screen.getByRole("main").closest(".v2-workspace-content")).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();

    openDrawer();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded");
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();

    openDrawer();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" }))
      .getByRole("button", { name: "Studio" }));
    expect(onLibrary).toHaveBeenCalledOnce();
    expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded");

    openDrawer();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" }))
      .getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded");
  });

  it("keeps column-control tooltips on their inward side", () => {
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    expect(screen.getByRole("button", { name: "Close sidebar" }))
      .toHaveAttribute("data-tooltip-side", "left");
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(screen.getByRole("button", { name: "Open sidebar" }))
      .toHaveAttribute("data-tooltip-side", "right");
  });

  it("does not steal conversation focus when compact navigation returns to desktop", () => {
    let width = 1281;
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ onClose: close })} />
      )}>
        <button type="button">Conversation control</button>
      </ReadingRoomShellV2>
    );
    const source = screen.getByRole("treeitem", { name: "Selected brief" });
    const conversation = screen.getByRole("button", { name: "Conversation control" });
    source.focus();

    width = 844;
    act(() => window.dispatchEvent(new Event("resize")));
    conversation.focus();
    width = 1281;
    act(() => window.dispatchEvent(new Event("resize")));

    expect(conversation).toHaveFocus();
  });

  it("keeps navigation focus when an open compact drawer expands to desktop", () => {
    let width = 820;
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ onClose: close })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const close = screen.getByRole("button", { name: "Close sidebar" });
    expect(close).toHaveFocus();
    width = 1281;
    act(() => window.dispatchEvent(new Event("resize")));

    expect(screen.getByRole("main").closest(".v2-workspace-shell"))
      .toHaveAttribute("data-sidebar-composition", "desktop");
    expect(close).toHaveFocus();
    expect(screen.getByRole("button", { name: "Open sidebar" })).not.toHaveFocus();
  });

  it("does not install a Ctrl/Cmd+K navigation surface", () => {
    render(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        sidebar={<aside aria-label="Test navigation" />}
      >
        <button type="button">Conversation control</button>
      </ReadingRoomShellV2>
    );
    const opener = screen.getByRole("button", { name: "Conversation control" });
    opener.focus();

    fireEvent.keyDown(opener, { ctrlKey: true, key: "k" });
    fireEvent.keyDown(opener, { key: "k", metaKey: true });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search chats" })).toBeNull();
  });

  it("cancels delayed chat-filter focus when navigation unmounts", () => {
    vi.useFakeTimers();
    const view = render(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
        sidebar={<input aria-label="Filter chats" type="search" />}
      >
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );

    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toHaveFocus();

    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    view.unmount();
    render(<>
      <button type="button">Next conversation</button>
      <input aria-label="Filter chats" type="search" />
    </>);
    const nextConversation = screen.getByRole("button", { name: "Next conversation" });
    nextConversation.focus();
    act(() => vi.runAllTimers());

    expect(nextConversation).toHaveFocus();
  });

  it("dismisses the chat-row menu on Escape, outside press, and focus-out", () => {
    sidebar();
    const trigger = screen.getByRole("button", { name: "Actions: Selected brief" });
    const outsideTarget = screen.getByRole("button", { name: "New chat" });

    fireEvent.click(trigger);
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "Rename" }),
      { key: "Escape" }
    );
    expect(screen.queryByRole("menu", { name: "Chat actions: Selected brief" })).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Chat actions: Selected brief" })).toBeVisible();
    fireEvent.pointerDown(outsideTarget);
    expect(screen.queryByRole("menu", { name: "Chat actions: Selected brief" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.focusIn(outsideTarget);
    expect(screen.queryByRole("menu", { name: "Chat actions: Selected brief" })).toBeNull();
  });

  it("dismisses the new-chat mode menu on Escape with focus returned to its trigger", () => {
    const onNewChat = vi.fn();
    sidebar({ onNewChat });
    const trigger = screen.getByRole("button", { name: "New chat mode" });

    fireEvent.click(trigger);
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /Temporary chat/ }),
      { key: "Escape" }
    );

    expect(screen.queryByRole("menu", { name: "New chat mode" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("shows the earlier-page control as busy, then as a manual Retry after a failed page", () => {
    const { props, view } = sidebar({ hasMore: true, loading: true });
    const busy = screen.getByRole("button", { name: "Loading…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    view.rerender(<NavigationSidebar {...props} error="chat_navigation_failed" loading={false} />);
    expect(screen.getByText("Could not load earlier chats.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(<NavigationSidebar {...props} error={null} loading={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(props.onLoadMore).toHaveBeenCalledTimes(2);
  });

  describe("first-page liveness", () => {
    // Unmount before the shared store reset so a mounted container cannot
    // start a real request against the reset store.
    afterEach(() => cleanup());
    const listRequests = (fetchMock: { mock: { calls: unknown[][] } }) =>
      fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/chats/compact")).length;
    const flush = async (ms = 0) => {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    };
    const page = () => Response.json({ chats, folders: [], nextCursor: null });
    const renderContainer = () => render(
      <NavigationSidebarContainer onClose={vi.fn()} onNewChat={vi.fn()} onSelectChat={vi.fn()} now={now} />
    );

    it("keeps a steady error through a bounded retry sequence after HTTP 500, then reloads on an explicit retry", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 1440));
      const fetchMock = vi.fn(async () => Response.json({ error: "chat_navigation_failed" }, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      renderContainer();
      await flush();
      expect(listRequests(fetchMock)).toBe(1);
      expect(screen.getByText("Could not load chats")).toBeVisible();

      await flush(60_000);
      // One automatic retry per backoff step, never a back-to-back loop.
      expect(listRequests(fetchMock)).toBe(5);
      await flush(10 * 60_000);
      expect(listRequests(fetchMock)).toBe(5);
      // The error state never flashes back to the skeleton between attempts.
      expect(screen.queryByLabelText("Loading chats")).toBeNull();
      expect(screen.getByText("Could not load chats")).toBeVisible();

      fetchMock.mockImplementation(async () => page());
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(listRequests(fetchMock)).toBe(6);
      expect(screen.getByRole("treeitem", { name: "Selected brief" })).toBeVisible();
      await flush(10 * 60_000);
      expect(listRequests(fetchMock)).toBe(6);
    });

    it("keeps the retry control busy but labelled while an automatic retry is in flight", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 1440));
      let finish: ((response: Response) => void) | undefined;
      const fetchMock = vi.fn(async () => Response.json({ error: "chat_navigation_failed" }, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      renderContainer();
      await flush();
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
      await flush(2_000);
      expect(listRequests(fetchMock)).toBe(2);
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toHaveAttribute("aria-busy", "true");
      fireEvent.click(retry);
      await flush();
      // A duplicate retry is rejected while the automatic one is in flight.
      expect(listRequests(fetchMock)).toBe(2);
      finish?.(page());
      await flush();
      expect(screen.getByRole("treeitem", { name: "Selected brief" })).toBeVisible();
    });

    it("waits offline without timers and reloads when the connection returns or the window regains focus", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("matchMedia", responsiveMatchMedia(() => 1440));
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      const fetchMock = vi.fn(async (): Promise<Response> => { throw new TypeError("Failed to fetch"); });
      vi.stubGlobal("fetch", fetchMock);
      renderContainer();
      await flush();
      expect(listRequests(fetchMock)).toBe(1);
      await flush(10 * 60_000);
      expect(listRequests(fetchMock)).toBe(1);
      expect(screen.getByText("Could not load chats")).toBeVisible();

      // Focus is an explicit retry event even while the browser reports offline.
      act(() => { window.dispatchEvent(new Event("focus")); });
      await flush();
      expect(listRequests(fetchMock)).toBe(2);
      expect(screen.getByText("Could not load chats")).toBeVisible();

      online.mockReturnValue(true);
      fetchMock.mockImplementation(async () => page());
      act(() => { window.dispatchEvent(new Event("online")); });
      await flush();
      expect(listRequests(fetchMock)).toBe(3);
      expect(screen.getByRole("treeitem", { name: "Selected brief" })).toBeVisible();
      act(() => { window.dispatchEvent(new Event("focus")); });
      await flush(10 * 60_000);
      expect(listRequests(fetchMock)).toBe(3);
    });
  });

  it("reconciles local run start and settlement with the server summary cue", () => {
    useWorkspaceStore.getState().applyNavigationPage({
      chats: [{ ...chats[1], activeRun: false }],
      folders: [],
      nextCursor: null
    }, false);
    render(
      <NavigationSidebarContainer
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("Answer in progress")).toBeNull();

    act(() => useRunLifecycleStore.getState().streamStarted({ chatId: "yesterday" }));
    expect(screen.getByLabelText("Answer in progress")).toBeVisible();
    act(() => useRunLifecycleStore.getState().streamFinished({ chatId: "yesterday" }));
    expect(screen.queryByLabelText("Answer in progress")).toBeNull();
  });
});

function sidebarProps(
  overrides: Partial<Parameters<typeof NavigationSidebar>[0]> = {}
): Parameters<typeof NavigationSidebar>[0] {
  return {
    activeChatId: "yesterday",
    chats,
    error: null,
    folders: [],
    hasMore: false,
    loading: false,
    now,
    onClose: vi.fn(),
    onLoadMore: vi.fn(),
    onNewChat: vi.fn(),
    onRetry: vi.fn(),
    onSearch: vi.fn(),
    onSelectChat: vi.fn(),
    ready: true,
    searchError: null,
    searchLoading: false,
    searchQuery: "",
    ...overrides
  };
}

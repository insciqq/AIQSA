import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  resetRunLifecycleStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
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
    folderId: null,
    id: "today",
    title: "Running answer",
    updatedAt: "2026-08-13T08:00:00.000Z"
  },
  {
    activeRun: false,
    folderId: null,
    id: "yesterday",
    title: "Selected brief",
    updatedAt: "2026-08-12T08:00:00.000Z"
  }
];

function responsiveMatchMedia(getWidth: () => number) {
  return vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: query.includes("899px")
      ? getWidth() <= 899
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

  it("renders stable date groups, selected state, and an active-run cue", () => {
    sidebar();

    expect(screen.getByText("Today")).toBeVisible();
    expect(screen.getByText("Yesterday")).toBeVisible();
    expect(screen.getByRole("button", { name: "Selected brief" })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByLabelText("Answer in progress")).toBeVisible();
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
      onArchivedChats: vi.fn(),
      projectContextActive: true,
      projectsSlot: <div>Project chat tree</div>
    });

    expect(screen.getByText("Project chat tree")).toBeVisible();
    expect(screen.queryByText("Start your first chat")).toBeNull();
    expect(screen.getByRole("button", { name: "Archived chats" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "New chat mode" })).toBeNull();
    expect(screen.queryByText(/Memory off|Normal memory|Exclude from Memory|Resume Memory/)).toBeNull();
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
      expect(screen.getByRole("searchbox", { name: "Filter chats" })).toHaveValue("");
    } finally {
      vi.useRealTimers();
    }
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
    fireEvent.click(screen.getByRole("menuitem", { name: "New subfolder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Subfolder name in Research" }), {
      target: { value: "Nested draft" }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(onCreateFolder).not.toHaveBeenCalled();
  });

  it("fences archive during a run and names the current Memory action", () => {
    const onArchive = vi.fn();
    const onMemoryMode = vi.fn();
    sidebar({
      chatStateFor: (chat) => chat.id === "today"
        ? { favorite: true, memoryMode: "NORMAL" }
        : { favorite: false, memoryMode: "EXCLUDED" },
      onArchive,
      onMemoryMode
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions: Running answer" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Memory off" })).toBeNull();
    const memoryOn = screen.getByRole("menuitem", { name: "Exclude from Memory" });
    expect(screen.getByRole("menuitem", { name: "Favorite" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    fireEvent.click(memoryOn);
    expect(onMemoryMode).toHaveBeenCalledWith(chats[0], "EXCLUDED");

    fireEvent.click(screen.getByRole("button", { name: "Actions: Selected brief" }));
    const memoryOff = screen.getByRole("menuitem", { name: "Resume Memory for this chat" });
    expect(screen.getByRole("menuitem", { name: "Favorite" })).not.toHaveAttribute(
      "aria-current"
    );
    fireEvent.click(memoryOff);
    expect(onMemoryMode).toHaveBeenCalledWith(chats[1], "NORMAL");
    expect(onArchive).not.toHaveBeenCalled();
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
    const options = screen.getByLabelText("Choose a folder");
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
    fireEvent.click(screen.getByRole("button", { name: "Selected brief" }));
    expect(onSearch).toHaveBeenCalledWith("");
    expect(onSelectChat).toHaveBeenCalledWith(chats[1]);
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
    render(
      <ReadingRoomShellV2
        onNewChat={vi.fn()}
        onSelectChat={vi.fn()}
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
    expect(screen.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
  });

  it("moves focus into the mobile drawer and keeps its edge Tab cycle contained", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true
    } as MediaQueryList)));
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
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
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
    fireEvent.click(drawer.getByRole("menuitem", { name: /Memory off/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("EXCLUDED");
    expect(shell).not.toHaveAttribute("data-mobile-sidebar");

    drawer = openDrawer();
    fireEvent.click(drawer.getByRole("button", { name: "New chat mode" }));
    fireEvent.click(drawer.getByRole("menuitem", { name: /Temporary chat/ }));
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

  it("defaults 900–1023px to compact and preserves one sidebar owner when expanded", () => {
    let width = 1023;
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

  it("moves focus to the compact opener across <900 and restores the exact desktop source", () => {
    let width = 1281;
    vi.stubGlobal("matchMedia", responsiveMatchMedia(() => width));
    render(
      <ReadingRoomShellV2 onNewChat={vi.fn()} onSelectChat={vi.fn()} sidebar={(close) => (
        <NavigationSidebar {...sidebarProps({ onClose: close })} />
      )}>
        <main>Conversation</main>
      </ReadingRoomShellV2>
    );
    const source = screen.getByRole("button", { name: "Selected brief" });
    const opener = screen.getByRole("button", { name: "Open sidebar" });
    source.focus();

    width = 844;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByRole("main").closest(".v2-workspace-shell"))
      .toHaveAttribute("data-sidebar-composition", "mobile");
    expect(opener).toHaveFocus();

    width = 1281;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(source).toHaveFocus();
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
    const source = screen.getByRole("button", { name: "Selected brief" });
    const conversation = screen.getByRole("button", { name: "Conversation control" });
    source.focus();

    width = 844;
    act(() => window.dispatchEvent(new Event("resize")));
    conversation.focus();
    width = 1281;
    act(() => window.dispatchEvent(new Event("resize")));

    expect(conversation).toHaveFocus();
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

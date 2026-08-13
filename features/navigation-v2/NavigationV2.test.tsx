import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetRunLifecycleStoreForTest,
  useRunLifecycleStore
} from "@/components/app-shell/runLifecycleStore";
import {
  resetWorkspaceStoreForTest,
  useWorkspaceStore
} from "@/components/app-shell/workspaceStore";
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

    expect(screen.getByText("Сегодня")).toBeVisible();
    expect(screen.getByText("Вчера")).toBeVisible();
    expect(screen.getByRole("button", { name: "Selected brief" })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByLabelText("Ответ выполняется")).toBeVisible();
  });

  it("keeps loading, error, empty, and search-empty states explicit", () => {
    const { view } = sidebar({ chats: [], loading: true, ready: false });
    expect(screen.getByLabelText("Загрузка чатов")).toBeVisible();

    view.rerender(<NavigationSidebar {...{
      ...sidebarProps({ chats: [], error: "failed", ready: false })
    }} />);
    expect(screen.getByText("Не удалось загрузить чаты")).toBeVisible();

    view.rerender(<NavigationSidebar {...sidebarProps({ chats: [] })} />);
    expect(screen.getByText("Начните первый чат")).toBeVisible();

    view.rerender(<NavigationSidebar {...sidebarProps({ chats: [], searchQuery: "missing" })} />);
    expect(screen.getByText("Ничего не найдено")).toBeVisible();
  });

  it("routes Normal, Memory-off, and Temporary new-chat intents and marks the current mode", () => {
    const onNewChat = vi.fn();
    sidebar({ currentNewChatMode: "EXCLUDED", onNewChat });

    fireEvent.click(screen.getByRole("button", { name: "Новый чат" }));
    expect(onNewChat).toHaveBeenLastCalledWith("NORMAL");
    fireEvent.click(screen.getByRole("button", { name: "Режим нового чата" }));
    expect(screen.getByRole("menuitem", { name: /Без памяти/ })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(screen.getByRole("menuitem", { name: /Обычный/ })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("menuitem", { name: /Без памяти/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("EXCLUDED");
    fireEvent.click(screen.getByRole("button", { name: "Режим нового чата" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Временный чат/ }));
    expect(onNewChat).toHaveBeenLastCalledWith("TEMPORARY");
  });

  it("creates a root folder from the New-chat menu instead of a permanent row", () => {
    const onCreateFolder = vi.fn(async () => undefined);
    sidebar({ onCreateFolder });

    expect(screen.queryByRole("button", { name: "Новая папка" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Режим нового чата" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Новая папка" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название новой папки" }), {
      target: { value: "Исследования" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать папку" }));
    expect(onCreateFolder).toHaveBeenCalledWith(null, "Исследования");
  });

  it("fences archive during a run and keeps one stateful Memory toggle", () => {
    const onArchive = vi.fn();
    const onMemoryMode = vi.fn();
    sidebar({
      chatStateFor: (chat) => chat.id === "today"
        ? { favorite: true, memoryMode: "NORMAL" }
        : { favorite: false, memoryMode: "EXCLUDED" },
      onArchive,
      onMemoryMode
    });

    fireEvent.click(screen.getByRole("button", { name: "Действия: Running answer" }));
    expect(screen.getByRole("menuitem", { name: "Архивировать" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Без памяти" })).toBeNull();
    // One toggle item shows the current state and flips it.
    const memoryOn = screen.getByRole("menuitem", { name: "Использовать память" });
    expect(memoryOn).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("menuitem", { name: "Избранное" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    fireEvent.click(memoryOn);
    expect(onMemoryMode).toHaveBeenCalledWith(chats[0], "EXCLUDED");

    fireEvent.click(screen.getByRole("button", { name: "Действия: Selected brief" }));
    const memoryOff = screen.getByRole("menuitem", { name: "Использовать память" });
    expect(memoryOff).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("menuitem", { name: "Избранное" })).not.toHaveAttribute(
      "aria-current"
    );
    fireEvent.click(memoryOff);
    expect(onMemoryMode).toHaveBeenCalledWith(chats[1], "NORMAL");
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("shows Удалить… only with the capability and routes it to the confirm opener", () => {
    const onDelete = vi.fn();
    const { view } = sidebar();

    fireEvent.click(screen.getByRole("button", { name: "Действия: Selected brief" }));
    expect(screen.queryByRole("menuitem", { name: "Удалить…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Переименовать" }), { key: "Escape" });

    view.rerender(<NavigationSidebar {...sidebarProps({ onDelete })} />);
    fireEvent.click(screen.getByRole("button", { name: "Действия: Selected brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Удалить…" }));
    expect(onDelete).toHaveBeenCalledWith(chats[1]);

    // A running chat cannot be deleted directly either.
    fireEvent.click(screen.getByRole("button", { name: "Действия: Running answer" }));
    expect(screen.getByRole("menuitem", { name: "Удалить…" })).toBeDisabled();
  });

  it("lists every nested folder with indentation inside Переместить", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Действия: Selected brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Переместить" }));
    const options = screen.getByLabelText("Выберите папку");
    const labels = [...options.querySelectorAll("[role='menuitem']")]
      .map((item) => item.textContent);
    expect(labels).toEqual(["Без папки", "Research", "Recall", "Evidence", "Ops"]);
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

  it("opens the shell palette from the quiet «Поиск ⌘K» row without an inline field", () => {
    const onOpenSearch = vi.fn();
    sidebar({ onOpenSearch });

    expect(screen.queryByRole("searchbox")).toBeNull();
    const row = screen.getByRole("button", { name: /Поиск/ });
    expect(row).toHaveTextContent("⌘K");
    fireEvent.click(row);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("resets the search query when a result is selected", () => {
    const onSearch = vi.fn();
    const onSelectChat = vi.fn();
    sidebar({ onSearch, onSelectChat, searchQuery: "brief" });

    expect(screen.getByText("Результаты")).toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: "Закрыть панель" }));
    expect(screen.getByRole("button", { name: "Открыть панель" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Открыть панель" }));
    expect(screen.getByRole("main")).toHaveTextContent("Conversation");
    expect(onClose).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: "Открыть панель" }));
    const close = screen.getByRole("button", { name: "Закрыть панель" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Настройки" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(screen.getByRole("button", { name: "Открыть панель" })).toHaveFocus();
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
    const opener = screen.getByRole("button", { name: "Открыть панель" });
    fireEvent.click(opener);
    expect(shell).toHaveAttribute("data-sidebar-compact-expanded", "true");
    expect(screen.getByRole("button", { name: "Закрыть панель" })).toHaveFocus();
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
    const opener = screen.getByRole("button", { name: "Открыть панель" });
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

  it("leaves Ctrl/Cmd+K to the single shell command-palette owner", () => {
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
    expect(screen.queryByRole("textbox", { name: "Найти чат" })).toBeNull();
  });

  it("dismisses the chat-row menu on Escape, outside press, and focus-out", () => {
    sidebar({ onOpenSearch: vi.fn() });
    const trigger = screen.getByRole("button", { name: "Действия: Selected brief" });
    const searchRow = screen.getByRole("button", { name: /Поиск/ });

    fireEvent.click(trigger);
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "Переименовать" }),
      { key: "Escape" }
    );
    expect(screen.queryByRole("menu", { name: "Действия чата Selected brief" })).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Действия чата Selected brief" })).toBeVisible();
    fireEvent.pointerDown(searchRow);
    expect(screen.queryByRole("menu", { name: "Действия чата Selected brief" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.focusIn(searchRow);
    expect(screen.queryByRole("menu", { name: "Действия чата Selected brief" })).toBeNull();
  });

  it("dismisses the new-chat mode menu on Escape with focus returned to its trigger", () => {
    const onNewChat = vi.fn();
    sidebar({ onNewChat });
    const trigger = screen.getByRole("button", { name: "Режим нового чата" });

    fireEvent.click(trigger);
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: /Временный чат/ }),
      { key: "Escape" }
    );

    expect(screen.queryByRole("menu", { name: "Режим нового чата" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onNewChat).not.toHaveBeenCalled();
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
    expect(screen.queryByLabelText("Ответ выполняется")).toBeNull();

    act(() => useRunLifecycleStore.getState().streamStarted({ chatId: "yesterday" }));
    expect(screen.getByLabelText("Ответ выполняется")).toBeVisible();
    act(() => useRunLifecycleStore.getState().streamFinished({ chatId: "yesterday" }));
    expect(screen.queryByLabelText("Ответ выполняется")).toBeNull();
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

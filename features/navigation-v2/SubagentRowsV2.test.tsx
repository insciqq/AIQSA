import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { resetRunLifecycleStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { subagentChat, subagentThread } from "@/tests/support/subagentViewFixtures";
import { resetSubagentStoreForTest, setOpenSubagentThread, useSubagentStore } from "@/features/subagents-v2/subagentStore";
import { NavigationSidebar, NavigationSidebarContainer, ReadingRoomShellV2 } from "./NavigationV2";
import { SUBAGENT_ROWS_ENDED_VISIBLE, type NavigationSubagentsV2 } from "./SubagentRowsV2";

const now = new Date("2026-10-30T12:00:00.000Z");
const chat = (id: string, overrides: Partial<ChatNavigationSummaryWire> = {}): ChatNavigationSummaryWire => ({
  activeRun: false, assistant: null, folderId: null, id, title: `Chat ${id}`, updatedAt: "2026-10-30T08:00:00.000Z", ...overrides
});

function subagentsProp(chats: NavigationSubagentsV2["chats"], overrides: Partial<NavigationSubagentsV2> = {}): NavigationSubagentsV2 {
  return {
    chats,
    errors: {},
    expanded: (chatId) => (chats[chatId]?.running ?? 0) > 0,
    onRetry: vi.fn(),
    onShowAll: vi.fn(),
    onToggle: vi.fn(),
    openThread: null,
    showAllEnded: {},
    ...overrides
  };
}

function renderSidebar(overrides: Partial<Parameters<typeof NavigationSidebar>[0]> = {}) {
  const props: Parameters<typeof NavigationSidebar>[0] = {
    activeChatId: null,
    chats: [chat("a"), chat("b")],
    error: null,
    folders: [],
    hasMore: false,
    loading: false,
    now,
    onClose: vi.fn(),
    onLoadMore: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSubagent: vi.fn(),
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

afterEach(() => {
  cleanup();
  resetSubagentStoreForTest();
  resetWorkspaceStoreForTest();
  resetRunLifecycleStoreForTest();
  vi.unstubAllGlobals();
});

describe("sub-agents in the chat list", () => {
  it("nests a running chat's sub-agents under it with their state as an icon and screen-reader text", () => {
    const { props } = renderSidebar({ subagents: subagentsProp({ a: subagentChat("a", [
      subagentThread("thread-researcher"),
      subagentThread("thread-browser", "waiting"),
      subagentThread("thread-writer", "done"),
      subagentThread("thread-checker", "failed")
    ]) }) });
    const chatRow = screen.getByRole("treeitem", { name: "Chat a" });
    expect(chatRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "Chat b" })).not.toHaveAttribute("aria-expanded");
    const group = screen.getByRole("group", { name: "Sub-agents of Chat a" });
    const rows = within(group).getAllByRole("treeitem");
    // The exact accessible name, as browsers compute it: "<name>, <state>".
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "researcher, Running", "browser, Waiting for you", "writer, Done", "checker, Failed"
    ]);
    expect(rows[0]).toHaveAccessibleName("researcher, Running");
    expect(rows.map((row) => row.textContent)).toEqual(["researcher", "browser", "writer", "checker"]);
    expect(rows[0]).toHaveAttribute("aria-level", "2");
    expect(rows[2]).toHaveAttribute("data-tone", "ok");
    expect(rows[3]).toHaveAttribute("data-tone", "danger");
    fireEvent.click(rows[1]!);
    expect(props.onOpenSubagent).toHaveBeenCalledWith(props.chats[0], "thread-browser");
    // A sub-agent row is not a chat: it opens no chat and has no row menu.
    expect(props.onSelectChat).not.toHaveBeenCalled();
    expect(within(group).queryByRole("button", { name: /Actions/u })).toBeNull();
  });

  it("collapses an idle chat's sub-agents behind a disclosure that names them", () => {
    const onToggle = vi.fn();
    renderSidebar({ subagents: subagentsProp({ a: subagentChat("a", [subagentThread("thread-done", "done")]) }, { onToggle }) });
    expect(screen.queryByRole("group", { name: "Sub-agents of Chat a" })).toBeNull();
    const disclosure = screen.getByRole("button", { name: "Show sub-agents of Chat a: 1 sub-agent" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("opens and closes a chat's sub-agents with the arrow keys and leaves other keys to the tree", () => {
    const onToggle = vi.fn();
    const subagents = subagentsProp({ a: subagentChat("a", [subagentThread("thread-done", "done")]) }, { onToggle });
    const { props, view } = renderSidebar({ subagents });
    const chatRow = screen.getByRole("treeitem", { name: "Chat a" });
    chatRow.focus();
    fireEvent.keyDown(chatRow, { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Expanded: ArrowRight moves into the rows, ArrowLeft closes them.
    view.rerender(<NavigationSidebar {...props} subagents={{ ...subagents, expanded: () => true }} />);
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Chat a" }), { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "done, Done" }));
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "done, Done" }), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Chat a" }));
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Chat a" }), { key: "ArrowLeft" });
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it("marks the open sub-agent as the current row instead of its chat", () => {
    renderSidebar({
      activeChatId: "a",
      subagents: subagentsProp({ a: subagentChat("a", [subagentThread("thread-alpha"), subagentThread("thread-beta")]) },
        { openThread: { chatId: "a", threadId: "thread-beta" } })
    });
    expect(screen.getByRole("treeitem", { name: "Chat a" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("treeitem", { name: "beta, Running" })).toHaveAttribute("aria-current", "page");
  });

  it("lists every active sub-agent of a crowded chat and the first ended ones, with the rest behind Show more", () => {
    const running = Array.from({ length: 20 }, (_, index) => subagentThread(`thread-r${index}`));
    const ended = Array.from({ length: 12 }, (_, index) => subagentThread(`thread-e${index}`, "done"));
    const onShowAll = vi.fn();
    renderSidebar({ subagents: subagentsProp({ a: subagentChat("a", [...ended, ...running], true) }, { onShowAll }) });
    const group = screen.getByRole("group", { name: "Sub-agents of Chat a" });
    const rows = within(group).getAllByRole("treeitem");
    expect(rows).toHaveLength(20 + SUBAGENT_ROWS_ENDED_VISIBLE + 1);
    expect(rows[0]).toHaveTextContent("r0");
    fireEvent.click(within(group).getByRole("treeitem", { name: `Show ${12 - SUBAGENT_ROWS_ENDED_VISIBLE} more` }));
    expect(onShowAll).toHaveBeenCalledWith("a");
    expect(within(group).getByText("Older sub-agents are not listed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hide sub-agents of Chat a: 32 sub-agents, 20 active/u })).toBeInTheDocument();
  });

  it("keeps a long name on one line with the whole name as its title", () => {
    const name = `a${"b".repeat(46)}c`;
    renderSidebar({ subagents: subagentsProp({ a: subagentChat("a", [subagentThread(`thread-${name}`, "running", { name })]) }) });
    expect(screen.getByRole("treeitem", { name: `${name}, Running` })).toHaveAttribute("title", name);
  });

  it("reports a failed refresh under the rows with Retry", () => {
    const onRetry = vi.fn();
    renderSidebar({ subagents: subagentsProp({ a: subagentChat("a", [subagentThread("thread-alpha")]) }, { errors: { a: true }, onRetry }) });
    fireEvent.click(within(screen.getByRole("group", { name: "Sub-agents of Chat a" })).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("a");
  });

  it("never lists sub-agents among search results", () => {
    renderSidebar({
      searchQuery: "chat",
      subagents: subagentsProp({ a: subagentChat("a", [subagentThread("thread-alpha")]) })
    });
    expect(screen.getByRole("treeitem", { name: "Chat a" })).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("treeitem", { name: /alpha/u })).toBeNull();
  });

  it("keeps a favorite's sub-agents under the favorite, not as favorites of their own", () => {
    renderSidebar({
      chats: [chat("a", { favorite: true }), chat("b")],
      subagents: subagentsProp({ a: subagentChat("a", [subagentThread("thread-alpha")]) })
    });
    const favorites = screen.getByRole("group", { name: "Favorites" });
    expect(within(favorites).getAllByRole("treeitem").map((row) => row.getAttribute("aria-label"))).toEqual(["Chat a", "alpha, Running"]);
    expect(screen.getAllByRole("treeitem", { name: "alpha, Running" })).toHaveLength(1);
  });

  it("reads the store and opens a sub-agent from the phone drawer, which then closes", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      addEventListener: vi.fn(), addListener: vi.fn(), dispatchEvent: vi.fn(), matches: query.includes("767px") || query.includes("1023px"),
      media: query, onchange: null, removeEventListener: vi.fn(), removeListener: vi.fn()
    }) as unknown as MediaQueryList));
    useWorkspaceStore.getState().applyNavigationPage({ chats: [chat("a")], folders: [], nextCursor: null }, false);
    act(() => useSubagentStore.setState({ chats: { a: subagentChat("a", [subagentThread("thread-alpha")]) } }));
    const onOpenSubagent = vi.fn();
    render(<ReadingRoomShellV2 onNewChat={vi.fn()} onOpenSubagent={onOpenSubagent} onSelectChat={vi.fn()}>
      <main>Conversation</main>
    </ReadingRoomShellV2>);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(document.querySelector(".v2-workspace-shell")).toHaveAttribute("data-mobile-sidebar", "true");
    fireEvent.click(screen.getByRole("treeitem", { name: "alpha, Running" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "thread-alpha");
    expect(document.querySelector(".v2-workspace-shell")).not.toHaveAttribute("data-mobile-sidebar");
  });

  it("follows the store's disclosure in the container", () => {
    useWorkspaceStore.getState().applyNavigationPage({ chats: [chat("a")], folders: [], nextCursor: null }, false);
    act(() => useSubagentStore.setState({ chats: { a: subagentChat("a", [subagentThread("thread-alpha", "done")]) } }));
    render(<NavigationSidebarContainer onClose={vi.fn()} onNewChat={vi.fn()} onOpenSubagent={vi.fn()} onSelectChat={vi.fn()} />);
    expect(screen.queryByRole("treeitem", { name: "alpha, Done" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show sub-agents of Chat a/u }));
    expect(screen.getByRole("treeitem", { name: "alpha, Done" })).toBeInTheDocument();
    // Opening an older thread keeps its row listed and current.
    act(() => setOpenSubagentThread({ chatId: "a", threadId: "thread-alpha" }));
    expect(screen.getByRole("treeitem", { name: "alpha, Done" })).toHaveAttribute("aria-selected", "true");
  });
});

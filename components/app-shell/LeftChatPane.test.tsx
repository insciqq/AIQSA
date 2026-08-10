import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeftChatPane } from "./LeftChatPane";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ChatGroup, FolderSummary } from "./types";

const folder: FolderSummary = {
  id: "folder-1",
  name: "Research",
  parentId: null,
  projectMemory: "",
  sortOrder: 0
};

const chatGroups: ChatGroup[] = [
  {
    chats: [
      {
        activeLeafMessageId: null,
        createdAt: "2026-06-10T00:00:00.000Z",
        defaultModelId: "fake-qsa",
        defaultProvider: "fake",
        folderId: null,
        id: "chat-1",
        memoryMode: "NORMAL",
        memorySourceRevision: 0,
        messageCount: 0,
        title: "Planning",
        updatedAt: "2026-06-10T00:00:00.000Z"
      }
    ],
    depth: 0,
    folder: null,
    name: "No folder"
  },
  {
    chats: [],
    depth: 0,
    folder,
    name: "Research"
  }
];

function renderPane(overrides: Partial<ComponentProps<typeof LeftChatPane>> = {}) {
  const props: ComponentProps<typeof LeftChatPane> = {
    activeChatId: "chat-1",
    activeRunChatIds: new Set(),
    availableChatModelKeys: new Set(["fake:fake-qsa"]),
    chatModelLabels: new Map([
      ["fake:fake-qsa", "Fake · Fake QSA"],
      ["openai:other-model", "OpenAI · Other model"]
    ]),
    chatActionId: null,
    chatContentMatchIds: new Set(),
    chatContentSearchError: null,
    chatContentSearchLoading: false,
    chatGroups,
    chatQuery: "",
    collapsedFolderIds: new Set(),
    creatingChat: false,
    creatingFolder: false,
    editingChatId: null,
    editingChatTitle: "",
    editingFolderId: null,
    editingFolderName: "",
    folderActionId: null,
    folderMenuId: null,
    folders: [folder],
    footer: <button aria-label="Account menu">Account</button>,
    newFolderName: "",
    onActivateChat: vi.fn(),
    onCancelChatEdit: vi.fn(),
    onCancelFolderEdit: vi.fn(),
    onCancelSubfolder: vi.fn(),
    onChatActionToggle: vi.fn(),
    onChatQueryChange: vi.fn(),
    onCloseMenus: vi.fn(),
    onCreateChat: vi.fn(),
    onCreateFolder: vi.fn(),
    onDeleteChat: vi.fn(),
    onDeleteFolder: vi.fn(),
    onEditChatTitleChange: vi.fn(),
    onEditFolderNameChange: vi.fn(),
    onExportChat: vi.fn(),
    onFolderMenuToggle: vi.fn(),
    onMoveChat: vi.fn(),
    onMoveFolder: vi.fn(),
    onNewFolderNameChange: vi.fn(),
    onOpenArchivedChats: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onRetryWorkspace: vi.fn(),
    onSaveChatTitle: vi.fn(),
    onSaveFolder: vi.fn(),
    onShareChat: vi.fn(),
    onStartChatEdit: vi.fn(),
    onStartFolderEdit: vi.fn(),
    onStartSubfolder: vi.fn(),
    onSubfolderNameChange: vi.fn(),
    onToggleChatFavorite: vi.fn(),
    onToggleChatMemorySource: vi.fn(),
    onToggleFolderCollapsed: vi.fn(),
    subfolderName: "",
    subfolderParentId: null,
    workspaceError: null,
    workspaceLoading: false,
    workspaceReady: true,
    ...overrides
  };

  useWorkspaceStore.setState({
    chats: props.chatGroups.flatMap((group) => group.chats)
  });

  return { ...props, ...render(<LeftChatPane {...props} />) };
}

describe("LeftChatPane", () => {
  afterEach(() => {
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("closes an open chat menu on Escape or outside pointerdown", () => {
    const onCloseMenus = vi.fn();
    renderPane({ chatActionId: "chat-1", onCloseMenus });

    const trigger = screen.getByRole("button", { name: "Chat actions Planning" });
    expect(screen.getByRole("button", { name: "Rename" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add to favorites" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseMenus).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();

    fireEvent.pointerDown(document.body);
    expect(onCloseMenus).toHaveBeenCalledTimes(2);
  });

  it("clears chat search on Escape without closing a sibling row menu", () => {
    const onChatQueryChange = vi.fn();
    const onCloseMenus = vi.fn();
    renderPane({
      chatActionId: "chat-1",
      chatQuery: "planning",
      onChatQueryChange,
      onCloseMenus
    });

    const search = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onChatQueryChange).toHaveBeenCalledOnce();
    expect(onChatQueryChange).toHaveBeenCalledWith("");
    expect(onCloseMenus).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "Escape", keyCode: 229 });
    expect(onChatQueryChange).toHaveBeenCalledOnce();
    expect(onCloseMenus).not.toHaveBeenCalled();
  });

  it("restores the menu trigger when a completed action closes the menu", async () => {
    const { rerender, ...view } = renderPane({ chatActionId: "chat-1", layout: "mobile" });
    const trigger = screen.getByRole("button", { name: "Chat actions Planning" });
    const favorite = screen.getByRole("button", { name: "Add to favorites" });
    expect(favorite).toHaveFocus();

    rerender(<LeftChatPane {...view} chatActionId={null} layout="mobile" />);

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("restores New Chat when a completed move or delete disconnects the menu trigger", async () => {
    const { rerender, ...view } = renderPane({ chatActionId: "chat-1", layout: "mobile" });
    const newChat = screen.getByRole("button", { name: "Start new chat" });
    expect(screen.getByRole("button", { name: "Add to favorites" })).toHaveFocus();

    rerender(<LeftChatPane {...view} chatActionId={null} chatGroups={[]} layout="mobile" />);

    await waitFor(() => expect(newChat).toHaveFocus());
  });

  it("renders chat rows as title-only entries", () => {
    renderPane();

    expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
    expect(screen.queryByText("Fake / Fake QSA")).not.toBeInTheDocument();
    expect(screen.queryByText(/fake-qsa/)).not.toBeInTheDocument();
  });

  it("renders a quiet semantic Workspace hierarchy instead of a card dashboard", () => {
    renderPane({ chatActionId: "chat-1" });

    const pane = screen.getByTestId("left-chat-pane");
    expect(pane).toHaveClass(
      "h-full",
      "min-w-0",
      "w-full",
      "overflow-hidden",
      "bg-workspace-rail",
      "text-ink",
      "border-trace-subtle"
    );
    expect(pane).toHaveClass("min-[1281px]:flex");
    expect(screen.getByTestId("workspace-identity")).toHaveTextContent("AIQSAWorkspace");
    expect(screen.getByText("History")).toBeVisible();
    expect(screen.getByText("1 chat")).toBeVisible();

    const newChat = screen.getByRole("button", { name: "Start new chat" });
    expect(newChat).toHaveClass("hover:bg-control-hover", "text-ink");
    expect(newChat).not.toHaveClass("bg-proof");
    expect(screen.getByTestId("chat-search-control")).toHaveClass(
      "bg-control-surface",
      "ring-control-boundary",
      "focus-within:ring-focus"
    );
    expect(screen.getByTestId("chat-row")).toHaveClass("bg-control-selected");
    expect(screen.getByTestId("active-chat-marker")).toHaveClass("bg-proof");
    const navigation = screen.getByRole("navigation", { name: "Workspace chats and folders" });
    const footer = screen.getByTestId("workspace-account-footer");
    expect(footer).toHaveClass("shrink-0", "border-t", "border-trace-subtle");
    expect(navigation.nextElementSibling).toBe(footer);
    expect(footer).toContainElement(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("dialog", { name: "Actions for Planning" })).toHaveClass(
      "bg-overlay-surface",
      "border-trace-subtle"
    );
  });

  it("offers a labeled persistent-rail hide action without duplicating it in the drawer", () => {
    const onHideWorkspace = vi.fn();
    const { rerender, ...view } = renderPane({ onHideWorkspace });

    const hideWorkspace = screen.getByRole("button", { name: "Hide workspace" });
    expect(hideWorkspace).toHaveClass(
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    fireEvent.click(hideWorkspace);
    expect(onHideWorkspace).toHaveBeenCalledOnce();

    rerender(<LeftChatPane {...view} layout="mobile" onHideWorkspace={onHideWorkspace} />);
    expect(screen.queryByRole("button", { name: "Hide workspace" })).not.toBeInTheDocument();
  });

  it("keeps chat rows quiet and exposes every action in one menu", () => {
    const onDeleteChat = vi.fn();
    const onMoveChat = vi.fn();
    const onToggleChatFavorite = vi.fn();
    renderPane({ chatActionId: "chat-1", onDeleteChat, onMoveChat, onToggleChatFavorite });

    expect(screen.getByTestId("chat-row-actions").querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Rename" })).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const movePickerTrigger = screen.getByRole("button", {
      name: "Move chat Planning to folder"
    });
    expect(movePickerTrigger).toBeVisible();
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();

    fireEvent.click(movePickerTrigger);
    const movePicker = screen.getByRole("dialog", { name: "Choose move to folder" });
    const noFolderRow = within(movePicker).getByText("No folder", { exact: true }).closest("button");
    const researchRow = within(movePicker).getByText("Research", { exact: true }).closest("button");
    expect(noFolderRow).not.toBeNull();
    expect(researchRow).not.toBeNull();
    expect(noFolderRow).toHaveTextContent("Current");
    expect(noFolderRow).toHaveFocus();
    fireEvent.keyDown(noFolderRow!, { key: "ArrowDown" });
    expect(researchRow).toHaveFocus();
    fireEvent.keyDown(researchRow!, { key: "Enter" });
    expect(onMoveChat).toHaveBeenCalledWith("chat-1", folder.id);
    expect(screen.queryByRole("dialog", { name: "Choose move to folder" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
    expect(onToggleChatFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-1" }));

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-1" }));
  });

  it("keeps Archive and Memory source eligibility as separate reachable actions", () => {
    const onDeleteChat = vi.fn();
    const onOpenArchivedChats = vi.fn();
    const onToggleChatMemorySource = vi.fn();
    renderPane({
      chatActionId: "chat-1",
      onDeleteChat,
      onOpenArchivedChats,
      onToggleChatMemorySource
    });

    fireEvent.click(screen.getByRole("button", { name: "Архив чатов" }));
    expect(onOpenArchivedChats).toHaveBeenCalledOnce();
    expect(screen.getByText("Источник Памяти")).toBeVisible();
    expect(screen.getByText(/Сохраняет чат, но немедленно прекращает/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Исключить этот чат из памяти" }));
    expect(onToggleChatMemorySource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-1", memoryMode: "NORMAL" })
    );
    expect(onDeleteChat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ id: "chat-1" }));
    expect(screen.queryByRole("button", { name: /Удалить чат|Delete chat/ })).not.toBeInTheDocument();
  });

  it("presents Resume disclosure for an excluded chat without changing Archive state", () => {
    const excludedGroups = chatGroups.map((group) => ({
      ...group,
      chats: group.chats.map((candidate) => ({
        ...candidate,
        memoryMode: "EXCLUDED" as const,
        memorySourceRevision: 3
      }))
    }));
    const onToggleChatMemorySource = vi.fn();
    renderPane({
      chatActionId: "chat-1",
      chatGroups: excludedGroups,
      onToggleChatMemorySource
    });

    expect(screen.getByText(/Разрешает контролируемую переиндексацию/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", {
      name: "Снова использовать этот чат как источник памяти"
    }));
    expect(onToggleChatMemorySource).toHaveBeenCalledWith(
      expect.objectContaining({ memoryMode: "EXCLUDED", memorySourceRevision: 3 })
    );
    expect(screen.getByRole("button", { name: "Архивировать" })).toBeVisible();
  });

  it("does not activate a chat when its overflow action is used", () => {
    const onActivateChat = vi.fn();
    const onChatActionToggle = vi.fn();
    renderPane({ onActivateChat, onChatActionToggle });

    fireEvent.click(screen.getByRole("button", { name: "Chat actions Planning" }));

    expect(onChatActionToggle).toHaveBeenCalledWith("chat-1");
    expect(onActivateChat).not.toHaveBeenCalled();
  });

  it("reserves chat row action space and reveals actions on hover or focus-capable layouts", () => {
    renderPane({ activeChatId: null });

    const actions = screen.getByTestId("chat-row-actions");
    expect(actions).toHaveClass("min-[1281px]:opacity-0");
    expect(actions).toHaveClass("min-[1281px]:group-hover/chat:opacity-100");
    expect(actions).toHaveClass("min-[1281px]:group-focus-within/chat:opacity-100");
    expect(actions).toHaveClass("[@media(hover:none)]:opacity-100");
    expect(actions.querySelectorAll("button")).toHaveLength(1);
  });

  it("uses touch-safe toolbar and navigation targets only in the mobile drawer", () => {
    const mobile = renderPane({ activeChatId: null, chatQuery: "plan", layout: "mobile" });

    expect(screen.getByTestId("left-chat-pane-mobile")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start new chat" })).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "New folder" })).toHaveClass("size-11");
    expect(screen.getByTestId("chat-search-control")).toHaveClass("min-h-touch");
    expect(screen.getByLabelText("Search chats")).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Clear chat search" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: /Collapse folder Research/ })).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Folder actions Research" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "Planning" })).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Chat actions Planning" })).toHaveClass(
      "min-h-touch",
      "w-11"
    );
    expect(screen.getByText("Research")).toHaveClass("min-w-0", "truncate");
    expect(screen.getByText("Planning")).toHaveClass("min-w-0", "[-webkit-line-clamp:2]");
    expect(screen.getByText("Planning")).not.toHaveClass("truncate");

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(screen.getByLabelText("Folder name")).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Create folder" })).toHaveClass("size-11");

    mobile.unmount();
    renderPane({ activeChatId: null, chatQuery: "plan" });

    expect(screen.getByTestId("left-chat-pane")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start new chat" })).toHaveClass("h-control");
    expect(screen.getByRole("button", { name: "Start new chat" })).toHaveClass(
      "[@media(pointer:coarse)]:!h-touch"
    );
    expect(screen.getByRole("button", { name: "Start new chat" })).not.toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "New folder" })).toHaveClass("size-10");
    expect(screen.getByTestId("chat-search-control")).toHaveClass("h-control");
    expect(screen.getByLabelText("Search chats")).toHaveClass("h-control");
    expect(screen.getByRole("button", { name: "Clear chat search" })).toHaveClass("size-9");
    expect(screen.getByRole("button", { name: /Collapse folder Research/ })).toHaveClass("min-h-10");
    expect(screen.getByRole("button", { name: "Folder actions Research" })).toHaveClass("size-9");
    expect(screen.getByRole("button", { name: "Planning" })).toHaveClass("min-h-10");
    expect(screen.getByRole("button", { name: "Chat actions Planning" })).toHaveClass("w-9");
    expect(screen.getByRole("button", { name: "Chat actions Planning" })).not.toHaveClass("min-h-touch");
  });

  it("restores and reports the mobile Workspace navigation scroll position", () => {
    const scrollTopRef = { current: 137 as number | undefined };
    renderPane({ layout: "mobile", scrollTopRef });
    const navigation = screen.getByRole("navigation", { name: "Workspace chats and folders" });

    expect(navigation.scrollTop).toBe(137);
    navigation.scrollTop = 211;
    fireEvent.scroll(navigation);

    expect(scrollTopRef.current).toBe(211);
  });

  it("updates the non-scrolling footer through the memoized workspace pane", () => {
    const { rerender, ...view } = renderPane({ footer: <span>Account one</span> });

    expect(screen.getByTestId("workspace-account-footer")).toHaveTextContent("Account one");
    rerender(<LeftChatPane {...view} footer={<span>Account two</span>} />);

    expect(screen.getByTestId("workspace-account-footer")).toHaveTextContent("Account two");
  });

  it("makes mobile inline rename controls touch-safe while desktop editors stay compact", () => {
    const mobile = renderPane({
      editingChatId: "chat-1",
      editingChatTitle: "Planning notes",
      editingFolderId: folder.id,
      editingFolderName: "Research notes",
      layout: "mobile"
    });

    expect(screen.getByLabelText("Edit title Planning")).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Save title Planning" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "Cancel renaming Planning" })).toHaveClass("size-11");
    expect(screen.getByLabelText("Rename folder Research")).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Save folder Research" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "Cancel renaming folder Research" })).toHaveClass("size-11");

    mobile.unmount();
    renderPane({
      editingChatId: "chat-1",
      editingChatTitle: "Planning notes",
      editingFolderId: folder.id,
      editingFolderName: "Research notes"
    });

    expect(screen.getByLabelText("Edit title Planning")).toHaveClass("h-9");
    expect(screen.getByRole("button", { name: "Save title Planning" })).toHaveClass("size-9");
    expect(screen.getByLabelText("Rename folder Research")).toHaveClass("h-9");
    expect(screen.getByRole("button", { name: "Save folder Research" })).toHaveClass("size-9");
  });

  it("does not save or cancel inline renames while IME composition owns the key", () => {
    const onCancelChatEdit = vi.fn();
    const onCancelFolderEdit = vi.fn();
    const onSaveChatTitle = vi.fn();
    const onSaveFolder = vi.fn();
    renderPane({
      editingChatId: "chat-1",
      editingChatTitle: "Planning notes",
      editingFolderId: folder.id,
      editingFolderName: "Research notes",
      onCancelChatEdit,
      onCancelFolderEdit,
      onSaveChatTitle,
      onSaveFolder
    });

    const chatInput = screen.getByLabelText("Edit title Planning");
    const folderInput = screen.getByLabelText("Rename folder Research");
    for (const input of [chatInput, folderInput]) {
      fireEvent.keyDown(input, { isComposing: true, key: "Enter" });
      fireEvent.keyDown(input, { key: "Process" });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      fireEvent.keyDown(input, { isComposing: true, key: "Escape" });
      fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    }

    expect(onSaveChatTitle).not.toHaveBeenCalled();
    expect(onSaveFolder).not.toHaveBeenCalled();
    expect(onCancelChatEdit).not.toHaveBeenCalled();
    expect(onCancelFolderEdit).not.toHaveBeenCalled();

    fireEvent.keyDown(chatInput, { key: "Enter" });
    fireEvent.keyDown(folderInput, { key: "Enter" });
    fireEvent.keyDown(chatInput, { key: "Escape" });
    fireEvent.keyDown(folderInput, { key: "Escape" });
    expect(onSaveChatTitle).toHaveBeenCalledOnce();
    expect(onSaveFolder).toHaveBeenCalledOnce();
    expect(onCancelChatEdit).toHaveBeenCalledOnce();
    expect(onCancelFolderEdit).toHaveBeenCalledOnce();
  });

  it("contains long mobile folder and chat labels while retaining their full values", () => {
    const longFolderName = "Research-with-an-uninterrupted-folder-name-that-must-not-widen-the-drawer";
    const longChatTitle = "Planning-with-an-uninterrupted-chat-title-that-must-remain-inside-the-row";
    const longFolder = { ...folder, name: longFolderName };
    const longChat = { ...chatGroups[0]!.chats[0]!, folderId: longFolder.id, title: longChatTitle };
    renderPane({
      activeChatId: longChat.id,
      chatGroups: [{ chats: [longChat], depth: 5, folder: longFolder, name: longFolderName }],
      folders: [longFolder],
      layout: "mobile"
    });

    const folderLabel = screen.getByText(longFolderName);
    const chatLabel = screen.getByText(longChatTitle);
    expect(folderLabel).toHaveClass("min-w-0", "truncate");
    expect(folderLabel).toHaveAttribute("title", longFolderName);
    expect(chatLabel).toHaveClass(
      "min-w-0",
      "overflow-hidden",
      "break-words",
      "[display:-webkit-box]",
      "[overflow-wrap:anywhere]",
      "[-webkit-box-orient:vertical]",
      "[-webkit-line-clamp:2]"
    );
    expect(chatLabel).not.toHaveClass("truncate");
    expect(screen.getByRole("button", { name: longChatTitle })).toHaveAttribute("title", longChatTitle);
    expect(screen.getByRole("navigation", { name: "Workspace chats and folders" })).toHaveClass(
      "overflow-x-hidden"
    );
  });

  it("keeps mobile action menus touch-safe, locally contained, and keyboard focused", async () => {
    const onCloseMenus = vi.fn();
    const onCancelSubfolder = vi.fn();
    const folderView = renderPane({
      folderMenuId: folder.id,
      layout: "mobile",
      onCloseMenus,
      onCancelSubfolder,
      subfolderName: "Sources",
      subfolderParentId: folder.id
    });

    const folderMenu = screen.getByRole("dialog", { name: "Folder actions for Research" });
    expect(folderMenu).toHaveClass(
      "overflow-y-auto",
      "overscroll-contain",
      "max-h-[min(25rem,calc(100dvh-12rem))]"
    );
    for (const name of ["New chat", "New subfolder", "Project settings", "Rename", "Delete folder"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-touch");
    }
    expect(screen.getByRole("button", { name: "Move folder Research to folder" })).toHaveClass(
      "h-touch",
      "sm:h-control"
    );
    expect(screen.getByLabelText("Subfolder name for Research")).toHaveClass("min-h-touch");
    expect(screen.getByRole("button", { name: "Create subfolder in Research" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "Cancel subfolder in Research" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus();

    fireEvent.keyDown(screen.getByLabelText("Subfolder name for Research"), {
      isComposing: true,
      key: "Escape"
    });
    fireEvent.keyDown(screen.getByLabelText("Subfolder name for Research"), {
      key: "Enter",
      keyCode: 229
    });
    expect(onCancelSubfolder).not.toHaveBeenCalled();
    expect(folderView.onCreateFolder).not.toHaveBeenCalled();
    expect(onCloseMenus).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Subfolder name for Research"), { key: "Escape" });
    expect(onCancelSubfolder).toHaveBeenCalledOnce();
    expect(onCloseMenus).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "New subfolder" })).toHaveFocus());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseMenus).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Folder actions Research" })).toHaveFocus();

    folderView.unmount();
    const chatView = renderPane({ chatActionId: "chat-1", layout: "mobile" });
    const chatMenu = screen.getByRole("dialog", { name: "Actions for Planning" });
    expect(chatMenu).toHaveClass(
      "overflow-y-auto",
      "overscroll-contain",
      "max-h-[min(25rem,calc(100dvh-12rem))]"
    );
    for (const name of ["Add to favorites", "Rename", "Share", "Export", "Архивировать"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-touch");
    }
    const mobileMoveChat = screen.getByRole("button", { name: "Move chat Planning to folder" });
    expect(mobileMoveChat).toHaveClass("h-touch", "sm:h-control");
    expect(screen.getByRole("button", { name: "Add to favorites" })).toHaveFocus();
    fireEvent.click(mobileMoveChat);
    const mobilePicker = screen.getByTestId("mobile-move-chat-chat-1-options");
    expect(mobilePicker).toHaveClass(
      "max-sm:fixed",
      "max-sm:bottom-2",
      "sm:static",
      "sm:max-h-72",
      "overflow-hidden"
    );
    expect(mobilePicker.querySelector(".overflow-y-auto")).not.toBeNull();

    chatView.unmount();
    renderPane({ chatActionId: "chat-1" });
    for (const name of ["Add to favorites", "Rename", "Share", "Export", "Архивировать"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-10");
      expect(screen.getByRole("button", { name })).not.toHaveClass("min-h-touch");
    }
    expect(screen.getByRole("button", { name: "Move chat Planning to folder" })).toHaveClass(
      "h-touch",
      "sm:h-control"
    );
  });

  it("communicates selected, favorite, running, and unavailable chat states", () => {
    const { rerender, ...view } = renderPane({
      activeRunChatIds: new Set(["chat-1"]),
      availableChatModelKeys: new Set(),
      chatGroups: [
        {
          ...chatGroups[0]!,
          chats: [{ ...chatGroups[0]!.chats[0]!, pinned: true }]
        }
      ]
    });

    const row = screen.getByTestId("chat-row");
    const chat = screen.getByRole("button", { name: "Planning" });
    expect(row).toHaveAttribute("data-active", "true");
    expect(row).toHaveAttribute("data-favorite", "true");
    expect(row).toHaveAttribute("data-unavailable", "true");
    expect(row).toHaveClass("bg-control-selected");
    expect(screen.getByTestId("active-chat-marker")).toHaveClass("bg-proof");
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(chat).toHaveAccessibleDescription(/Favorite.*Response running.*Model unavailable for new runs/);
    expect(document.getElementById(chat.getAttribute("aria-describedby")!)).not.toHaveAttribute("role");
    expect(screen.getByText("Unavailable")).toHaveClass("text-ink-secondary");

    rerender(<LeftChatPane {...view} chatModelLabels={new Map()} />);
    expect(screen.getByText("Unavailable model")).toBeVisible();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("labels title, model, and server message matches without searching loaded messages locally", () => {
    const { rerender, ...view } = renderPane({ chatQuery: "planning" });
    expect(screen.getAllByText("Title match")[0]).toBeVisible();

    rerender(<LeftChatPane {...view} chatQuery="fake-qsa" />);
    expect(screen.getAllByText("Model match")[0]).toBeVisible();

    rerender(
      <LeftChatPane
        {...view}
        chatContentMatchIds={new Set(["chat-1"])}
        chatQuery="buried phrase"
      />
    );
    expect(screen.getAllByText("Message match")[0]).toBeVisible();
    expect(screen.getByTestId("chat-search-status")).toHaveTextContent("1 message match");
  });

  it("shows message-search loading and failure separately from local results", () => {
    const { rerender, ...view } = renderPane({ chatContentSearchLoading: true, chatQuery: "planning" });
    expect(screen.getByTestId("chat-search-status")).toHaveTextContent("Searching message content");

    rerender(
      <LeftChatPane
        {...view}
        chatContentSearchError="Chat search failed"
        chatContentSearchLoading={false}
        chatQuery="planning"
      />
    );
    expect(screen.getByTestId("chat-search-status")).toHaveTextContent(
      "Message search unavailable. Showing title and model matches."
    );
  });

  it("adds provider and date context only for duplicate-looking titles", () => {
    const duplicate = {
      ...chatGroups[0]!.chats[0]!,
      defaultModelId: "other-model",
      defaultProvider: "openai",
      id: "chat-2"
    };
    renderPane({
      availableChatModelKeys: new Set(["fake:fake-qsa", "openai:other-model"]),
      chatGroups: [{ ...chatGroups[0]!, chats: [chatGroups[0]!.chats[0]!, duplicate] }]
    });

    expect(screen.getByText(/Fake · Fake QSA/)).toBeVisible();
    expect(screen.getByText(/OpenAI · Other model/)).toBeVisible();
    expect(screen.queryByText(/fake-qsa|other-model/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Planning, .* updated/ })).toHaveLength(2);
  });

  it("collapses a nested branch while keeping an active-descendant cue", () => {
    const childFolder: FolderSummary = {
      id: "folder-2",
      name: "Sources",
      parentId: folder.id,
      projectMemory: "Use primary sources.",
      sortOrder: 0
    };
    const childChat = { ...chatGroups[0]!.chats[0]!, folderId: childFolder.id };
    renderPane({
      activeChatId: childChat.id,
      chatGroups: [
        { chats: [], depth: 0, folder, name: folder.name },
        { chats: [childChat], depth: 1, folder: childFolder, name: childFolder.name }
      ],
      collapsedFolderIds: new Set([folder.id]),
      folders: [folder, childFolder]
    });

    const parentRow = screen.getByRole("button", { name: /Expand folder Research/ });
    expect(parentRow).toHaveAccessibleName(/contains active chat/);
    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Planning" })).not.toBeInTheDocument();
  });

  it("keeps the complete folder workflow in a named, keyboard-focused menu", () => {
    renderPane({ folderMenuId: folder.id });

    const menu = screen.getByRole("dialog", { name: "Folder actions for Research" });
    expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus();
    expect(menu).toHaveTextContent("No project memory");
    expect(screen.getByRole("button", { name: "New subfolder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Project settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Rename" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Move folder Research to folder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeVisible();
  });

  it("moves a folder from the shared picker and excludes invalid descendants", () => {
    const childFolder: FolderSummary = {
      id: "folder-2",
      name: "Sources",
      parentId: folder.id,
      projectMemory: "",
      sortOrder: 0
    };
    const grandchildFolder: FolderSummary = {
      id: "folder-3",
      name: "Primary",
      parentId: childFolder.id,
      projectMemory: "",
      sortOrder: 0
    };
    const onMoveFolder = vi.fn();
    renderPane({
      chatGroups: [
        { chats: [], depth: 0, folder, name: folder.name },
        { chats: [], depth: 1, folder: childFolder, name: childFolder.name },
        { chats: [], depth: 2, folder: grandchildFolder, name: grandchildFolder.name }
      ],
      folderMenuId: childFolder.id,
      folders: [folder, childFolder, grandchildFolder],
      onMoveFolder
    });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move folder Sources to folder" }));
    const picker = screen.getByRole("dialog", { name: "Choose move to folder" });
    const currentRow = within(picker).getByText("Research", { exact: true }).closest("button");
    expect(currentRow).toHaveTextContent("Current");
    expect(within(picker).queryByText("Sources", { exact: true })).not.toBeInTheDocument();
    expect(within(picker).queryByText("Primary", { exact: true })).not.toBeInTheDocument();

    fireEvent.click(within(picker).getByText("Top level", { exact: true }));
    expect(onMoveFolder).toHaveBeenCalledWith(childFolder, null);
    expect(screen.queryByRole("dialog", { name: "Choose move to folder" })).not.toBeInTheDocument();
  });

  it("keeps deep destination paths readable with bounded indentation and local scrolling", () => {
    const deepFolders = Array.from({ length: 7 }, (_, index): FolderSummary => ({
      id: `deep-${index}`,
      name: `Level ${index + 1}`,
      parentId: index === 0 ? null : `deep-${index - 1}`,
      projectMemory: "",
      sortOrder: index
    }));
    renderPane({
      chatActionId: "chat-1",
      folders: deepFolders
    });

    fireEvent.click(screen.getByRole("button", { name: "Move chat Planning to folder" }));
    const picker = screen.getByRole("dialog", { name: "Choose move to folder" });
    const deepestLabel = within(picker).getByText("Level 7", { exact: true });
    const deepestContent = deepestLabel.closest("[data-option-depth]");
    expect(deepestContent).toHaveAttribute("data-option-depth", "5");
    expect(deepestContent).toHaveTextContent(
      "Level 1 / Level 2 / Level 3 / Level 4 / Level 5 / Level 6 / Level 7"
    );
    expect(picker).toHaveClass("overflow-hidden", "sm:max-h-72");
    expect(picker.querySelector(".overflow-y-auto")).toHaveClass("overscroll-contain");
  });

  it("keeps New Chat available unless chat creation itself is pending", () => {
    const { rerender, ...view } = renderPane();

    expect(screen.getByRole("button", { name: "Start new chat" })).toBeEnabled();

    rerender(<LeftChatPane {...view} creatingChat />);
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
  });

  it("gates workspace mutations and offers local recovery until initial hydration succeeds", () => {
    const onRetryWorkspace = vi.fn();
    const { rerender, ...view } = renderPane({
      chatGroups: [],
      folders: [],
      onRetryWorkspace,
      workspaceError: "workspace_failed_500",
      workspaceReady: false
    });

    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Search chats" })).toBeDisabled();
    expect(screen.getByTestId("chat-search-control")).toHaveClass("ring-trace-subtle");
    expect(screen.getByTestId("chat-search-control")).not.toHaveClass("ring-control-boundary");
    expect(screen.getByTestId("left-workspace-unavailable")).toHaveTextContent("Chats unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry workspace" }));
    expect(onRetryWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByText("workspace_failed_500")).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();

    rerender(
      <LeftChatPane
        {...view}
        chatGroups={[]}
        folders={[]}
        workspaceError={null}
        workspaceReady
      />
    );
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Search chats" })).toBeEnabled();
    expect(screen.getByText("No chats yet")).toBeVisible();
  });

  it("keeps initial loading distinct and reserves stable history-row geometry", () => {
    renderPane({
      chatGroups: [],
      folders: [],
      workspaceLoading: true,
      workspaceReady: false
    });

    const loading = screen.getByTestId("workspace-loading-state");
    expect(loading).toHaveTextContent("Loading workspace");
    expect(loading.querySelectorAll(".skeleton-block")).toHaveLength(3);
    expect(screen.queryByTestId("workspace-empty-state")).not.toBeInTheDocument();
  });

  it("renders chats without a folder as a flat list without a pseudo-folder heading", () => {
    renderPane();

    expect(screen.getByRole("button", { name: "Planning" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /folder No folder/i })).not.toBeInTheDocument();
  });

  it("reveals the folder name input on demand and cancels on Escape", () => {
    const onCreateFolder = vi.fn();
    const onNewFolderNameChange = vi.fn();
    renderPane({ newFolderName: "Ops", onCreateFolder, onNewFolderNameChange });

    expect(screen.queryByLabelText("Folder name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const input = screen.getByLabelText("Folder name");
    expect(input).toBeVisible();

    fireEvent.keyDown(input, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(input, { key: "Process" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { isComposing: true, key: "Escape" });
    expect(onCreateFolder).not.toHaveBeenCalled();
    expect(onNewFolderNameChange).not.toHaveBeenCalled();
    expect(input).toBeVisible();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateFolder).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Folder name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.keyDown(screen.getByLabelText("Folder name"), { key: "Escape" });
    expect(onNewFolderNameChange).toHaveBeenCalledWith("");
    expect(screen.queryByLabelText("Folder name")).not.toBeInTheDocument();
  });
});

import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { ComposerContextStats } from "@/components/app-shell/composerContextStats";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import type { KnowledgeLibraryView } from "@/components/knowledge/libraryViewContracts";
import type { ComposerAssistantSelection } from "@/components/app-shell/composerControlStore";
import type {
  ComposerConfigKnowledgeBase,
  ComposerConfigKnowledgeSource
} from "@/lib/contracts/composerConfig";
import type { KnowledgeBaseSummary, KnowledgeSelection } from "@/lib/contracts/knowledge";
import type { SettingsSection } from "@/components/app-shell/settingsDestinationStore";
import type { ThemeId } from "@/components/app-shell/theme";
import type {
  Catalog,
  CatalogModel,
  WorkspaceChatSummary,
  ChatUsageStats,
  FolderSummary,
  ModelParameterControls,
  Notice,
  RunEventView,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { RefObject } from "react";
import type { SearchPlanMode } from "@/lib/domain/search";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import type { ProjectWorkspaceController } from "@/features/projects-v2/useProjectWorkspaceController";

export type ShellSessionView = {
  accountId: string;
  accountEmail: string | null;
  activeChatId: string | null;
  activeChatTitle: string;
  adminEntryVisible: boolean;
  copyProjectChatLink(): Promise<void> | void;
  dismissNotice(): void;
  notice: Notice | null;
  shareActiveBranch(): Promise<void> | void;
};

export type ShellWorkspacePaneState = {
  editingChatId: string | null;
  editingChatTitle: string;
  editingFolderId: string | null;
  editingFolderName: string;
  folderActionId: string | null;
  workspaceLoading: boolean;
};

export type ShellWorkspacePaneActions = {
  activateChat(chat: WorkspaceChatSummary): void;
  cancelChatEdit(): void;
  cancelFolderEdit(): void;
  changeEditingChatTitle(value: string): void;
  changeEditingFolderName(value: string): void;
  createChat(
    folderId?: string | null,
    memoryMode?: "EXCLUDED" | "NORMAL" | "TEMPORARY"
  ): Promise<WorkspaceChatSummary | null> | void;
  createFolder(parentId?: string | null, nameOverride?: string): Promise<void> | void;
  deleteChat(chat: WorkspaceChatSummary): Promise<void> | void;
  /**
   * Opens the existing permanent-deletion confirm surface for this chat.
   * Server-verified gating (`permanentChatDeletionAvailable`) and the
   * irreversible-deletion semantics stay owned by the deletion store.
   */
  deleteChatPermanently(chat: WorkspaceChatSummary): Promise<void> | void;
  deleteFolder(folder: FolderSummary): Promise<void> | void;
  exportChat(chat: WorkspaceChatSummary, format?: "json" | "markdown"): void;
  moveChat(chatId: string, folderId: string | null): Promise<void> | void;
  moveFolder(folder: FolderSummary, folderId: string | null): Promise<void> | void;
  openArchivedChats(): void;
  openProjectSettings(folder: FolderSummary): void;
  retry(): Promise<unknown> | void;
  saveChatTitle(chat: WorkspaceChatSummary): Promise<void> | void;
  saveFolder(folder: FolderSummary): Promise<void> | void;
  shareChat(chat: WorkspaceChatSummary): Promise<void> | void;
  startChatEdit(chat: WorkspaceChatSummary): void;
  startFolderEdit(folder: FolderSummary): void;
  toggleChatMemorySource(
    chat: WorkspaceChatSummary,
    mode: "EXCLUDED" | "NORMAL"
  ): Promise<void> | void;
  toggleChatFavorite(chat: WorkspaceChatSummary): Promise<void> | void;
};

export type ShellWorkspacePaneView = {
  actions: ShellWorkspacePaneActions;
  state: ShellWorkspacePaneState;
};

export type ShellWorkspaceView = {
  archived: {
    onRestored(chatId: string): Promise<void> | void;
    open: boolean;
  };
  pane: ShellWorkspacePaneView;
  projects: ProjectWorkspaceController;
  projectSettings: {
    changeKnowledgeBaseIds(value: string[]): void;
    close(): void;
    folder: FolderSummary | null;
    knowledgeBaseIds: string[];
    knowledgeBases: KnowledgeBaseSummary[];
    knowledgeDataError: string | null;
    knowledgeDataState: "error" | "loading" | "ready";
    retryKnowledge(): void;
    save(folder: FolderSummary): Promise<void> | void;
  };
};

export type ShellThreadView = {
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatStreaming: boolean;
  copyVisibleThread(): Promise<void> | void;
  currentRunId: string | null;
  editingMessageId: string | null;
  editingMessagePending: boolean;
  events: RunEventView[];
  handleBranchFromMessage(messageId: string): void;
  handleCopyMessage(message: ThreadMessage): void;
  handleDeleteMessage(messageId: string): void;
  handleEditMessage(message: ThreadMessage): void;
  handleRegenerateMessage(messageId: string): void;
  handleThreadScroll(): void;
  hasOlderMessages: boolean;
  /**
   * The chat's recorded ambiguous transport loss (a stream whose connection
   * genuinely failed without a terminal frame), or null while the transport
   * is healthy. Presentation renders it as the honest connection-lost state.
   */
  interruptedRun: Readonly<{ assistantMessageId: string; runId: string | null }> | null;
  loadEarlierMessages(): Promise<void> | void;
  loadingOlderMessages: boolean;
  jumpToLatest(): void;
  liveArtifactSummary: ThreadArtifactSummary | null;
  olderMessagesError: string | null;
  /**
   * Existing headless force-refresh owner for an ambiguous transport failure:
   * reconciles the chat with durable server state and clears the recorded
   * ambiguity on success ("Refresh" in the connection-lost strip).
   */
  refreshInterruptedRun(): Promise<boolean>;
  retryActiveChatDetail(): void;
  showJumpToLatest: boolean;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  visibleMessages: ThreadMessage[];
};

export type ShellComposerActions = {
  cancelMessageEdit(): void;
  changeDraft(value: string): void;
  rejectAttachmentCount(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  rejectAttachments(fileNames: readonly string[]): void;
  removeAttachment(attachmentId: string): void;
  retryAttachment?(attachmentId: string): void;
};

export type ShellComposerView = {
  attachments: ComposerAttachment[];
  backgroundMode: boolean;
  catalog: Catalog | null;
  catalogError: string | null;
  changeBackgroundMode(value: boolean): void;
  changeMaxOutputTokens(value: string): void;
  changeReasoningEffort(value: string): void;
  changeReasoningMode(value: string): void;
  changeStreamMode(value: boolean): void;
  changeTemperature(value: string): void;
  composerActions: ShellComposerActions;
  composerContextStats: ComposerContextStats | null;
  composerDisabledHint: string | null;
  composerUsageStats: ChatUsageStats | null;
  assistant: {
    clearRemovedNotice(): void;
    openLibrary(): void;
    openPicker: boolean;
    pickerItems: import("@/lib/contracts/assistants").AssistantSummary[];
    pickerLoading: boolean;
    recentIds: string[];
    remove(): void;
    removedNotice: boolean;
    selectById(assistantId: string): void;
    selected: ComposerAssistantSelection | null;
    sendStarter(prompt: string): void;
    setPickerOpen(open: boolean): void;
    startFromCurrentSetup(): void;
  };
  currentModel: CatalogModel | undefined;
  currentParameterControls: ModelParameterControls;
  draft: string;
  knowledge: {
    bases: readonly ComposerConfigKnowledgeBase[];
    searchSources?(query: string): Promise<readonly ComposerConfigKnowledgeSource[]>;
    select(selection: KnowledgeSelection): void;
    selection: KnowledgeSelection;
    sources: readonly ComposerConfigKnowledgeSource[];
  };
  maxOutputTokens: string;
  memory: {
    canToggleTemporary: boolean;
    explanation: string;
    externalRetention: string;
    label: string;
    mode: "NORMAL" | "TEMPORARY";
    retention: string;
    retentionDeadline: string | null;
    toggleTemporary(): void;
  };
  makeModelDefault?(model: CatalogModel): void;
  notificationSoundEnabled: boolean;
  operationError: string | null;
  operationErrorLive: boolean;
  reasoningEffort: string;
  reasoningMode: string;
  retryCatalog(): void;
  searchPlanMode: SearchPlanMode;
  selectModel(model: CatalogModel): void;
  selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  showCitations: boolean;
  showReasoningBlocks: boolean;
  stopCurrentRun(): Promise<void> | void;
  streamMode: boolean;
  submitComposer(): Promise<void> | void;
  temperature: string;
  toggleCitationsVisibility(): void;
  toggleNotificationSound(): void;
  toggleReasoningBlockVisibility(): void;
  useOrganizationSearchDefault(): void;
  useOrganizationModelDefault?(): void;
  uploadFiles(files: FileList | readonly File[]): Promise<void> | void;
  uploading: boolean;
};

export type ShellBranchesView = {
  close(): void;
  checkoutBranch(messageId: string): void;
  error: string | null;
  graph: ChatBranchGraphWire | null;
  loading: boolean;
  open: boolean;
  retry(): void;
  show(): void;
};

export type ShellSettingsView = {
  closeMemory(): void;
  closeSettings(): void;
  dismissNotice(): void;
  knowledge: KnowledgeLibraryView | null;
  library: AssistantLibraryView | null;
  memory: {
    open: boolean;
  };
  notice: Notice | null;
  open(): void;
  openKnowledge(): void;
  openLibrary(): void;
  openMemory(): void;
  openMcp(): void;
  settings: {
    open: boolean;
    section: SettingsSection;
    themeId: ThemeId;
  };
  updateTheme(themeId: ThemeId): void;
};

export type ShellOverlaysView = {
  confirmations: {
    cancelChat(): void;
    cancelFolder(): void;
    cancelMemoryResume(): void;
    cancelMessage(): void;
    chat: WorkspaceChatSummary | null;
    confirmChat(): void;
    confirmFolder(): void;
    confirmMemoryResume(): void;
    confirmMessage(): void;
    folder: FolderSummary | null;
    memoryResume: WorkspaceChatSummary | null;
    message: string | null;
  };
  share: {
    close(): void;
    target: ShareDialogTarget | null;
  };
};

export type PowerAppShellV2Props = {
  branches: ShellBranchesView;
  composer: ShellComposerView;
  overlays: ShellOverlaysView;
  session: ShellSessionView;
  settings: ShellSettingsView;
  thread: ShellThreadView;
  workspace: ShellWorkspaceView;
};

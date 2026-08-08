import type { ComposerAttachment } from "@/components/chat/Composer";
import type { ComposerContextStats } from "@/components/app-shell/composerContextStats";
import type { CommandItem } from "@/components/command-palette/commandItems";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import type { KnowledgeLibraryView } from "@/components/knowledge/libraryViewContracts";
import type {
  ComposerAssistantSelection,
  ComposerKnowledgePlanSource
} from "@/components/app-shell/composerControlStore";
import type { KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import type { SettingsSection } from "@/components/app-shell/settingsDestinationStore";
import type { ThemeId } from "@/components/app-shell/theme";
import type { InspectorTabId } from "@/components/inspector/InspectorTabs";
import type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  ChatGroup,
  ChatSummary,
  ChatUsageStats,
  FolderSummary,
  InspectorMode,
  ModelParameterControls,
  Notice,
  PersistedRun,
  RunEventView,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { RefObject } from "react";
import type { SearchPlanMode } from "@/lib/domain/search";

export const powerAppShellViewFeatureKeys = [
  "session",
  "workspace",
  "thread",
  "composer",
  "details",
  "settings",
  "overlays"
] as const;

export type ShellSessionView = {
  accountEmail: string | null;
  activeChatId: string | null;
  activeChatTitle: string;
  adminEntryVisible: boolean;
  dismissNotice(): void;
  notice: Notice | null;
  shareActiveBranch(): Promise<void> | void;
};

export type ShellWorkspacePaneState = {
  activeRunChatIds: ReadonlySet<string>;
  chatActionId: string | null;
  chatContentMatchIds: Set<string>;
  chatContentSearchError: string | null;
  chatContentSearchLoading: boolean;
  chatGroups: ChatGroup[];
  chatQuery: string;
  collapsedFolderIds: Set<string>;
  creatingChat: boolean;
  creatingFolder: boolean;
  editingChatId: string | null;
  editingChatTitle: string;
  editingFolderId: string | null;
  editingFolderName: string;
  folderActionId: string | null;
  folderMenuId: string | null;
  folders: FolderSummary[];
  newFolderName: string;
  subfolderName: string;
  subfolderParentId: string | null;
  workspaceError: string | null;
  workspaceLoading: boolean;
  workspaceReady: boolean;
};

export type ShellWorkspacePaneActions = {
  activateChat(chat: ChatSummary): void;
  cancelChatEdit(): void;
  cancelFolderEdit(): void;
  cancelSubfolder(): void;
  changeChatQuery(value: string): void;
  changeEditingChatTitle(value: string): void;
  changeEditingFolderName(value: string): void;
  changeNewFolderName(value: string): void;
  changeSubfolderName(value: string): void;
  closeMenus(): void;
  createChat(folderId?: string | null): Promise<ChatSummary | null> | void;
  createFolder(parentId?: string | null, nameOverride?: string): Promise<void> | void;
  deleteChat(chat: ChatSummary): Promise<void> | void;
  deleteFolder(folder: FolderSummary): Promise<void> | void;
  exportChat(chat: ChatSummary): void;
  moveChat(chatId: string, folderId: string | null): Promise<void> | void;
  moveFolder(folder: FolderSummary, folderId: string | null): Promise<void> | void;
  openProjectSettings(folder: FolderSummary): void;
  retry(): Promise<unknown> | void;
  saveChatTitle(chat: ChatSummary): Promise<void> | void;
  saveFolder(folder: FolderSummary): Promise<void> | void;
  shareChat(chat: ChatSummary): Promise<void> | void;
  startChatEdit(chat: ChatSummary): void;
  startFolderEdit(folder: FolderSummary): void;
  startSubfolder(folder: FolderSummary): void;
  toggleChatActions(chatId: string): void;
  toggleChatFavorite(chat: ChatSummary): Promise<void> | void;
  toggleFolderCollapsed(folderId: string): void;
  toggleFolderMenu(folderId: string): void;
};

export type ShellWorkspacePaneView = {
  actions: ShellWorkspacePaneActions;
  state: ShellWorkspacePaneState;
};

export type ShellWorkspaceView = {
  mobile: {
    close(): void;
    dialogRef: RefObject<HTMLDivElement | null>;
    open: boolean;
    show(): void;
  };
  pane: ShellWorkspacePaneView;
  projectSettings: {
    changeDraft(value: string): void;
    changeKnowledgeBaseIds(value: string[]): void;
    close(): void;
    draft: string;
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
  handleBranchFromMessage(messageId: string): void;
  handleCopyMessage(message: ThreadMessage): void;
  handleDeleteMessage(messageId: string): void;
  handleEditMessage(message: ThreadMessage): void;
  handleRegenerateMessage(messageId: string): void;
  handleThreadScroll(): void;
  inspectRun(runId: string): Promise<void> | void;
  jumpToLatest(): void;
  lastRun: PersistedRun | null;
  liveArtifactSummary: ThreadArtifactSummary | null;
  openKnowledgeEvidence(knowledgeBaseId: string): void;
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
  compatibleSearchOptionIds: string[];
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
  flushPendingModelControlDefaults(): void;
  knowledge: {
    bases: KnowledgeBaseSummary[];
    clearChatDefault?(): void;
    dataError: string | null;
    dataState: "error" | "loading" | "ready";
    hasChatDefault: boolean;
    retry(): void;
    saveChatDefault?(): void;
    select(baseIds: readonly string[]): void;
    selectedBaseIds: string[];
    source: ComposerKnowledgePlanSource;
  };
  maxOutputTokens: string;
  makeCurrentModelDefault?(): void;
  notificationSoundEnabled: boolean;
  operationError: string | null;
  operationErrorLive: boolean;
  reasoningEffort: string;
  reasoningMode: string;
  retryCatalog(): void;
  searchOptions: CatalogSearchStrategy[];
  searchPreferenceSource: "organization" | "personal";
  searchPlanMode: SearchPlanMode;
  selectModel(model: CatalogModel): void;
  selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedProvider: string;
  selectedProviderName: string;
  selectedSearchOptionIds: string[];
  selectedSearchStrategy: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  stopCurrentRun(): Promise<void> | void;
  streamMode: boolean;
  submitComposer(): Promise<void> | void;
  temperature: string;
  toggleCitationsVisibility(): void;
  toggleNotificationSound(): void;
  toggleReasoningBlockVisibility(): void;
  toggleToolActivityVisibility(): void;
  useOrganizationSearchDefault(): void;
  useOrganizationModelDefault?(): void;
  uploadFiles(files: FileList | readonly File[]): Promise<void> | void;
  uploading: boolean;
};

export type ShellDetailsView = {
  activeLeafId: string | null;
  activeTab: InspectorTabId;
  changeActiveTab(value: InspectorTabId): void;
  changeMode(mode: InspectorMode): void;
  checkoutBranch(messageId: string): void;
  errorText: string | null;
  events: RunEventView[];
  messages: ThreadMessage[];
  mode: InspectorMode;
  open(tab?: InspectorTabId): void;
  pinningAvailable: boolean;
};

export type ShellSettingsView = {
  closeSettings(): void;
  dismissNotice(): void;
  knowledge: KnowledgeLibraryView | null;
  library: AssistantLibraryView | null;
  notice: Notice | null;
  open(): void;
  openKnowledge(): void;
  openLibrary(): void;
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
    cancelMessage(): void;
    chat: ChatSummary | null;
    confirmChat(): void;
    confirmFolder(): void;
    confirmMessage(): void;
    folder: FolderSummary | null;
    message: string | null;
  };
  palette: {
    close(): void;
    items: CommandItem[];
    open: boolean;
    run(item: CommandItem): void;
    show(): void;
  };
  share: {
    close(): void;
    target: ShareDialogTarget | null;
  };
};

export type PowerAppShellViewProps = {
  composer: ShellComposerView;
  details: ShellDetailsView;
  overlays: ShellOverlaysView;
  session: ShellSessionView;
  settings: ShellSettingsView;
  thread: ShellThreadView;
  workspace: ShellWorkspaceView;
};

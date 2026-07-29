import type { ComposerAttachment } from "@/components/chat/Composer";
import type { CommandItem } from "@/components/command-palette/commandItems";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import type { PromptSettingsActions } from "@/components/app-shell/promptSettingsActions";
import type { SettingsSection } from "@/components/app-shell/promptSettingsStore";
import type { PromptEditorDraft } from "@/components/app-shell/promptSettingsStore";
import type { RunProfileId } from "@/components/app-shell/runProfiles";
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
  PromptPreset,
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
    close(): void;
    draft: string;
    folder: FolderSummary | null;
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
  jumpToLatest(): void;
  lastRun: PersistedRun | null;
  liveArtifactSummary: ThreadArtifactSummary | null;
  retryActiveChatDetail(): void;
  showJumpToLatest: boolean;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  visibleMessages: ThreadMessage[];
};

export type ShellComposerActions = {
  cancelMessageEdit(): void;
  changeDraft(value: string): void;
  rejectAttachments(fileNames: readonly string[]): void;
  removeAttachment(attachmentId: string): void;
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
  composerContextLine: string | null;
  composerDisabledHint: string | null;
  composerUsageStats: ChatUsageStats | null;
  currentModel: CatalogModel | undefined;
  currentParameterControls: ModelParameterControls;
  currentPrompt: PromptPreset | null;
  draft: string;
  flushPendingModelControlDefaults(): void;
  maxOutputTokens: string;
  notificationSoundEnabled: boolean;
  operationError: string | null;
  reasoningEffort: string;
  reasoningMode: string;
  retryCatalog(): void;
  searchOptions: CatalogSearchStrategy[];
  searchPlanMode: SearchPlanMode;
  selectModel(model: CatalogModel): void;
  selectPrompt(promptId: string): void;
  selectRunProfile(profileId: RunProfileId): void;
  selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedPromptId: string | null;
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
  actions: PromptSettingsActions;
  dismissNotice(): void;
  notice: Notice | null;
  open(): void;
  openMcp(): void;
  openPromptLibrary(): void;
  prompt: {
    deleteConfirmation: PromptPreset | null;
    editor: PromptEditorDraft;
    open: boolean;
    section: SettingsSection;
    saving: boolean;
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

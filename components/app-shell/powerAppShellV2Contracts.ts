import type { AnswerSoundId } from "@/lib/contracts/answerSound";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { ComposerSessionKey } from "@/components/app-shell/composerSessionStore";
import type { ComposerContextStats } from "@/components/app-shell/composerContextStats";
import type { ShareDialogTarget } from "@/components/app-shell/ShareDialog";
import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import type { KnowledgeLibraryView } from "@/components/knowledge/libraryViewContracts";
import type {
  ComposerAssistantRow,
  ComposerAssistantSkill,
  ComposerKnowledgePlanSource
} from "@/components/app-shell/composerControlStore";
import type {
  AssistantAvailability,
  AssistantAvatarRecipe,
  AssistantRowKey,
  AssistantSummary
} from "@/lib/contracts/assistants";
import type {
  ChatAssistantOverrideValues,
  ChatAssistantRowValues,
  ChatUsageStats
} from "@/lib/contracts/chats";
import type {
  ComposerConfigKnowledgeBase,
  ComposerConfigKnowledgeSource
} from "@/lib/contracts/composerConfig";
import type { KnowledgeBaseSummary, KnowledgeSelection } from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SettingsSection } from "@/components/app-shell/settingsDestinationStore";
import type { ThemeId } from "@/components/app-shell/theme";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  WorkspaceChatSummary,
  FolderSummary,
  ModelParameterControls,
  NameSaveResult,
  Notice,
  RunEventView,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { RefObject } from "react";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";
import type { ChatDefaultMcpMode } from "@/lib/contracts/chatDefaults";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import type { UserImageModelSettings } from "@/lib/contracts/imageModels";
import type {
  ChatWorkspaceState,
  ThreadGeneratedFile,
  WorkspaceUnavailableReason
} from "@/lib/contracts/workspace";
import type { ProjectWorkspaceController } from "@/features/projects-v2/useProjectWorkspaceController";

export type ShellSessionView = {
  accountId: string;
  accountDisplayName: string;
  accountEmail: string | null;
  updateAccountDisplayName(displayName: string): void;
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
  /** Which surface opened the rename; only it renders the field. */
  editingChatOrigin: "header" | "row" | null;
  editingChatTitle: string;
  editingFolderId: string | null;
  editingFolderName: string;
  folderActionId: string | null;
  workspaceLoading: boolean;
};

export type ShellWorkspacePaneActions = {
  openChat?(chatId: string): Promise<boolean>;
  /** Opens a personal chat by its address, as `/c/<id>` does, for a chat the workspace list does not hold yet. */
  openChatAddress(chatId: string): void;
  openContinuedChat?(chat: ChatDetail, sourceKey: ComposerSessionKey): Promise<boolean>;
  activateChat(chat: WorkspaceChatSummary): void;
  cancelChatEdit(): void;
  cancelFolderEdit(): void;
  changeEditingChatTitle(value: string): void;
  changeEditingFolderName(value: string): void;
  createChat(
    folderId?: string | null,
    memoryMode?: "EXCLUDED" | "NORMAL" | "TEMPORARY"
  ): Promise<WorkspaceChatSummary | null> | void;
  createFolder(parentId?: string | null, nameOverride?: string): Promise<NameSaveResult>;
  deleteChat(chat: WorkspaceChatSummary): Promise<void> | void;
  /**
   * Opens the existing permanent-deletion confirm surface for this chat.
   * Server-verified gating (`permanentChatDeletionAvailable`) and the
   * irreversible-deletion semantics stay owned by the deletion store.
   */
  deleteChatPermanently(chat: WorkspaceChatSummary): Promise<void> | void;
  deleteFolder(folder: FolderSummary): Promise<void> | void;
  exportChat(chat: WorkspaceChatSummary, format?: "json" | "markdown" | "pdf"): void;
  moveChat(chatId: string, folderId: string | null): Promise<void> | void;
  moveFolder(folder: FolderSummary, folderId: string | null): Promise<void> | void;
  openChatMessage(chatId: string, messageId: string): Promise<boolean>;
  /**
   * Opens a sidebar message match at its message: on the version of the chat
   * that contains it, with earlier pages loaded until it shows.
   */
  openSearchMatch(chatId: string, messageId: string): void;
  openProjectSettings(folder: FolderSummary): void;
  retry(): Promise<unknown> | void;
  saveChatTitle(chat: WorkspaceChatSummary): Promise<NameSaveResult>;
  saveFolder(folder: FolderSummary): Promise<NameSaveResult>;
  shareChat(chat: WorkspaceChatSummary): Promise<void> | void;
  startChatEdit(chat: WorkspaceChatSummary, origin?: "header" | "row"): void;
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
  usageStats?: ChatUsageStats | null;
  artifactDrafts?: readonly import("@/components/artifacts/artifactGenerationState").ArtifactGenerationDraft[];
  artifactDraftMessageId?: string;
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatStreaming: boolean;
  /** A verified answer may be complete while its Workspace still settles. */
  answerComplete?: boolean;
  /**
   * The resumed run of the active chat is still active after the frequent
   * polling horizon; it is checked rarely until terminal.
   */
  backgroundRunWaiting?: boolean;
  /** Checks the active chat's background run now (persistent Check run). */
  checkBackgroundRun?(): void;
  /** Copies the complete visible branch of the active chat, or of `chat` when given. */
  copyVisibleThread(chat?: Readonly<{ id: string; title: string }>): Promise<void> | void;
  cancelMessageEdit(messageId: string): void;
  changeEditingMessageDraft(value: string): void;
  currentRunId: string | null;
  editingMessageDraft: string;
  editingMessageError: string | null;
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
  refreshLayout(): void;
  liveArtifactSummary: ThreadArtifactSummary | null;
  /** Send → first answer token of the run in flight (client clock); null until the answer starts. */
  liveWorkDurationMs: number | null;
  olderMessagesError: string | null;
  /**
   * Existing headless force-refresh owner for an ambiguous transport failure:
   * reconciles the chat with durable server state and clears the recorded
   * ambiguity on success ("Refresh" in the connection-lost strip).
   */
  refreshInterruptedRun(): Promise<boolean>;
  retryActiveChatDetail(): void;
  /** Continues the open chat after its initiator allowed a refused MCP call. */
  sendMcpApprovalContinuation?(card: Readonly<{ approvalId: string; serverName: string; toolName: string }>): Promise<void>;
  /** The message a search result opened in this chat; a long question shows in full. */
  revealedMessageId?: string | null;
  /**
   * The scheduled task whose later runs continue in the open chat (same-chat
   * mode, its newest chat): replies here do not change it, its editor does.
   */
  scheduledTaskChat?: Readonly<{ onEdit?(): void; title: string }> | null;
  showJumpToLatest: boolean;
  submitMessageEdit(): Promise<void> | void;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  visibleMessages: ThreadMessage[];
};

export type ShellComposerActions = {
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

/** A row of the chat's Assistant with its effective value, as the composer holds it. */
export type ShellComposerAssistantRow<Key extends AssistantRowKey = AssistantRowKey> =
  ComposerAssistantRow<Key> & { value: ChatAssistantRowValues[Key] };

/**
 * The chat's Assistant. `scope` says where a change goes: `composer` until the
 * first message of a new chat carries it, `chat` for an existing chat.
 */
export type ShellComposerAssistant =
  | {
      availability: AssistantAvailability;
      avatar: AssistantAvatarRecipe;
      /** Send stays blocked while this is set (archived, a missing fixed dependency). */
      blockReason: string | null;
      /** Rows changed for this chat, in row order. */
      changedRows: AssistantRowKey[];
      description: string;
      id: string;
      includedSkills: ComposerAssistantSkill[];
      name: string;
      owned: boolean;
      ownerDisplayName: string;
      /**
       * True in a Project chat: the Assistant is the Project's, and inherit
       * and fallback rows use the Project's defaults, never personal ones.
       */
      project?: true;
      /** In a Project chat, the Project's name when known: the Assistant's byline. */
      projectName?: string;
      rows: { [Key in AssistantRowKey]: ShellComposerAssistantRow<Key> };
      scope: "chat" | "composer";
      starterPrompts: string[];
      state: "bound";
    }
  | {
      blockReason: string;
      /** A consumer's Assistant its owner archived; nothing else about it is known. */
      reason?: "archived";
      scope: "chat" | "composer";
      state: "deleted" | "unavailable";
    };

/** Browser push notifications of this account on this device. */
export type BrowserNotificationsView = Readonly<{
  /** The browser offers push only to the app added to the Home Screen (iPhone, iPad). */
  appleMobile: boolean;
  /** The one-click permission request is due: the setting is on and the browser has not been asked. */
  bannerVisible: boolean;
  dismissBanner(): void;
  enabled: boolean;
  permission: "default" | "denied" | "granted" | "unsupported";
  /** The account setting has loaded. */
  ready: boolean;
  /** Asks the browser for permission; call only from a click. */
  requestPermission(): void;
  requesting: boolean;
  toggle(): void;
}>;

export type ShellComposerView = {
  agent?: Readonly<{ enabled: boolean; unavailableReason?: string; setEnabled(value: boolean): void }>;
  attachments: ComposerAttachment[];
  backgroundMode: boolean;
  browserNotifications?: BrowserNotificationsView;
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
  assistant: {
    /** Personal: pinned, Featured, Yours, Shared; Project: the Project's Assistants. */
    pickerItems: AssistantSummary[];
    pickerLoading: boolean;
    /** Loads the personal list once when nothing has loaded it yet (the composer's `/` palette); absent in a Project. */
    loadPickerItems?(): void;
    /** Assistants of the latest personal chats, newest first (from the list response). */
    recentIds: string[];
    /**
     * The blank personal chat's strip: pinned (up to five), then Featured, all
     * usable now. Empty inside a Project and until the list has loaded.
     */
    stripItems: readonly AssistantSummary[];
    /** The chat's Assistant; null without one. */
    current: ShellComposerAssistant | null;
    /** A chat update of the Assistant is in flight for the open chat. */
    pending: boolean;
    /** Owner only, with at least one row changed for an existing chat. */
    canSaveChatSetup: boolean;
    /** Chooses (or changes to) an Assistant; the picker, strip and header call it. */
    choose(assistantId: string): void;
    /** Returns an unavailable or deleted binding to an ordinary chat. */
    continueWithout(): void;
    /** Copies the Assistant's entry link ("Copy link" in the header selector). */
    copyLink(assistantId: string): void;
    editById(assistantId: string): void;
    openLibrary(): void;
    openPicker: boolean;
    /** "Remove for this chat": the next messages go without the Assistant. */
    remove(): void;
    /** "Reset to Assistant" for one adjustable row. */
    resetRow(row: AssistantRowKey): void;
    /** Owner: restores an archived Assistant and re-reads it; absent inside a Project. */
    restore?(assistantId: string): void;
    /** "Save chat setup to Assistant" (owner). */
    saveChatSetup(): void;
    sendStarter(prompt: string): void;
    setPickerOpen(open: boolean): void;
    /** Changes one adjustable row for this chat; false when the row is fixed. */
    setRow<Key extends AssistantRowKey>(row: Key, value: ChatAssistantOverrideValues[Key]): boolean;
    startFromCurrentSetup(): void;
  };
  /** Personal Chat defaults in Studio; absent inside a Project. */
  chatDefaults?: {
    /** The Assistant every new personal chat starts with. */
    assistant?: {
      /** The saved default while it is available; null when none is saved or it is unavailable. */
      assistantId: string | null;
      /** Null until the user's Assistants list loads. */
      assistants: readonly AssistantSummary[] | null;
      assistantsState: "error" | "loading" | "ready";
      loadAssistants(): void;
      set(assistantId: string | null): void;
      /** A saved default that is no longer available; it is never applied. */
      unavailable: boolean;
    };
    /** The user's one image model for personal chats; Projects keep the organization default. */
    imageModel?: {
      /** Null until the published list first loads. */
      settings: UserImageModelSettings | null;
      loadState: "error" | "idle" | "loading" | "ready";
      saving: boolean;
      loadError: string | null;
      saveError: string | null;
      load(): void;
      /** A published model, or null to follow the organization default. */
      select(providerModelId: string | null): void;
    };
    knowledgePlan: KnowledgeSelection | null;
    mcpMode: ChatDefaultMcpMode;
    skillsMode?: "auto" | "off";
    searchPlan: SearchPlan;
    setKnowledgePlan(plan: KnowledgeSelection | null): void;
    setMcpMode(mode: ChatDefaultMcpMode): void;
    setSkillsMode?(mode: "auto" | "off"): void;
    setSearchPlan(plan: SearchPlan): void;
    resetSearchPlan?(): void;
    searchPreferenceSource?: "organization" | "personal";
  };
  currentModel: CatalogModel | undefined;
  currentParameterControls: ModelParameterControls;
  draft: string;
  knowledge: {
    bases: readonly ComposerConfigKnowledgeBase[];
    documentTotal: number | null;
    override(): void;
    planSource: ComposerKnowledgePlanSource;
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
  notificationSoundId: AnswerSoundId;
  notificationSoundReady: boolean;
  previewAnswerSound(sound: AnswerSoundId): Promise<boolean>;
  selectAnswerSound(sound: AnswerSoundId): void;
  operationError: string | null;
  operationErrorLive: boolean;
  operationErrorRetryable?: boolean;
  reasoningEffort: string;
  reasoningMode: string;
  retryCatalog(): void;
  searchPlanMode: SearchPlanMode;
  selectMcpMode(selection: McpRunSelection): void;
  selectModel(model: CatalogModel): void;
  selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  sending: boolean;
  /** Composer keyboard contract: Enter sends, or Ctrl/⌘+Enter when off. */
  sendWithEnter: boolean;
  setSendWithEnter(value: boolean): void;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  stopCurrentRun(expectedRunId?: string | null): Promise<void> | void;
  stopping?: boolean;
  streamMode: boolean;
  submitComposer(): Promise<void> | void;
  submitFollowup?(runId: string): Promise<void> | void;
  temperature: string;
  toggleCitationsVisibility(): void;
  toggleNotificationSound(): void;
  toggleReasoningBlockVisibility(): void;
  useOrganizationSearchDefault(): void;
  useOrganizationModelDefault?(): void;
  uploadFiles(files: FileList | readonly File[]): Promise<void> | void;
  reuseFile?(attachmentId: string, fileName: string): Promise<boolean>;
  uploading: boolean;
  uploadLimitHint?: string;
  workspace: {
    archive(): Promise<ThreadGeneratedFile | null>;
    available: boolean;
    busy: boolean;
    commandRunning: boolean;
    enabled: boolean;
    internetEnabled: boolean | null;
    loading: boolean;
    reset(): Promise<boolean>;
    sessionState: ChatWorkspaceState["sessionState"];
    setEnabled(value: boolean, reason?: "file_selection" | "user"): Promise<boolean>;
    unavailableReason?: WorkspaceUnavailableReason;
  };
};

export type ShellBranchesView = {
  close(): void;
  checkoutBranch(messageId: string): Promise<boolean>;
  error: string | null;
  graph: ChatBranchGraphWire | null;
  loading: boolean;
  open: boolean;
  retry(): void;
  show(): void;
};

export type ShellSettingsView = {
  studio?: import("@/features/library-v2/contracts").StudioNavigationV2;
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

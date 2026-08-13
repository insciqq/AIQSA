"use client";

import { ArchivedChatsDialog } from "@/components/app-shell/ArchivedChatsDialog";
import {
  ChatDeleteConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MessageDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { MemoryWorkspace } from "@/components/app-shell/MemoryWorkspace";
import { PermanentChatDeletionSurface } from "@/components/app-shell/PermanentChatDeletionSurface";
import { ProjectSettingsDialog } from "@/components/app-shell/ProjectSettingsDialog";
import { ShareDialog } from "@/components/app-shell/ShareDialog";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import {
  attachmentPolicyForModel,
  attachmentWarningsForModel
} from "@/components/app-shell/attachmentCapabilities";
import { calculateAttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import {
  openMemoryDetail,
  refreshMemoryList,
  useMemoryManagerStore
} from "@/components/app-shell/memoryManagerStore";
import {
  refreshMemorySettings,
  updateMemoryGate,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { updateUserMcpServer } from "@/components/app-shell/mcpSettingsApi";
import {
  refreshMcpSettings,
  useMcpSettingsStore
} from "@/components/app-shell/mcpSettingsStore";
import type {
  PowerAppShellV2Props,
  ShellComposerView
} from "@/components/app-shell/powerAppShellV2Contracts";
import { signOutCurrentSession } from "@/components/app-shell/sessionActions";
import type {
  Catalog,
  ChatSummary,
  PersistedRun,
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  attachmentBlocksFromThreadContent,
  textFromThreadContent
} from "@/components/app-shell/threadContent";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { AssistantLibrary } from "@/components/assistants/AssistantLibrary";
import { KnowledgeLibrary } from "@/components/knowledge/KnowledgeLibrary";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import {
  BranchDrawerV2,
  BranchPagerSlotV2,
  EditBranchStripV2
} from "@/features/branches-v2/BranchesV2";
import { AssistantPickerV2 } from "@/features/composer-v2/AssistantPickerV2";
import { ComposerV2 } from "@/features/composer-v2/ComposerV2";
import {
  ConversationTurnV2,
  ConversationV2,
  type ConversationMessageActionsV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import {
  EvidenceRowV2,
  EvidenceStackV2,
  KnowledgeEvidenceV2,
  ReasoningEvidenceV2,
  SearchEvidenceV2,
  ToolEvidenceV2
} from "@/features/evidence-v2/EvidenceV2";
import {
  MemoryActionConfirmationV2,
  MemoryEvidenceV2
} from "@/features/evidence-v2/MemoryEvidenceV2";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "@/features/library-v2/LibraryV2";
import type {
  AssistantSummaryV2,
  FileSummaryV2,
  KnowledgeSummaryV2,
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "@/features/library-v2/contracts";
import {
  ReadingRoomShellV2,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { ExactRunDetailsDrawerV2 } from "@/features/run-details-v2/RunDetailsV2";
import type { RunDetailsTargetV2 } from "@/features/run-details-v2/runDetailsModel";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import {
  presentRunLifecycleV2,
  settledRunPresentationV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { SettingsV2 } from "@/features/settings-v2/SettingsV2";
import { attachmentItemsForV2 } from "@/features/attachments-v2/attachmentPresentation";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire,
  ThreadArtifactSummary,
  ThreadRunEvidenceSummary
} from "@/lib/contracts/chats";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

const EMPTY_EVIDENCE_SUMMARY: ThreadRunEvidenceSummary = {
  fileCount: 0,
  hasUsage: false,
  sourceCount: 0,
  toolCallCount: 0
};

function messageText(message: ThreadMessage): string {
  return textFromThreadContent(message.content);
}

function persistedEvents(run: PersistedRun | null): RunEventView[] {
  return run?.events.map((event) => ({
    data: event.payload,
    type: event.eventType
  })) ?? [];
}

function assistantAnswerLabel(messages: readonly ThreadMessage[], messageId: string): string {
  const index = messages.filter((message) => message.role === "assistant")
    .findIndex((message) => message.id === messageId);
  return index >= 0 ? `Ответ ${index + 1}` : "Ответ";
}

function currentWorkspaceChat(chatId: string): ChatSummary | null {
  return useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId) ?? null;
}

function currentWorkspaceFolder(folderId: string) {
  return useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId) ?? null;
}

function scopeLabel(scope: Readonly<{ projectId?: string; type: string }>): string {
  if (scope.type === "GLOBAL_USER") return "Личная";
  if (scope.type === "PROJECT") return "Проект";
  return scope.type.toLocaleLowerCase().replaceAll("_", " ");
}

const opaqueUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type AnswerIdentityV2 = Readonly<{
  label: string;
  testId: "answer-assistant-identity" | "evidence-row-model";
}>;

/**
 * Optional quiet identity for the evidence row: the accepted Assistant
 * identity, otherwise the catalog-resolved model display name. Adapter ids,
 * raw model ids, and opaque UUIDs never render; when the catalog cannot
 * resolve a display name the item is simply omitted (Run details keeps the
 * exact historical binding).
 */
export function answerIdentityV2(
  catalog: Catalog | null,
  message: Pick<ThreadMessage, "assistantIdentity" | "modelId" | "provider">
): AnswerIdentityV2 | null {
  if (message.assistantIdentity) {
    return {
      label: `${message.assistantIdentity.name} · revision ${message.assistantIdentity.revisionNumber}`,
      testId: "answer-assistant-identity"
    };
  }
  const modelId = message.modelId;
  if (!modelId || opaqueUuidPattern.test(modelId)) return null;
  const models = catalog?.models ?? [];
  const provider = message.provider ?? null;
  const exact = models.find((model) =>
    model.modelId === modelId &&
    (!provider || model.provider === provider || model.providerFamily === provider)
  );
  const matches = exact
    ? [exact]
    : models.filter((model) => model.modelId === modelId || model.upstreamModelId === modelId);
  const names = new Set(matches.map((model) => model.displayName));
  return names.size === 1
    ? { label: matches[0]!.displayName, testId: "evidence-row-model" }
    : null;
}

export function LiveEvidenceV2({
  artifact,
  identity = null,
  locale,
  onOpenMemorySource,
  onOpenRunDetails,
  showReasoning,
  showTools,
  summary
}: Readonly<{
  artifact: ThreadArtifactSummary | null;
  identity?: AnswerIdentityV2 | null;
  locale: "EN" | "RU";
  onOpenMemorySource?(chatId: string): void;
  onOpenRunDetails(): void;
  showReasoning: boolean;
  showTools: boolean;
  summary: ThreadRunEvidenceSummary | null;
}>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const rowSummary = summary ?? EMPTY_EVIDENCE_SUMMARY;
  return (
    <div className="v2-live-evidence">
      <EvidenceRowV2
        identitySlot={identity ? (
          <span data-testid={identity.testId}>{identity.label}</span>
        ) : null}
        summary={rowSummary}
        onOpenRunDetails={onOpenRunDetails}
        onOpenSources={() => setSearchOpen(true)}
        onOpenTools={() => setToolsOpen(true)}
      />
      {artifact ? (
        <EvidenceStackV2>
          {artifact.searchCount > 0 ||
          (artifact.searchActivity?.length ?? 0) > 0 ||
          artifact.groundingDisplay?.provider === "gemini" ? (
            <SearchEvidenceV2
              open={searchOpen}
              summary={artifact}
              onOpenChange={setSearchOpen}
            />
          ) : null}
          <KnowledgeEvidenceV2 summary={artifact} />
          {showTools ? (
            <ToolEvidenceV2
              open={toolsOpen}
              toolCalls={artifact.toolCalls}
              onOpenChange={setToolsOpen}
            />
          ) : null}
          {showReasoning ? (
            // Persisted run events carry no timestamps, so no reasoning
            // duration is derivable; the header stays a plain "Reasoning".
            <ReasoningEvidenceV2 texts={artifact.reasoningText} />
          ) : null}
          {artifact.contextTruncation ? (
            <p className="v2-live-context-note">
              Контекст сокращён: {artifact.contextTruncation.droppedMessages} сообщений не вошли в запрос.
            </p>
          ) : null}
          {artifact.memoryReceipt ? (
            <MemoryEvidenceV2
              locale={locale}
              onOpenSourceChat={onOpenMemorySource}
              receipt={artifact.memoryReceipt}
            />
          ) : null}
          {artifact.memoryAction ? (
            <MemoryActionConfirmationV2 action={artifact.memoryAction} locale={locale} />
          ) : null}
        </EvidenceStackV2>
      ) : null}
    </div>
  );
}

export type RunSetupComposerV2 = Pick<
  ShellComposerView,
  | "backgroundMode"
  | "changeBackgroundMode"
  | "changeMaxOutputTokens"
  | "changeReasoningEffort"
  | "changeReasoningMode"
  | "changeStreamMode"
  | "changeTemperature"
  | "currentModel"
  | "currentParameterControls"
  | "maxOutputTokens"
  | "notificationSoundEnabled"
  | "reasoningEffort"
  | "reasoningMode"
  | "searchPlanMode"
  | "selectSearchPlan"
  | "selectedSearchOptionIds"
  | "showCitations"
  | "showReasoningBlocks"
  | "showToolActivity"
  | "streamMode"
  | "temperature"
  | "toggleCitationsVisibility"
  | "toggleNotificationSound"
  | "toggleReasoningBlockVisibility"
  | "toggleToolActivityVisibility"
  | "useOrganizationModelDefault"
  | "useOrganizationSearchDefault"
>;

function RunSetupSwitchV2({
  checked,
  label,
  stateLabels = ["On", "Off"],
  onToggle
}: Readonly<{
  checked: boolean;
  label: string;
  stateLabels?: readonly [string, string];
  onToggle(): void;
}>) {
  return (
    <button aria-checked={checked} role="switch" type="button" onClick={onToggle}>
      <span>{label}</span>
      <span className="v2-run-setup-switch-state">
        <strong>{checked ? stateLabels[0] : stateLabels[1]}</strong>
        <span aria-hidden="true" className="v2-run-setup-switch-track" />
      </span>
    </button>
  );
}

export function RunSetupV2({ composer, onClose }: Readonly<{
  composer: RunSetupComposerV2;
  onClose(): void;
}>) {
  const controls = composer.currentParameterControls;
  const [defaultsFeedback, setDefaultsFeedback] = useState<string | null>(null);
  const {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose });

  if (!portalReady) return null;

  return createPortal(
    <div className="v2-run-setup-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-label="Параметры модели"
        aria-modal="true"
        className="v2-run-setup"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <small>Следующий запуск</small>
            <h2>Параметры модели</h2>
          </div>
          <UiV2IconButton
            icon="close"
            label="Закрыть параметры"
            onClick={onClose}
            ref={initialFocusRef}
          />
        </header>
        <div className="v2-run-setup-body">
          <p className="v2-run-setup-current" data-testid="run-setup-current-model">
            Текущая модель:{" "}
            <strong>{composer.currentModel?.displayName ?? "Не выбрана"}</strong>
          </p>
          {controls.temperature.supported ? (
            <label>
              <span>Temperature</span>
              <input
                max={controls.temperature.maxValue}
                min={controls.temperature.minValue}
                step="0.1"
                type="number"
                value={composer.temperature}
                onChange={(event) => composer.changeTemperature(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>Max output tokens</span>
            <input
              max={controls.maxOutputTokens.maxValue}
              min="1"
              step="1"
              type="number"
              value={composer.maxOutputTokens}
              onChange={(event) => composer.changeMaxOutputTokens(event.target.value)}
            />
          </label>
          {controls.reasoningEffort.supported ? (
            <label>
              <span>Reasoning effort</span>
              <select
                value={composer.reasoningEffort}
                onChange={(event) => composer.changeReasoningEffort(event.target.value)}
              >
                {controls.reasoningEffort.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}
          {controls.reasoningMode?.supported ? (
            <label>
              <span>Reasoning mode</span>
              <select
                value={composer.reasoningMode}
                onChange={(event) => composer.changeReasoningMode(event.target.value)}
              >
                {controls.reasoningMode.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>Search orchestration</span>
            <select
              aria-label="Search orchestration"
              value={composer.searchPlanMode}
              onChange={(event) => composer.selectSearchPlan(
                composer.selectedSearchOptionIds,
                event.target.value === "model_choice" ? "model_choice" : "all_selected"
              )}
            >
              <option value="all_selected">All selected per search</option>
              <option value="model_choice">Model chooses</option>
            </select>
          </label>
          <div className="v2-run-setup-switches">
            {controls.stream.supported ? (
              <RunSetupSwitchV2
                checked={composer.streamMode}
                label="Streaming"
                onToggle={() => composer.changeStreamMode(!composer.streamMode)}
              />
            ) : null}
            {controls.background.supported ? (
              <RunSetupSwitchV2
                checked={composer.backgroundMode}
                label="Background"
                onToggle={() => composer.changeBackgroundMode(!composer.backgroundMode)}
              />
            ) : null}
            <RunSetupSwitchV2
              checked={composer.showCitations}
              label="Citations"
              stateLabels={["Shown", "Hidden"]}
              onToggle={composer.toggleCitationsVisibility}
            />
            <RunSetupSwitchV2
              checked={composer.showReasoningBlocks}
              label="Reasoning blocks"
              stateLabels={["Shown", "Hidden"]}
              onToggle={composer.toggleReasoningBlockVisibility}
            />
            <RunSetupSwitchV2
              checked={composer.showToolActivity}
              label="Tool activity"
              stateLabels={["Shown", "Hidden"]}
              onToggle={composer.toggleToolActivityVisibility}
            />
            <RunSetupSwitchV2
              checked={composer.notificationSoundEnabled}
              label="Completion sound"
              onToggle={composer.toggleNotificationSound}
            />
          </div>
          <div className="v2-run-setup-defaults">
            {composer.useOrganizationModelDefault ? (
              <UiV2Button onClick={() => {
                composer.useOrganizationModelDefault?.();
                setDefaultsFeedback("Теперь используется модель организации.");
              }}>
                Использовать модель организации
              </UiV2Button>
            ) : null}
            <UiV2Button onClick={() => {
              composer.useOrganizationSearchDefault();
              setDefaultsFeedback("Теперь используется Search организации.");
            }}>
              Использовать Search организации
            </UiV2Button>
            {defaultsFeedback ? (
              <p
                className="v2-run-setup-feedback"
                data-testid="run-setup-defaults-feedback"
                role="status"
              >
                {defaultsFeedback}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

export type TemporaryChatHeaderMemoryV2 = Readonly<{
  explanation: string;
  externalRetention: string;
  label: string;
  retention: string;
  retentionDeadline: string | null;
}>;

/**
 * The single sanctioned Temporary indication surface: a quiet header element
 * that exists only while the session is Temporary. Clicking it discloses the
 * retention explainer; normal chats render no permanent memory indicator.
 */
export function TemporaryChatIndicatorV2({ memory }: Readonly<{
  memory: TemporaryChatHeaderMemoryV2;
}>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <span
      className="v2-live-temporary"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="v2-live-temporary-trigger v2-focusable"
        data-testid="header-temporary-indicator"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <UiV2Icon name="memory" />
        {memory.label}
      </button>
      {open ? (
        <section
          aria-label={memory.label}
          className="v2-live-temporary-popover"
          role="dialog"
        >
          <p>{memory.explanation}</p>
          <p>{memory.retention}</p>
          {memory.retentionDeadline ? (
            <p data-testid="temporary-retention-deadline">{memory.retentionDeadline}</p>
          ) : null}
          <p>{memory.externalRetention}</p>
        </section>
      ) : null}
    </span>
  );
}

export type HeaderOverflowActionV2 = Readonly<{
  disabled?: boolean;
  label: string;
  onSelect(): void;
}>;

/**
 * Reusable header "⋯" menu. Below 900px it is the only route to the header
 * actions that the compact header hides, so it must never be removed without
 * a replacement; slice F extends this same menu on desktop. Dismissal follows
 * the shared wave-1 contract (Escape, outside pointer, focus-out).
 */
export function HeaderOverflowMenuV2({ actions, label }: Readonly<{
  actions: readonly HeaderOverflowActionV2[];
  label: string;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setOpen(false),
    open
  });

  return (
    <span className="v2-live-more">
      <UiV2IconButton
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="header-more-trigger"
        icon="more"
        label={label}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <UiV2MenuSurface
          className="v2-live-more-menu"
          data-testid="header-more-menu"
          label={label}
          ref={menuRef}
        >
          {actions.map((action) => (
            <UiV2MenuItem
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </UiV2MenuItem>
          ))}
        </UiV2MenuSurface>
      ) : null}
    </span>
  );
}

export function WorkspaceHeaderV2({
  active,
  accountEmail,
  adminEntryVisible,
  onArchived,
  onBranches,
  onCommands,
  onCopy,
  onExport,
  onLibrary,
  onSettings,
  onShare,
  shareDisabled,
  temporaryMemory,
  title
}: Readonly<{
  active: boolean;
  accountEmail: string | null;
  adminEntryVisible: boolean;
  onArchived(): void;
  onBranches(): void;
  onCommands(): void;
  onCopy(): void;
  onExport(): void;
  onLibrary(): void;
  onSettings(): void;
  onShare(): void;
  shareDisabled: boolean;
  temporaryMemory: TemporaryChatHeaderMemoryV2 | null;
  title: string;
}>) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const {
    menuRef: accountMenuRef,
    triggerRef: accountTriggerRef
  } = useMenuDismissalV2({
    onClose: () => setAccountOpen(false),
    open: accountOpen
  });
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    const result = await signOutCurrentSession();
    if (!result.ok) {
      setSignOutError(result.error);
      setSigningOut(false);
    }
  };

  return (
    <header className="v2-live-header">
      <div className="v2-live-title">
        <small>{active ? "Conversation" : "Reading Room"}</small>
        <h1>{title}</h1>
      </div>
      <div className="v2-live-header-actions">
        {temporaryMemory ? <TemporaryChatIndicatorV2 memory={temporaryMemory} /> : null}
        {active ? (
          <>
            <UiV2Button icon="copy" onClick={onCopy}>Копировать</UiV2Button>
            <UiV2Button icon="branch" onClick={onBranches}>Ветви</UiV2Button>
            <UiV2Button disabled={shareDisabled} onClick={onShare}>Поделиться</UiV2Button>
            <HeaderOverflowMenuV2
              label="Действия чата"
              actions={[
                { disabled: shareDisabled, label: "Поделиться", onSelect: onShare },
                { label: "Ветви", onSelect: onBranches },
                { label: "Копировать", onSelect: onCopy },
                { label: "Экспортировать", onSelect: onExport }
              ]}
            />
          </>
        ) : null}
        <UiV2IconButton icon="search" label="Команды" onClick={onCommands} />
        <span className="v2-live-account">
          <button
            aria-expanded={accountOpen}
            aria-label="Меню аккаунта"
            className="v2-live-account-trigger v2-focusable"
            ref={accountTriggerRef}
            type="button"
            onClick={() => setAccountOpen((open) => !open)}
          >
            {(accountEmail?.slice(0, 1) || "A").toLocaleUpperCase()}
          </button>
          {accountOpen ? (
            <UiV2MenuSurface
              className="v2-live-account-menu"
              label="Аккаунт"
              ref={accountMenuRef}
            >
              <p className="v2-live-account-label">{accountEmail ?? "AIQSA account"}</p>
              <UiV2MenuItem onClick={() => { setAccountOpen(false); onLibrary(); }}>Библиотека</UiV2MenuItem>
              <UiV2MenuItem onClick={() => { setAccountOpen(false); onArchived(); }}>Архив чатов</UiV2MenuItem>
              <UiV2MenuItem onClick={() => { setAccountOpen(false); onSettings(); }}>Настройки</UiV2MenuItem>
              {adminEntryVisible ? (
                <a className="v2-live-menu-link v2-focusable" href="/admin">Control Center</a>
              ) : null}
              <UiV2MenuItem disabled={signingOut} onClick={() => void signOut()}>
                {signingOut ? "Выходим…" : "Выйти"}
              </UiV2MenuItem>
              {signOutError ? <p className="v2-live-menu-error" role="alert">Не удалось выйти.</p> : null}
            </UiV2MenuSurface>
          ) : null}
        </span>
      </div>
    </header>
  );
}

function LibrarySurfaceV2({
  composer,
  onOpenMemoryOwner,
  props
}: Readonly<{
  composer: ShellComposerView;
  onOpenMemoryOwner(): void;
  props: PowerAppShellV2Props;
}>) {
  const { session, settings } = props;
  const memoryData = useMemorySettingsStore((state) => state.data);
  const memories = useMemoryManagerStore((state) => state.memories);
  const memoryBusy = useMemorySettingsStore((state) => state.busy);
  const assistantView = settings.library;
  const knowledgeView = settings.knowledge;
  const initialTab: LibraryTabIdV2 = settings.memory.open
    ? "memory"
    : knowledgeView
      ? "knowledge"
      : "assistants";

  const assistants: AssistantSummaryV2[] = (assistantView?.list.assistants ?? composer.assistant.pickerItems)
    .map((assistant) => ({
      archived: assistant.archived,
      available: assistant.availability.ok,
      description: assistant.description,
      id: assistant.id,
      name: assistant.name,
      owned: assistant.owned,
      pinned: assistant.pinned,
      revision: assistant.revisionNumber,
      ...(!assistant.availability.ok
        ? { unavailableReason: assistant.availability.reason.replaceAll("_", " ") }
        : {})
    }));
  const knowledge: KnowledgeSummaryV2[] = (knowledgeView?.list.knowledgeBases ?? composer.knowledge.bases)
    .map((base) => ({
      description: base.description,
      documentCount: 0,
      id: base.id,
      name: base.name,
      owned: base.owned,
      status: base.archived ? "archived" : "ready"
    }));
  const files: FileSummaryV2[] = composer.attachments.map((attachment) => ({
    id: attachment.id,
    kind: "upload",
    meta: typeof attachment.byteSize === "number" ? `${attachment.byteSize.toLocaleString()} bytes` : "Active chat upload",
    name: attachment.fileName,
    private: true,
    status: attachment.status === "failed"
      ? "failed"
      : attachment.status === "ready" || attachment.status === undefined
        ? "ready"
        : "processing"
  }));
  const memory: MemoryOverviewV2 = memoryData ? {
    administratorDisabled: !memoryData.capabilities.explicitMemory &&
      !memoryData.capabilities.historyRecall &&
      !memoryData.capabilities.automaticLearning,
    automaticLearning: memoryData.settings.learnAutomatically,
    explicitCrudAvailable: memoryData.capabilities.explicitMemory,
    facts: memories.filter((fact) => fact.factState === "ACTIVE" && fact.displayText).slice(0, 8).map((fact) => ({
      id: fact.id,
      pinned: fact.pinned,
      scope: scopeLabel(fact.scope),
      statement: fact.displayText ?? ""
    })),
    healthDetail: memoryData.egress.reviewRequired
      ? "Utility egress needs review before automatic work can continue."
      : `${memoryData.historyIndexing.completedChats} of ${memoryData.historyIndexing.totalChats} retained chats indexed.`,
    healthLabel: memoryData.egress.reviewRequired ? "Требуется проверка" : "Memory ready",
    referenceChatHistory: memoryData.settings.referenceChatHistory,
    useMemoryFacts: memoryData.settings.useMemoryFacts
  } : {
    administratorDisabled: false,
    automaticLearning: false,
    explicitCrudAvailable: false,
    facts: [],
    healthDetail: "Загружаю точное состояние Memory…",
    healthLabel: "Memory",
    referenceChatHistory: false,
    useMemoryFacts: false
  };
  const mutateMemory = (key: "learnAutomatically" | "referenceChatHistory" | "useMemoryFacts", value: boolean) => {
    if (memoryBusy) return;
    void updateMemoryGate(key, value).catch(() => undefined);
  };
  const tabs: LibraryTabV2[] = [
    {
      content: (
        <AssistantsPanelV2
          assistants={assistants}
          onArchiveToggle={(id, archived) => assistantView?.list.onArchiveToggle(id, archived)}
          onCreate={() => assistantView?.list.onNewAssistant()}
          onDuplicate={(id) => assistantView?.list.onDuplicate(id)}
          onOpen={(id) => assistantView?.list.onEdit(id)}
          onOpenHistory={(id) => assistantView?.list.onOpenHistory(id)}
          onPinToggle={(id, pinned) => assistantView?.list.onPinToggle(id, pinned)}
          onUse={(id) => assistantView?.list.onUse(id)}
        />
      ),
      id: "assistants",
      label: "Assistants"
    },
    {
      content: (
        <KnowledgePanelV2
          bases={knowledge}
          onCreate={() => knowledgeView?.list.onNewBase()}
          onOpen={(id) => knowledgeView?.list.onOpenBase(id)}
        />
      ),
      id: "knowledge",
      label: "Knowledge"
    },
    {
      content: <FilesPanelV2 files={files} generatedFilesEnabled={false} />,
      id: "files",
      label: "Файлы"
    },
    {
      content: (
        <MemoryPanelV2
          memory={memory}
          onChangeAutomaticLearning={(value) => mutateMemory("learnAutomatically", value)}
          onChangeReferenceHistory={(value) => mutateMemory("referenceChatHistory", value)}
          onChangeUseFacts={(value) => mutateMemory("useMemoryFacts", value)}
          onForget={(id) => {
            void openMemoryDetail(id).catch(() => undefined);
            onOpenMemoryOwner();
          }}
          onManage={onOpenMemoryOwner}
          onOpenHistory={onOpenMemoryOwner}
          onOpenOperations={onOpenMemoryOwner}
        />
      ),
      id: "memory",
      label: "Memory"
    }
  ];

  return (
    <>
      <LibraryV2
        key={initialTab}
        initialTab={initialTab}
        tabs={tabs}
        onBack={() => {
          assistantView?.onBackToChat();
          knowledgeView?.onBackToChat();
          settings.closeMemory();
        }}
        onTabChange={(tab) => {
          if (tab === "assistants") settings.openLibrary();
          if (tab === "knowledge") settings.openKnowledge();
          if (tab === "memory") settings.openMemory();
        }}
      />
      {assistantView && assistantView.task !== "list" ? (
        <AssistantLibrary view={assistantView} />
      ) : null}
      {knowledgeView && knowledgeView.task !== "list" ? (
        <KnowledgeLibrary view={knowledgeView} />
      ) : null}
      <span className="v2-sr-only">Account {session.accountId}</span>
    </>
  );
}

export function PowerAppShellV2View(props: PowerAppShellV2Props) {
  const { composer, details, overlays, session, settings, thread, workspace } = props;
  const [runDetailsTarget, setRunDetailsTarget] = useState<RunDetailsTargetV2 | null>(null);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [memoryOwnerOpen, setMemoryOwnerOpen] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [mcpKey, setMcpKey] = useState(0);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const mcpServers = useMcpSettingsStore((state) => state.servers);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const loadRunRef = useRef(thread.loadRunReceipt);
  const loadRun = useCallback((runId: string) => loadRunRef.current(runId), []);
  const libraryOpen = Boolean(settings.library || settings.knowledge || settings.memory.open);

  useEffect(() => {
    loadRunRef.current = thread.loadRunReceipt;
  }, [thread.loadRunReceipt]);
  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!settings.memory.open) return;
    void Promise.all([
      refreshMemorySettings().catch(() => null),
      refreshMemoryList().catch(() => undefined)
    ]);
  }, [settings.memory.open]);

  const config = useMemo<ComposerConfig | null>(() => composer.catalog ? ({
    assistants: composer.assistant.pickerItems,
    catalog: composer.catalog,
    knowledgeBases: composer.knowledge.bases.map((base) => ({
      archived: base.archived,
      description: base.description,
      id: base.id,
      name: base.name,
      owned: base.owned
    })),
    mcpServers: mcpServers.map((server) => ({
      description: server.description,
      enabled: server.enabled,
      id: server.id,
      knownToolCount: server.knownToolCount,
      name: server.name,
      readiness: server.readiness
    }))
  }) : null, [composer.assistant.pickerItems, composer.catalog, composer.knowledge.bases, mcpServers]);
  const attachmentItems = useMemo(
    () => attachmentItemsForV2(
      composer.attachments,
      attachmentWarningsForModel(composer.attachments, composer.currentModel)
    ),
    [composer.attachments, composer.currentModel]
  );
  const attachmentUsage = useMemo(
    () => calculateAttachmentLimitUsage(
      composer.attachments,
      composer.currentModel,
      composer.catalog?.attachmentLimits
    ),
    [composer.attachments, composer.catalog?.attachmentLimits, composer.currentModel]
  );
  const composerSurface = (
    <ComposerV2
      activeRun={thread.activeChatStreaming}
      assistantRemovedNotice={composer.assistant.removedNotice}
      attachmentItems={attachmentItems}
      attachmentLimitUsage={attachmentUsage}
      attachmentPolicy={attachmentPolicyForModel(composer.currentModel)}
      config={config}
      configError={Boolean(composer.catalogError)}
      contextStats={session.activeChatId ? composer.composerContextStats : null}
      disabledReason={composer.composerDisabledHint}
      draft={composer.draft}
      editStatusSlot={thread.editingMessageId ? (
        <EditBranchStripV2
          error={composer.operationError}
          pending={thread.editingMessagePending}
          onCancel={composer.composerActions.cancelMessageEdit}
        />
      ) : null}
      hasReadyAttachments={attachmentItems.some((item) => item.status === "ready")}
      onAttachmentCountLimitExceeded={composer.composerActions.rejectAttachmentCount}
      onDismissAssistantRemovedNotice={composer.assistant.clearRemovedNotice}
      onDraftChange={composer.composerActions.changeDraft}
      onMakeModelDefault={composer.makeModelDefault}
      onOpenAssistantPicker={() => composer.assistant.setPickerOpen(true)}
      onOpenMcpSettings={settings.openMcp}
      onOpenModelParameters={() => setRunSetupOpen(true)}
      onRemoveAssistant={composer.assistant.remove}
      onRemoveAttachment={composer.composerActions.removeAttachment}
      onRejectedFiles={(files) => composer.composerActions.rejectAttachments(files.map((file) => file.name))}
      onRetryAttachment={composer.composerActions.retryAttachment}
      onRetryConfig={composer.retryCatalog}
      onSelectKnowledgeBaseIds={composer.knowledge.select}
      onSelectModel={composer.selectModel}
      onSelectSearchOptionIds={(ids) => composer.selectSearchPlan(ids, composer.searchPlanMode)}
      onSend={() => void composer.submitComposer()}
      onStop={() => void composer.stopCurrentRun()}
      onToggleMcpServer={(serverId, enabled) => {
        void updateUserMcpServer(serverId, { enabled }).then((server) => {
          useMcpSettingsStore.getState().replaceServer(server);
        }).catch(() => settings.openMcp());
      }}
      onUploadFiles={(files) => composer.uploadFiles(files)}
      runId={thread.currentRunId}
      selectedAssistant={composer.assistant.selected}
      selectedKnowledgeBaseIds={composer.knowledge.selectedBaseIds}
      selectedModelId={composer.selectedModelId}
      selectedProvider={composer.selectedProvider}
      selectedSearchOptionIds={composer.selectedSearchOptionIds}
      uploading={composer.uploading}
      usageStats={composer.composerUsageStats}
    />
  );
  const assistantOrientation = composer.assistant.selected &&
    !composer.draft.trim() &&
    composer.attachments.length === 0 &&
    !composer.uploading ? (
      <div className="v2-live-assistant-intro" data-testid="assistant-blank-intro">
        <AssistantAvatarV2 recipe={composer.assistant.selected.avatar} size={64} />
        <p>Assistant</p>
        <h1>{composer.assistant.selected.name}</h1>
        {composer.assistant.selected.description ? (
          <span>{composer.assistant.selected.description}</span>
        ) : null}
        {composer.assistant.selected.starterPrompts.length > 0 ? (
          <div
            className="v2-live-assistant-starters"
            data-testid="assistant-starter-prompts"
            aria-label="Starter prompts"
          >
            {composer.assistant.selected.starterPrompts.slice(0, 4).map((prompt) => (
              <button
                className="v2-focusable"
                key={prompt}
                type="button"
                onClick={() => composer.assistant.sendStarter(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : undefined;
  const messageById = new Map(thread.visibleMessages.map((message) => [message.id, message]));
  const conversationMessages: ConversationMessageV2[] = thread.visibleMessages.map((message) => ({
    content: messageText(message),
    id: message.id,
    role: message.role,
    streaming: message.status === "streaming"
  }));

  useEffect(() => {
    const dock = composerDockRef.current;
    if (!dock) {
      setComposerDockHeight(0);
      return;
    }
    const updateHeight = () => setComposerDockHeight(Math.ceil(dock.getBoundingClientRect().height));
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [conversationMessages.length]);

  const actionsFor = (message: ThreadMessage): ConversationMessageActionsV2 => {
    const mutationBlocked = thread.activeChatStreaming;
    const disabledReason = mutationBlocked ? "Дождитесь завершения текущего ответа." : null;
    return {
      branchDisabled: mutationBlocked,
      deleteDisabled: mutationBlocked,
      disabledReason,
      editDisabled: mutationBlocked,
      onBranchFromHere: () => thread.handleBranchFromMessage(message.id),
      onCopy: () => thread.handleCopyMessage(message),
      onDelete: () => thread.handleDeleteMessage(message.id),
      ...(message.role === "user" ? {
        onEdit: () => thread.handleEditMessage(message)
      } : {
        onRegenerate: () => thread.handleRegenerateMessage(message.id),
        regenerateDisabled: mutationBlocked
      })
    };
  };

  const renderMessage = (message: ConversationMessageV2): ReactNode => {
    const source = messageById.get(message.id);
    if (!source) return null;
    const actions = actionsFor(source);
    // Always-visible ‹N/M› version pager beside the action dock for any
    // message with committed siblings; switching versions is a checkout of the
    // existing branch model, never a history edit.
    const pagerSlot = (
      <BranchPagerSlotV2
        disabledReason={thread.activeChatStreaming ? "Дождитесь завершения текущего ответа." : null}
        graph={details.branchGraph}
        messageId={source.id}
        onCheckout={details.checkoutBranch}
      />
    );
    if (source.role === "user") {
      // Owner-only quiet line of the files sent with this exact message,
      // rendered from the labels the thread snapshot already exposes.
      const sentAttachments = attachmentBlocksFromThreadContent(source.content);
      return (
        <ConversationTurnV2
          actions={actions}
          afterContent={(
            <>
              <SentAttachmentsV2 blocks={sentAttachments} />
              {pagerSlot}
            </>
          )}
          anchorId={source.id}
          content={messageText(source)}
          role="user"
        />
      );
    }
    const run = source.runId
      ? thread.persistedRunsById[source.runId] ?? (thread.lastRun?.id === source.runId ? thread.lastRun : null)
      : null;
    const events = source.runId === thread.currentRunId ? details.events : persistedEvents(run);
    const artifact = source.runId === thread.currentRunId
      ? thread.liveArtifactSummary ?? source.artifactSummary ?? null
      : source.artifactSummary ?? null;
    const target = source.runId ? {
      answerLabel: assistantAnswerLabel(thread.visibleMessages, source.id),
      assistantMessageId: source.id,
      runId: source.runId
    } satisfies RunDetailsTargetV2 : null;
    const presentation = presentRunLifecycleV2({
      authoritativeMessageStatus: source.status === "streaming" ? null : source.status,
      connectionLost: source.status === "streaming" && !thread.activeChatStreaming && Boolean(run),
      content: messageText(source),
      events,
      runId: source.runId ?? null,
      status: run?.status ?? (source.status === "streaming" ? "streaming" : source.status)
    });
    // A live run shows only its honest status line (plus Stop in the
    // composer): no action dock, no evidence row, and never a raw run or
    // request id. The settled answer gets exactly one muted evidence row —
    // non-zero counters, optional catalog-resolved identity, and Run details
    // as an ordinary item — plus the collapsed disclosures. Token counts live
    // only in the Run details drawer.
    const settled = settledRunPresentationV2(presentation);
    return (
      <RunAnswerV2
        actions={settled ? actions : undefined}
        actionsSlot={settled ? (
          <>
            {target ? (
              <LiveEvidenceV2
                artifact={artifact}
                identity={answerIdentityV2(composer.catalog, source)}
                locale={composer.memory.locale}
                onOpenMemorySource={thread.openMemorySourceChat}
                showReasoning={composer.showReasoningBlocks}
                showTools={composer.showToolActivity}
                summary={source.evidenceSummary ?? null}
                onOpenRunDetails={() => setRunDetailsTarget(target)}
              />
            ) : null}
            {pagerSlot}
          </>
        ) : pagerSlot}
        anchorId={source.id}
        content={messageText(source)}
        onRefresh={() => source.runId ? thread.loadRunReceipt(source.runId) : null}
        onRegenerate={() => thread.handleRegenerateMessage(source.id)}
        onRetry={() => thread.handleRegenerateMessage(source.id)}
        onSelectModel={() => setRunSetupOpen(true)}
        presentation={presentation}
      />
    );
  };

  const selectNavigationChat = (chat: ChatNavigationSummaryWire) => {
    const full = currentWorkspaceChat(chat.id);
    if (full) workspace.pane.actions.activateChat(full);
    else void workspace.pane.actions.retry();
  };
  const setNavigationMemoryMode = (chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL") => {
    const full = currentWorkspaceChat(chat.id);
    if (full && full.memoryMode !== mode) void workspace.pane.actions.toggleChatMemorySource(full);
  };
  const createNavigationChat = (mode: NewChatMode) => {
    void workspace.pane.actions.createChat(null, mode);
  };

  return (
    <main className="v2-live-root" data-testid="app-shell" data-ui-version="v2">
      <UiV2IconSprite />
      {libraryOpen ? (
        <LibrarySurfaceV2 composer={composer} props={props} onOpenMemoryOwner={() => setMemoryOwnerOpen(true)} />
      ) : (
        <ReadingRoomShellV2
          accountLabel={session.accountEmail}
          editingChatId={workspace.pane.state.editingChatId}
          editingChatTitle={workspace.pane.state.editingChatTitle}
          editingFolderId={workspace.pane.state.editingFolderId}
          editingFolderName={workspace.pane.state.editingFolderName}
          onArchive={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            // A stale workspace projection must resync instead of silently
            // ignoring the requested archive.
            if (full) void workspace.pane.actions.deleteChat(full);
            else void workspace.pane.actions.retry();
          }}
          onArchivedChats={workspace.pane.actions.openArchivedChats}
          onCancelChatRename={workspace.pane.actions.cancelChatEdit}
          onCancelFolderRename={workspace.pane.actions.cancelFolderEdit}
          onChangeChatRename={workspace.pane.actions.changeEditingChatTitle}
          onChangeFolderRename={workspace.pane.actions.changeEditingFolderName}
          onCreateFolder={(parentId, name) => workspace.pane.actions.createFolder(parentId, name)}
          onDeleteFolder={(folder: ChatNavigationFolderWire) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) void workspace.pane.actions.deleteFolder(full);
            else void workspace.pane.actions.retry();
          }}
          onExport={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.exportChat(full);
          }}
          onFavorite={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.toggleChatFavorite(full);
          }}
          onFolderProjectSettings={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) workspace.pane.actions.openProjectSettings(full);
          }}
          onLibrary={settings.openLibrary}
          onMemoryMode={setNavigationMemoryMode}
          onMove={(chat, folderId) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.moveChat(full.id, folderId);
          }}
          onMoveFolder={(folder, folderId) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) void workspace.pane.actions.moveFolder(full, folderId);
          }}
          onNewChat={createNavigationChat}
          onRenameChat={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) workspace.pane.actions.startChatEdit(full);
          }}
          onRenameFolder={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            if (full) workspace.pane.actions.startFolderEdit(full);
          }}
          onSaveChatRename={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            return full ? workspace.pane.actions.saveChatTitle(full) : undefined;
          }}
          onSaveFolderRename={(folder) => {
            const full = currentWorkspaceFolder(folder.id);
            return full ? workspace.pane.actions.saveFolder(full) : undefined;
          }}
          onSelectChat={selectNavigationChat}
          onShare={(chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.shareChat(full);
          }}
          onSettings={settings.open}
        >
          <section className="v2-live-workspace">
            <WorkspaceHeaderV2
              active={Boolean(session.activeChatId)}
              accountEmail={session.accountEmail}
              adminEntryVisible={session.adminEntryVisible}
              onArchived={workspace.pane.actions.openArchivedChats}
              onBranches={() => details.open("branch")}
              onCommands={overlays.palette.show}
              onCopy={() => void thread.copyVisibleThread()}
              onExport={() => {
                const chatId = session.activeChatId;
                const full = chatId ? currentWorkspaceChat(chatId) : null;
                if (full) workspace.pane.actions.exportChat(full);
              }}
              onLibrary={settings.openLibrary}
              onSettings={settings.open}
              onShare={() => void session.shareActiveBranch()}
              shareDisabled={composer.memory.mode === "TEMPORARY"}
              temporaryMemory={composer.memory.mode === "TEMPORARY" ? composer.memory : null}
              title={session.activeChatId ? session.activeChatTitle : "Над чем поработаем?"}
            />
            {session.notice ? (
              <div className="v2-live-notice">
                <ShellNotice notice={session.notice} onDismiss={session.dismissNotice} />
              </div>
            ) : null}
            <ConversationV2
              composerSlot={conversationMessages.length === 0 ? composerSurface : undefined}
              error={thread.activeChatDetailError}
              hasOlder={thread.hasOlderMessages}
              jumpToLatestBottomOffset={composerDockHeight}
              loading={thread.activeChatDetailLoading || workspace.pane.state.workspaceLoading}
              loadingEarlier={thread.loadingOlderMessages}
              messages={conversationMessages}
              olderError={thread.olderMessagesError}
              onJumpToLatest={thread.jumpToLatest}
              onLoadEarlier={thread.loadEarlierMessages}
              onRetry={thread.retryActiveChatDetail}
              onScroll={thread.handleThreadScroll}
              orientationSlot={assistantOrientation}
              renderMessage={renderMessage}
              scrollRef={thread.threadScrollRef}
              showJumpToLatest={thread.showJumpToLatest}
              unavailable={Boolean(thread.activeChatDetailError && session.activeChatId && !thread.activeChatDetailLoading)}
            />
            {conversationMessages.length > 0 ? (
              <div className="v2-live-composer-dock" ref={composerDockRef}>
                {composer.operationError ? (
                  <p className="v2-live-composer-error" role={composer.operationErrorLive ? "alert" : "status"}>
                    {composer.operationError}
                  </p>
                ) : null}
                {composerSurface}
              </div>
            ) : null}
          </section>
        </ReadingRoomShellV2>
      )}

      {details.activeTab === "branch" && details.mode !== "closed" ? (
        <BranchDrawerV2
          checkoutDisabledReason={thread.activeChatStreaming ? "Дождитесь завершения текущего ответа." : null}
          error={details.branchError}
          graph={details.branchGraph}
          loading={details.branchLoading}
          onCheckout={(leafId) => {
            details.checkoutBranch(leafId);
            return true;
          }}
          onClose={() => details.changeMode("closed")}
          onRetry={details.retryBranches}
        />
      ) : null}
      {runDetailsTarget ? (
        <ExactRunDetailsDrawerV2
          cachedRun={thread.persistedRunsById[runDetailsTarget.runId] ?? null}
          catalog={composer.catalog}
          loadRun={loadRun}
          target={runDetailsTarget}
          onClose={() => setRunDetailsTarget(null)}
          onOpenMemorySource={thread.openMemorySourceChat}
        />
      ) : null}
      {runSetupOpen ? <RunSetupV2 composer={composer} onClose={() => setRunSetupOpen(false)} /> : null}
      {composer.assistant.openPicker ? (
        <AssistantPickerV2
          assistants={composer.assistant.pickerItems}
          loading={composer.assistant.pickerLoading}
          onClose={() => composer.assistant.setPickerOpen(false)}
          onCreateFromCurrentSetup={composer.assistant.startFromCurrentSetup}
          onManage={() => {
            composer.assistant.setPickerOpen(false);
            composer.assistant.openLibrary();
          }}
          onRemove={composer.assistant.selected ? () => {
            composer.assistant.setPickerOpen(false);
            composer.assistant.remove();
          } : null}
          onSelect={composer.assistant.selectById}
          recentIds={composer.assistant.recentIds}
          selectedAssistantId={composer.assistant.selected?.id ?? null}
        />
      ) : null}

      {settings.settings.open && !libraryOpen ? (
        <SettingsV2
          busy={mcpBusy}
          dirty={mcpDirty}
          initialSection={settings.settings.section}
          mcpContent={(
            <McpSettingsSection
              key={mcpKey}
              onBusyChange={setMcpBusy}
              onDirtyChange={setMcpDirty}
            />
          )}
          noticeSlot={settings.notice ? (
            <ShellNotice notice={settings.notice} onDismiss={settings.dismissNotice} />
          ) : null}
          themeId={settings.settings.themeId}
          onClose={() => {
            settings.dismissNotice();
            settings.closeSettings();
          }}
          onDiscard={() => {
            setMcpDirty(false);
            setMcpKey((value) => value + 1);
          }}
          onThemeChange={settings.updateTheme}
        />
      ) : null}
      {memoryOwnerOpen ? (
        <MemoryWorkspace
          accountId={session.accountId}
          notice={settings.notice}
          onClose={() => setMemoryOwnerOpen(false)}
          onDismissNotice={settings.dismissNotice}
          onOpenMemorySource={settings.openMemorySourceChat}
        />
      ) : null}
      {overlays.share.target ? (
        <ShareDialog key={overlays.share.target.chat.id} target={overlays.share.target} onClose={overlays.share.close} />
      ) : null}
      {workspace.projectSettings.folder ? (
        <ProjectSettingsDialog
          folder={workspace.projectSettings.folder}
          knowledgeBaseIds={workspace.projectSettings.knowledgeBaseIds}
          knowledgeBases={workspace.projectSettings.knowledgeBases}
          knowledgeDataError={workspace.projectSettings.knowledgeDataError}
          knowledgeDataState={workspace.projectSettings.knowledgeDataState}
          memoryDraft={workspace.projectSettings.draft}
          saving={workspace.pane.state.folderActionId === workspace.projectSettings.folder.id}
          onCancel={workspace.projectSettings.close}
          onKnowledgeBaseIdsChange={workspace.projectSettings.changeKnowledgeBaseIds}
          onMemoryDraftChange={workspace.projectSettings.changeDraft}
          onRetryKnowledge={workspace.projectSettings.retryKnowledge}
          onSave={() => {
            const folder = workspace.projectSettings.folder;
            if (folder) void workspace.projectSettings.save(folder);
          }}
        />
      ) : null}
      {workspace.archived.open ? (
        <ArchivedChatsDialog locale={composer.memory.locale} onRestored={workspace.archived.onRestored} />
      ) : null}
      {overlays.confirmations.chat ? (
        <ChatDeleteConfirmationDialog
          chatTitle={overlays.confirmations.chat.title}
          locale={composer.memory.locale}
          onCancel={overlays.confirmations.cancelChat}
          onConfirm={overlays.confirmations.confirmChat}
        />
      ) : null}
      {overlays.confirmations.folder ? (
        <FolderDeleteConfirmationDialog
          folderName={overlays.confirmations.folder.name}
          onCancel={overlays.confirmations.cancelFolder}
          onConfirm={overlays.confirmations.confirmFolder}
        />
      ) : null}
      {overlays.confirmations.message ? (
        <MessageDeleteConfirmationDialog
          onCancel={overlays.confirmations.cancelMessage}
          onConfirm={overlays.confirmations.confirmMessage}
        />
      ) : null}
      <PermanentChatDeletionSurface locale={composer.memory.locale} />
      {overlays.palette.open ? (
        <CommandPalette items={overlays.palette.items} onClose={overlays.palette.close} onRun={overlays.palette.run} />
      ) : null}
    </main>
  );
}

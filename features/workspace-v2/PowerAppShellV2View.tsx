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
  WorkspaceChatSummary,
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
  AnswerOutputsV2
} from "@/features/answer-outputs-v2/AnswerOutputsV2";
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
  flattenFolderTree,
  ReadingRoomShellV2,
  type NavigationChatRowState,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import {
  presentRunLifecycleV2,
  settledRunPresentationV2
} from "@/features/run-lifecycle-v2/runPresentation";
import { documentTitleV2 } from "@/features/workspace-v2/documentTitle";
import {
  runTransportStateV2,
  transportLostForMessageV2
} from "@/features/workspace-v2/runTransportPresentation";
import { SettingsV2 } from "@/features/settings-v2/SettingsV2";
import { attachmentItemsForV2 } from "@/features/attachments-v2/attachmentPresentation";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

function messageText(message: ThreadMessage): string {
  return textFromThreadContent(message.content);
}

function currentWorkspaceChat(chatId: string): WorkspaceChatSummary | null {
  return useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId) ?? null;
}

function currentWorkspaceFolder(folderId: string) {
  return useWorkspaceStore.getState().folders.find((folder) => folder.id === folderId) ?? null;
}

function scopeLabel(scope: Readonly<{ projectId?: string; type: string }>): string {
  if (scope.type === "GLOBAL_USER") return "Personal";
  if (scope.type === "PROJECT") return "Project";
  return scope.type.toLocaleLowerCase().replaceAll("_", " ");
}

export type AnswerIdentityV2 = Readonly<{
  label: string;
  testId: "answer-assistant-identity";
}>;

/**
 * Optional quiet accepted Assistant identity. Ordinary answers stay neutral:
 * provider, adapter, raw model, and opaque ids never become answer chrome.
 */
export function answerIdentityV2(
  message: Pick<ThreadMessage, "assistantIdentity">
): AnswerIdentityV2 | null {
  if (message.assistantIdentity) {
    return {
      label: `${message.assistantIdentity.name} · revision ${message.assistantIdentity.revisionNumber}`,
      testId: "answer-assistant-identity"
    };
  }
  return null;
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
  | "streamMode"
  | "temperature"
  | "toggleCitationsVisibility"
  | "toggleNotificationSound"
  | "toggleReasoningBlockVisibility"
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
        aria-label="Model parameters"
        aria-modal="true"
        className="v2-run-setup"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <small>Applies to your next message</small>
            <h2>Model parameters</h2>
          </div>
          <UiV2IconButton
            icon="close"
            label="Close parameters"
            onClick={onClose}
            ref={initialFocusRef}
          />
        </header>
        <div className="v2-run-setup-body">
          <p className="v2-run-setup-current" data-testid="run-setup-current-model">
            Current model:{" "}
            <strong>{composer.currentModel?.displayName ?? "Not selected"}</strong>
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
              checked={composer.notificationSoundEnabled}
              label="Completion sound"
              onToggle={composer.toggleNotificationSound}
            />
          </div>
          <div className="v2-run-setup-defaults">
            {composer.useOrganizationModelDefault ? (
              <UiV2Button onClick={() => {
                composer.useOrganizationModelDefault?.();
                setDefaultsFeedback("Organization model default applied.");
              }}>
                Use organization model default
              </UiV2Button>
            ) : null}
            <UiV2Button onClick={() => {
              composer.useOrganizationSearchDefault();
              setDefaultsFeedback("Organization Search default applied.");
            }}>
              Use organization Search default
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

export type HeaderOverflowSubmenuItemV2 = Readonly<{
  depth?: number;
  label: string;
  onSelect(): void;
}>;

export type HeaderOverflowActionV2 = Readonly<{
  disabled?: boolean;
  label: string;
  /** Rendered only below 900px via CSS; e.g. Share joins the menu there. */
  mobileOnly?: boolean;
  onSelect?(): void;
  /** Inline disclosure list (folder picker); scrolls locally when long. */
  submenu?: readonly HeaderOverflowSubmenuItemV2[];
}>;

/**
 * The single header "⋯" menu on every width. Below 900px it is the only route
 * to the header actions the compact header hides, so it must never be removed
 * without a replacement. Dismissal follows the shared wave-1 contract (Escape,
 * outside pointer, focus-out).
 */
export function HeaderOverflowMenuV2({ actions, label }: Readonly<{
  actions: readonly HeaderOverflowActionV2[];
  label: string;
}>) {
  const [open, setOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setOpenSubmenu(null);
  };
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: close,
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
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open ? (
        <UiV2MenuSurface
          className="v2-live-more-menu"
          data-testid="header-more-menu"
          label={label}
          ref={menuRef}
        >
          {actions.map((action) => (
            <Fragment key={action.label}>
              <UiV2MenuItem
                data-mobile-only={action.mobileOnly ? "" : undefined}
                disabled={action.disabled}
                {...(action.submenu ? { "aria-expanded": openSubmenu === action.label } : {})}
                onClick={() => {
                  if (action.submenu) {
                    setOpenSubmenu((current) => current === action.label ? null : action.label);
                    return;
                  }
                  close();
                  action.onSelect?.();
                }}
              >
                {action.label}
              </UiV2MenuItem>
              {action.submenu && openSubmenu === action.label ? (
                <div aria-label={action.label} className="v2-live-more-submenu">
                  {action.submenu.map((item, index) => (
                    <UiV2MenuItem
                      key={`${item.label}-${index}`}
                      style={{ paddingLeft: `${0.5 + (item.depth ?? 0) * 0.75}rem` }}
                      onClick={() => {
                        close();
                        item.onSelect();
                      }}
                    >
                      {item.label}
                    </UiV2MenuItem>
                  ))}
                </div>
              ) : null}
            </Fragment>
          ))}
        </UiV2MenuSurface>
      ) : null}
    </span>
  );
}

export type WorkspaceHeaderFolderV2 = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
}>;

export function WorkspaceHeaderV2({
  active,
  accountEmail,
  adminEntryVisible,
  archiveDisabled = false,
  deleteDisabled = false,
  editingTitle = null,
  folders = [],
  onArchive,
  onBranches,
  onCommands,
  onCopyThread,
  onDelete = null,
  onExport,
  onLibrary,
  onMove,
  onRenameCancel,
  onRenameChange,
  onRenameSave,
  onRenameStart,
  onSettings,
  onShare,
  shareDisabled,
  temporaryMemory,
  title
}: Readonly<{
  active: boolean;
  accountEmail: string | null;
  adminEntryVisible: boolean;
  archiveDisabled?: boolean;
  deleteDisabled?: boolean;
  /** Non-null while the header title is being renamed inline. */
  editingTitle?: string | null;
  folders?: readonly WorkspaceHeaderFolderV2[];
  onArchive(): void;
  onBranches(): void;
  onCommands(): void;
  onCopyThread(): void;
  /** Null hides "Delete…" entirely (no `permanentChatDeletionAvailable`). */
  onDelete?: (() => void) | null;
  onExport(format: "json" | "markdown"): void;
  onLibrary(): void;
  onMove(folderId: string | null): void;
  onRenameCancel(): void;
  onRenameChange(value: string): void;
  onRenameSave(): void;
  onRenameStart(): void;
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
  // S1 §4.3: the header carries no kicker; for an active chat the right side
  // is Share plus one "⋯" menu. Share additionally joins the menu below
  // 900px, where the Share text button collapses.
  const overflowActions: HeaderOverflowActionV2[] = [
    { disabled: shareDisabled, label: "Share", mobileOnly: true, onSelect: onShare },
    { label: "Rename", onSelect: onRenameStart },
    {
      label: "Move to…",
      submenu: [
        { label: "No folder", onSelect: () => onMove(null) },
        ...flattenFolderTree(folders).map(({ depth, folder }) => ({
          depth,
          label: folder.name,
          onSelect: () => onMove(folder.id)
        }))
      ]
    },
    { disabled: archiveDisabled, label: "Archive", onSelect: onArchive },
    ...(onDelete
      ? [{ disabled: deleteDisabled, label: "Delete…", onSelect: onDelete }]
      : []),
    { label: "Export", onSelect: () => onExport("markdown") },
    { label: "Export as JSON", onSelect: () => onExport("json") },
    { label: "Copy entire thread", onSelect: onCopyThread },
    { label: "Branches", onSelect: onBranches }
  ];

  return (
    <header className="v2-live-header">
      <div className="v2-live-title">
        {/* The welcome screen keeps a quiet empty header: actions only. */}
        {active ? (
          editingTitle !== null ? (
            <form
              className="v2-live-title-rename"
              onSubmit={(event) => {
                event.preventDefault();
                onRenameSave();
              }}
            >
              <input
                autoFocus
                aria-label={`New title: ${title}`}
                maxLength={120}
                value={editingTitle}
                onChange={(event) => onRenameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onRenameCancel();
                  }
                }}
              />
              <UiV2IconButton icon="check" label="Save title" type="submit" />
              <UiV2IconButton icon="close" label="Cancel rename" onClick={onRenameCancel} />
            </form>
          ) : (
            <h1>
              <button
                className="v2-live-title-button v2-focusable"
                data-testid="header-title"
                title="Rename chat"
                type="button"
                onClick={onRenameStart}
              >
                {title}
              </button>
            </h1>
          )
        ) : null}
      </div>
      <div className="v2-live-header-actions">
        {temporaryMemory ? <TemporaryChatIndicatorV2 memory={temporaryMemory} /> : null}
        {active ? (
          <>
            <UiV2Button disabled={shareDisabled} onClick={onShare}>Share</UiV2Button>
            <HeaderOverflowMenuV2 label="Chat actions" actions={overflowActions} />
          </>
        ) : null}
        <UiV2IconButton icon="search" label="Commands" onClick={onCommands} />
        <span className="v2-live-account">
          <button
            aria-expanded={accountOpen}
            aria-label="Account menu"
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
              label="Account"
              ref={accountMenuRef}
            >
              <p className="v2-live-account-label">{accountEmail ?? "AIQSA account"}</p>
              <UiV2MenuItem onClick={() => { setAccountOpen(false); onLibrary(); }}>Library</UiV2MenuItem>
              {/* "Archived chats" lives only in the sidebar: one archive entry total. */}
              <UiV2MenuItem onClick={() => { setAccountOpen(false); onSettings(); }}>Settings</UiV2MenuItem>
              {adminEntryVisible ? (
                <a className="v2-live-menu-link v2-focusable" href="/admin">Control Center</a>
              ) : null}
              <UiV2MenuItem disabled={signingOut} onClick={() => void signOut()}>
                {signingOut ? "Signing out…" : "Sign out"}
              </UiV2MenuItem>
              {signOutError ? <p className="v2-live-menu-error" role="alert">Could not sign out.</p> : null}
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
    healthLabel: memoryData.egress.reviewRequired ? "Review required" : "Memory ready",
    referenceChatHistory: memoryData.settings.referenceChatHistory,
    useMemoryFacts: memoryData.settings.useMemoryFacts
  } : {
    administratorDisabled: false,
    automaticLearning: false,
    explicitCrudAvailable: false,
    facts: [],
    healthDetail: "Loading exact Memory status…",
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
      label: "Files"
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

export const WELCOME_STARTER_PROMPTS = [
  "Explain a complex topic in simple terms",
  "Turn my notes into a work plan",
  "Compare options and recommend one"
] as const;

/**
 * Blank-welcome starter prompts render exactly while the canvas is a quiet
 * greeting: no selected Assistant (that intro owns its own starters), nothing
 * typed, no attachments in flight.
 */
export function blankWelcomeStartersVisibleV2({
  assistantSelected,
  attachmentCount,
  draft,
  uploading
}: Readonly<{
  assistantSelected: boolean;
  attachmentCount: number;
  draft: string;
  uploading: boolean;
}>): boolean {
  return !assistantSelected && !draft.trim() && attachmentCount === 0 && !uploading;
}

/**
 * S1 §5.2 welcome: a quiet greeting plus up to four unobtrusive prompts —
 * no canvas wordmark, no marketing subtitle. Prompt clicks prefill the draft;
 * the optional last entry opens the Assistant picker.
 */
export function WelcomeOrientationV2({
  onOpenAssistantPicker,
  onPickPrompt,
  showAssistantEntry
}: Readonly<{
  onOpenAssistantPicker(): void;
  onPickPrompt(prompt: string): void;
  showAssistantEntry: boolean;
}>) {
  return (
    <div className="v2-live-welcome" data-testid="welcome-orientation">
      <div className="v2-conversation-orientation-copy">
        <h1>What are we working on?</h1>
      </div>
      <div
        aria-label="Starter prompts"
        className="v2-live-assistant-starters"
        data-testid="welcome-starter-prompts"
      >
        {WELCOME_STARTER_PROMPTS.map((prompt) => (
          <button
            className="v2-focusable"
            key={prompt}
            type="button"
            onClick={() => onPickPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
        {showAssistantEntry ? (
          <button className="v2-focusable" type="button" onClick={onOpenAssistantPicker}>
            Start with an Assistant…
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PowerAppShellV2View(props: PowerAppShellV2Props) {
  const { branches, composer, overlays, session, settings, thread, workspace } = props;
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [memoryOwnerOpen, setMemoryOwnerOpen] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [mcpKey, setMcpKey] = useState(0);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const mcpServers = useMcpSettingsStore((state) => state.servers);
  const navigationFolders = useWorkspaceStore((state) => state.navigationFolders);
  // Server-verified capability gate for the direct "Delete…" entries; the
  // deletion confirm surface and its semantics stay unchanged.
  const permanentChatDeletionAvailable = useMemorySettingsStore(
    (state) => Boolean(state.data?.capabilities.permanentChatDeletion)
  );
  const composerDockRef = useRef<HTMLDivElement>(null);
  const libraryOpen = Boolean(settings.library || settings.knowledge || settings.memory.open);

  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
  }, []);
  // The tab title follows the visible active chat (rename/switch included);
  // the Library replaces it while it owns the workspace. Next.js re-applies
  // its static route metadata after hydration, so the effect also watches the
  // <title> node and re-asserts the shell-owned value when something else
  // overwrites it.
  useEffect(() => {
    const desired = documentTitleV2({
      activeChatId: session.activeChatId,
      activeChatTitle: session.activeChatTitle,
      libraryOpen
    });
    if (document.title !== desired) document.title = desired;
    const titleNode = document.head.querySelector("title");
    if (!titleNode) return;
    const observer = new MutationObserver(() => {
      if (document.title !== desired) document.title = desired;
    });
    observer.observe(titleNode, { characterData: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, [libraryOpen, session.activeChatId, session.activeChatTitle]);
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
  const welcomeOrientation = blankWelcomeStartersVisibleV2({
    assistantSelected: Boolean(composer.assistant.selected),
    attachmentCount: composer.attachments.length,
    draft: composer.draft,
    uploading: composer.uploading
  }) ? (
    <WelcomeOrientationV2
      showAssistantEntry={composer.assistant.pickerItems.length > 0}
      onOpenAssistantPicker={() => composer.assistant.setPickerOpen(true)}
      onPickPrompt={(prompt) => composer.composerActions.changeDraft(prompt)}
    />
  ) : undefined;
  const messageById = new Map(thread.visibleMessages.map((message) => [message.id, message]));
  const liveTail = thread.visibleMessages.at(-1);
  const readingAnchorMessageId = liveTail?.role === "assistant"
    ? liveTail.parentMessageId
    : null;
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
    const disabledReason = mutationBlocked ? "Wait for the current answer to finish." : null;
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
        disabledReason={thread.activeChatStreaming ? "Wait for the current answer to finish." : null}
        graph={branches.graph}
        messageId={source.id}
        onCheckout={branches.checkoutBranch}
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
          expandForReadingAnchor={source.id === readingAnchorMessageId}
          role="user"
        />
      );
    }
    const events = source.runId === thread.currentRunId ? thread.events : [];
    const artifact = source.runId === thread.currentRunId
      ? thread.liveArtifactSummary ?? source.artifactSummary ?? null
      : source.artifactSummary ?? null;
    // A genuinely lost stream transport (reader error / end without a
    // terminal frame, recorded by the run-lifecycle store) presents as the
    // honest connection-lost strip; the transport slice suppresses the
    // locally invented post-loss "error" status until refresh reconciles.
    const transportLost = transportLostForMessageV2(thread.interruptedRun, source);
    const presentation = presentRunLifecycleV2({
      ...runTransportStateV2({
        activeChatStreaming: thread.activeChatStreaming,
        interruptedRun: thread.interruptedRun,
        message: { id: source.id, runId: source.runId ?? null, status: source.status },
        persistedRunStatus: null
      }),
      content: messageText(source),
      events,
      runId: source.runId ?? null
    });
    // A live run shows only its factual status and streamed content. A settled
    // answer adds only direct user outputs; it never grows a receipt row or
    // post-hoc execution surface.
    const settled = settledRunPresentationV2(presentation);
    const identity = answerIdentityV2(source);
    return (
      <RunAnswerV2
        actions={settled ? actions : undefined}
        actionsSlot={settled ? (
          <>
            <AnswerOutputsV2
              artifact={artifact}
              identitySlot={identity ? (
                <span data-testid={identity.testId}>{identity.label}</span>
              ) : null}
              showReasoning={composer.showReasoningBlocks}
            />
            {pagerSlot}
          </>
        ) : pagerSlot}
        anchorId={source.id}
        content={messageText(source)}
        onRefresh={transportLost ? () => thread.refreshInterruptedRun() : undefined}
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
  const navigationChatState = (chat: ChatNavigationSummaryWire): NavigationChatRowState | null => {
    const full = currentWorkspaceChat(chat.id);
    return full
      ? { favorite: Boolean(full.pinned), memoryMode: full.memoryMode ?? "NORMAL" }
      : null;
  };
  const activeChatSummary = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
  const currentNewChatMode: NewChatMode = composer.memory.mode === "TEMPORARY"
    ? "TEMPORARY"
    : activeChatSummary?.memoryMode === "EXCLUDED" ? "EXCLUDED" : "NORMAL";
  const withActiveChat = (action: (chat: WorkspaceChatSummary) => void) => () => {
    const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
    if (full) action(full);
    else void workspace.pane.actions.retry();
  };
  const temporarySession = composer.memory.mode === "TEMPORARY";
  const deleteActiveChatPermanently = permanentChatDeletionAvailable
    ? withActiveChat((full) => void workspace.pane.actions.deleteChatPermanently(full))
    : null;

  return (
    <main className="v2-live-root" data-testid="app-shell">
      <UiV2IconSprite />
      {libraryOpen ? (
        <LibrarySurfaceV2 composer={composer} props={props} onOpenMemoryOwner={() => setMemoryOwnerOpen(true)} />
      ) : (
        <ReadingRoomShellV2
          accountLabel={session.accountEmail}
          chatStateFor={navigationChatState}
          currentNewChatMode={currentNewChatMode}
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
          onDelete={permanentChatDeletionAvailable ? (chat) => {
            const full = currentWorkspaceChat(chat.id);
            if (full) void workspace.pane.actions.deleteChatPermanently(full);
            else void workspace.pane.actions.retry();
          } : undefined}
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
          onOpenSearch={overlays.palette.show}
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
              archiveDisabled={thread.activeChatStreaming || temporarySession}
              deleteDisabled={thread.activeChatStreaming || temporarySession}
              editingTitle={
                session.activeChatId &&
                workspace.pane.state.editingChatId === session.activeChatId
                  ? workspace.pane.state.editingChatTitle
                  : null
              }
              folders={navigationFolders}
              onArchive={withActiveChat((full) => void workspace.pane.actions.deleteChat(full))}
              onBranches={branches.show}
              onCommands={overlays.palette.show}
              onCopyThread={() => void thread.copyVisibleThread()}
              onDelete={deleteActiveChatPermanently}
              onExport={(format) => {
                const chatId = session.activeChatId;
                const full = chatId ? currentWorkspaceChat(chatId) : null;
                if (full) workspace.pane.actions.exportChat(full, format);
              }}
              onLibrary={settings.openLibrary}
              onMove={(folderId) => {
                const full = session.activeChatId ? currentWorkspaceChat(session.activeChatId) : null;
                if (full) void workspace.pane.actions.moveChat(full.id, folderId);
              }}
              onRenameCancel={workspace.pane.actions.cancelChatEdit}
              onRenameChange={workspace.pane.actions.changeEditingChatTitle}
              onRenameSave={withActiveChat((full) => void workspace.pane.actions.saveChatTitle(full))}
              onRenameStart={withActiveChat((full) => workspace.pane.actions.startChatEdit(full))}
              onSettings={settings.open}
              onShare={() => void session.shareActiveBranch()}
              shareDisabled={temporarySession}
              temporaryMemory={temporarySession ? composer.memory : null}
              title={session.activeChatTitle}
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
              orientationSlot={assistantOrientation ?? welcomeOrientation}
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

      {branches.open ? (
        <BranchDrawerV2
          checkoutDisabledReason={thread.activeChatStreaming ? "Wait for the current answer to finish." : null}
          error={branches.error}
          graph={branches.graph}
          loading={branches.loading}
          onCheckout={(leafId) => {
            branches.checkoutBranch(leafId);
            return true;
          }}
          onClose={branches.close}
          onRetry={branches.retry}
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
        <ArchivedChatsDialog onRestored={workspace.archived.onRestored} />
      ) : null}
      {overlays.confirmations.chat ? (
        <ChatDeleteConfirmationDialog
          chatTitle={overlays.confirmations.chat.title}
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
      <PermanentChatDeletionSurface />
      {overlays.palette.open ? (
        <CommandPalette items={overlays.palette.items} onClose={overlays.palette.close} onRun={overlays.palette.run} />
      ) : null}
    </main>
  );
}

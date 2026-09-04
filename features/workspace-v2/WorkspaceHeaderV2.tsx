"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuActions,
  UiV2MenuSurface,
  UiV2ProviderMark,
  type UiV2MenuAction,
  type UiV2MenuSubmenuItem
} from "@/components/ui-v2";
import { chatTitleForDisplay } from "@/components/app-shell/shellFormatting";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { chatMenuActionsV2 } from "@/features/navigation-v2/chatMenuActions";
import { useRef, useState, type ReactNode } from "react";

export type TemporaryChatHeaderMemoryV2 = Readonly<{
  explanation: string;
  externalRetention: string;
  label: string;
  retention: string;
  retentionDeadline: string | null;
}>;

export function formatTemporaryRetentionDeadlineV2(
  value: string,
  locale?: string,
  timeZone?: string
): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  }).format(instant);
}

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
            <p data-testid="temporary-retention-deadline">
              Scheduled deletion: <time dateTime={memory.retentionDeadline}>
                {formatTemporaryRetentionDeadlineV2(memory.retentionDeadline)}
              </time>
            </p>
          ) : null}
          <p>{memory.externalRetention}</p>
        </section>
      ) : null}
    </span>
  );
}
export type HeaderOverflowSubmenuItemV2 = UiV2MenuSubmenuItem;

export type HeaderOverflowActionV2 = UiV2MenuAction;

/**
 * The single header "⋯" menu on every width. Below 768px it is the only route
 * to the header actions the compact header hides, so it must never be removed
 * without a replacement. Dismissal follows the shared wave-1 contract (Escape,
 * outside pointer, focus-out).
 */
export function HeaderOverflowMenuV2({ actions, label }: Readonly<{
  actions: readonly HeaderOverflowActionV2[];
  label: string;
}>) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
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
        tooltip={label}
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open ? (
        <UiV2MenuSurface
          className="v2-live-more-menu"
          data-testid="header-more-menu"
          label={label}
          ref={menuRef}
        >
          <UiV2MenuActions
            actions={actions}
            onClose={() => {
              close();
              triggerRef.current?.focus();
            }}
          />
        </UiV2MenuSurface>
      ) : null}
    </span>
  );
}

export type WorkspaceHeaderModelSelectorV2 = Readonly<{
  /** No catalog yet, no models, or an answer is streaming. */
  disabled?: boolean;
  /** Whether the model picker is open (it belongs to the composer's layers). */
  expanded: boolean;
  /** Catalog provider family for the monochrome mark; null falls back to a monogram. */
  family: string | null;
  /** Monogram source (the provider name) when the family has no mark. */
  label: string;
  /** An Assistant governs the model: the trigger shows a lock and cannot open. */
  locked?: boolean;
  lockedReason?: string;
  /** "Claude Opus 5", or "Assistant · model" while locked. */
  name: string;
  onToggle(anchor: HTMLButtonElement): void;
}>;

/**
 * The model selector of the chat header on every width (LibreChat/Open WebUI
 * pattern, operator decision 2026-09-02): provider mark, name, chevron. It
 * only anchors the composer-owned model picker; the picker, its keyboard
 * contract, search, and Parameters row are unchanged. On phones it is the
 * centre island between the menu and the action islands.
 */
export function HeaderModelSelectorV2({ selector }: Readonly<{
  selector: WorkspaceHeaderModelSelectorV2;
}>) {
  const locked = Boolean(selector.locked);
  return (
    <button
      aria-expanded={selector.expanded}
      aria-haspopup="dialog"
      className="v2-live-model v2-focusable"
      data-locked={locked || undefined}
      data-testid="header-model-trigger"
      disabled={selector.disabled || locked}
      title={locked ? selector.lockedReason ?? "Managed by the Assistant" : "Choose model"}
      type="button"
      onClick={(event) => selector.onToggle(event.currentTarget)}
    >
      <UiV2ProviderMark family={selector.family} label={selector.label} />
      <span className="v2-live-model-name">{selector.name}</span>
      <UiV2Icon name={locked ? "lock" : "chevron-down"} />
    </button>
  );
}

export type WorkspaceHeaderFolderV2 = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
}>;

export function WorkspaceHeaderV2({
  active,
  archiveDisabled = false,
  crumb = null,
  deleteDisabled = false,
  editingTitle = null,
  favorite = false,
  folders = [],
  leadingSlot = null,
  memoryUsed = null,
  modelSelector = null,
  moveDisabled = false,
  moveRootLabel,
  onArchive,
  onBranches,
  onCopyLink = null,
  onCopyThread,
  onDelete = null,
  onExport,
  onFavorite = null,
  onMemoryMode = null,
  onMove,
  renameDisabled = false,
  onRenameCancel,
  onRenameChange,
  onRenameSave,
  onRenameStart,
  onShare,
  shareDisabled,
  supplementalActions = [],
  temporaryMemory,
  title
}: Readonly<{
  active: boolean;
  archiveDisabled?: boolean;
  /**
   * Folder path shown before the title, only while the chat lives in a
   * folder ("Workspace 1 / Project 7"); date groups never produce a crumb.
   */
  crumb?: string | null;
  deleteDisabled?: boolean;
  /** Non-null while the header title is being renamed inline. */
  editingTitle?: string | null;
  /** Current Favorite state; shown as a checked menu item when `onFavorite` exists. */
  favorite?: boolean;
  folders?: readonly WorkspaceHeaderFolderV2[];
  /** Whether Memory reads this chat; null hides the Memory item. */
  memoryUsed?: boolean | null;
  /**
   * Context rendered before the title inside the same island (the shared
   * Project chip). The island also shows while no chat is active when this
   * slot renders something.
   */
  leadingSlot?: ReactNode;
  /**
   * The header model selector; rendered before the title on every width and
   * on the blank chat too, where it is the only header content.
   */
  modelSelector?: WorkspaceHeaderModelSelectorV2 | null;
  moveDisabled?: boolean;
  /** Project chats call the top-level Move to… destination "Project root". */
  moveRootLabel?: string;
  onArchive(): void;
  onBranches(): void;
  onCopyLink?: (() => void) | null;
  onCopyThread(): void;
  /** Null hides "Delete…" entirely (no `permanentChatDeletionAvailable`). */
  onDelete?: (() => void) | null;
  onExport(format: "json" | "markdown"): void;
  onFavorite?: (() => void) | null;
  onMemoryMode?: ((mode: "EXCLUDED" | "NORMAL") => void) | null;
  /** Null hides Move to… when the current authority cannot move this chat. */
  onMove?: ((folderId: string | null) => void) | null;
  renameDisabled?: boolean;
  onRenameCancel(): void;
  onRenameChange(value: string): void;
  onRenameSave(): void;
  onRenameStart(): void;
  onShare(): void;
  shareDisabled: boolean;
  supplementalActions?: readonly HeaderOverflowActionV2[];
  temporaryMemory: TemporaryChatHeaderMemoryV2 | null;
  title: string;
}>) {
  const displayTitle = chatTitleForDisplay(title);
  // S1 §4.3: the header carries no kicker; for an active chat the right side
  // is Share plus one "⋯" menu. Share additionally joins the menu below
  // 768px, where the Share text button collapses. The complete header menu
  // also owns content-level actions that do not belong in compact row menus.
  const overflowActions = chatMenuActionsV2({
    archiveDisabled,
    deleteDisabled,
    favorite,
    folders,
    memoryUsed: onMemoryMode ? memoryUsed : null,
    moveDisabled,
    moveRootLabel,
    onArchive,
    onBranches,
    onCopyLink: onCopyLink ?? undefined,
    onCopyThread,
    onDelete: onDelete ?? undefined,
    onExport,
    onFavorite: onFavorite ?? undefined,
    onMemoryMode: onMemoryMode ?? undefined,
    onMove: onMove ?? undefined,
    onRename: onRenameStart,
    onShare,
    renameDisabled,
    shareDisabled,
    surface: "header",
    supplementalActions
  });

  return (
    <header className="v2-live-header">
      {modelSelector ? <HeaderModelSelectorV2 selector={modelSelector} /> : null}
      <div className="v2-live-title">
        {leadingSlot}
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
                aria-label={`New title: ${displayTitle}`}
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
              {crumb ? (
                <span className="v2-live-crumb" data-testid="header-crumb">
                  {crumb}
                  <span aria-hidden="true"> / </span>
                </span>
              ) : null}
              <button
                className="v2-live-title-button v2-focusable"
                data-testid="header-title"
                disabled={renameDisabled}
                title={renameDisabled ? undefined : "Rename chat"}
                type="button"
                onClick={onRenameStart}
              >
                <span className="v2-live-title-text">{displayTitle}</span>
                {/* The pencil states what a click does; it shows on
                    hover/focus and always on coarse pointers. */}
                {renameDisabled ? null : <UiV2Icon name="edit" />}
              </button>
            </h1>
          )
        ) : null}
      </div>
      <div className="v2-live-header-actions">
        {temporaryMemory ? <TemporaryChatIndicatorV2 memory={temporaryMemory} /> : null}
        {/* The account menu lives in the sidebar footer (one entry, UX audit
            F11); the header carries only the chat's own actions. */}
        {active ? (
          <>
            <UiV2Button disabled={shareDisabled} icon="share" onClick={onShare}>Share</UiV2Button>
            <HeaderOverflowMenuV2 label="Chat actions" actions={overflowActions} />
          </>
        ) : null}
      </div>
    </header>
  );
}

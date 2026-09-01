"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuItem,
  UiV2MenuSeparator,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { flattenFolderTree } from "@/features/navigation-v2/NavigationV2";
import { Fragment, useRef, useState, type ReactNode } from "react";

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
  /** Starts a new visual group (UX audit F17). */
  separatorBefore?: boolean;
  /** Inline disclosure list (folder picker); scrolls locally when long. */
  submenu?: readonly HeaderOverflowSubmenuItemV2[];
  tone?: "destructive";
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
              {action.separatorBefore ? <UiV2MenuSeparator /> : null}
              <UiV2MenuItem
                data-mobile-only={action.mobileOnly ? "" : undefined}
                disabled={action.disabled}
                tone={action.tone}
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
  archiveDisabled = false,
  crumb = null,
  deleteDisabled = false,
  editingTitle = null,
  folders = [],
  leadingSlot = null,
  moveDisabled = false,
  onArchive,
  onBranches,
  onCopyLink = null,
  onCopyThread,
  onDelete = null,
  onExport,
  onMove,
  renameDisabled = false,
  onRenameCancel,
  onRenameChange,
  onRenameSave,
  onRenameStart,
  onShare,
  shareDisabled,
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
  folders?: readonly WorkspaceHeaderFolderV2[];
  /**
   * Context rendered before the title inside the same island (the shared
   * Project chip). The island also shows while no chat is active when this
   * slot renders something.
   */
  leadingSlot?: ReactNode;
  moveDisabled?: boolean;
  onArchive(): void;
  onBranches(): void;
  onCopyLink?: (() => void) | null;
  onCopyThread(): void;
  /** Null hides "Delete…" entirely (no `permanentChatDeletionAvailable`). */
  onDelete?: (() => void) | null;
  onExport(format: "json" | "markdown"): void;
  onMove(folderId: string | null): void;
  renameDisabled?: boolean;
  onRenameCancel(): void;
  onRenameChange(value: string): void;
  onRenameSave(): void;
  onRenameStart(): void;
  onShare(): void;
  shareDisabled: boolean;
  temporaryMemory: TemporaryChatHeaderMemoryV2 | null;
  title: string;
}>) {
  // S1 §4.3: the header carries no kicker; for an active chat the right side
  // is Share plus one "⋯" menu. Share additionally joins the menu below
  // 900px, where the Share text button collapses. The menu reads in three
  // groups (UX audit F17): the chat itself · its content · destructive last.
  const overflowActions: HeaderOverflowActionV2[] = [
    { disabled: shareDisabled, label: "Share", mobileOnly: true, onSelect: onShare },
    { disabled: renameDisabled, label: "Rename", onSelect: onRenameStart },
    {
      disabled: moveDisabled,
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
    { label: "Branches", onSelect: onBranches, separatorBefore: true },
    { label: "Export", onSelect: () => onExport("markdown") },
    { label: "Export as JSON", onSelect: () => onExport("json") },
    { label: "Copy entire thread", onSelect: onCopyThread },
    ...(onCopyLink ? [{ label: "Copy link to chat", onSelect: onCopyLink }] : []),
    { disabled: archiveDisabled, label: "Archive", onSelect: onArchive, separatorBefore: true },
    ...(onDelete
      ? [{ disabled: deleteDisabled, label: "Delete…", onSelect: onDelete, tone: "destructive" as const }]
      : [])
  ];

  return (
    <header className="v2-live-header">
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
                <span className="v2-live-title-text">{title}</span>
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

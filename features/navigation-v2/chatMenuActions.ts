import type { UiV2MenuAction } from "@/components/ui-v2";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";

export type FlattenedFolder<Folder> = Readonly<{ depth: number; folder: Folder }>;

/** Depth-first folder order for pickers, skipping `excludeId` and its subtree. */
export function flattenFolderTree<
  Folder extends Readonly<{ id: string; name: string; parentId: string | null }>
>(
  folders: readonly Folder[],
  excludeId?: string | null
): readonly FlattenedFolder<Folder>[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const result: FlattenedFolder<Folder>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of folders) {
      const effectiveParent =
        folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null;
      if (effectiveParent !== parentId || folder.id === excludeId) continue;
      result.push({ depth, folder });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

export type ChatMenuActionsInputV2 = Readonly<{
  archiveDisabled?: boolean;
  deleteDisabled?: boolean;
  favorite?: boolean;
  folders: readonly Readonly<{ id: string; name: string; parentId: string | null }>[];
  /** Whether Memory reads this chat; null hides the Memory item. */
  memoryUsed?: boolean | null;
  moveDisabled?: boolean;
  /** The first destination in Move to…; Project chats call this "Project root". */
  moveRootLabel?: string;
  onArchive?(): void;
  onBranches?(): void;
  onCopyLink?(): void;
  onCopyThread?(): void;
  /** Absent hides "Delete…" entirely (no permanent-deletion capability). */
  onDelete?(): void;
  onExport?(format: "json" | "markdown"): void;
  onFavorite?(): void;
  onMemoryMode?(mode: "EXCLUDED" | "NORMAL"): void;
  onMove?(folderId: string | null): void;
  /** Optional final Move to… destination that opens the owning folder form. */
  onMoveCreateFolder?(): void;
  onRename?(): void;
  onShare?(): void;
  renameDisabled?: boolean;
  shareDisabled?: boolean;
  /** The compact row menu and the complete header overflow have distinct jobs. */
  surface: "header" | "row";
  /** Optional owner-specific group placed before archive/delete. */
  supplementalActions?: readonly UiV2MenuAction[];
}>;

/**
 * Builds the compact five-action row menu or the complete header overflow.
 * Callers omit callbacks the current user cannot honour and those entries
 * disappear with them.
 */
export function chatMenuActionsV2({
  archiveDisabled = false,
  deleteDisabled = false,
  favorite = false,
  folders,
  memoryUsed = null,
  moveDisabled = false,
  moveRootLabel = "No folder",
  onArchive,
  onBranches,
  onCopyLink,
  onCopyThread,
  onDelete,
  onExport,
  onFavorite,
  onMemoryMode,
  onMove,
  onMoveCreateFolder,
  onRename,
  onShare,
  renameDisabled = false,
  shareDisabled = false,
  surface,
  supplementalActions = []
}: ChatMenuActionsInputV2): UiV2MenuAction[] {
  const chat: UiV2MenuAction[] = [
    ...(onRename ? [{ disabled: renameDisabled, icon: "edit", label: "Rename", onSelect: onRename }] as const : []),
    ...(onMove
      ? [{
          disabled: moveDisabled,
          icon: "folder",
          label: "Move to…",
          submenu: [
            { label: moveRootLabel, onSelect: () => onMove(null) },
            ...flattenFolderTree(folders).map(({ depth, folder }) => ({
              depth,
              label: folder.name,
              onSelect: () => onMove(folder.id)
            })),
            ...(onMoveCreateFolder
              ? [{ label: "New folder…", onSelect: onMoveCreateFolder }]
              : [])
          ]
        }] as const
      : []),
    ...(onFavorite ? [{ icon: "star", label: "Favorite", onSelect: onFavorite, selected: favorite }] as const : []),
    ...(surface === "header" && onMemoryMode && memoryUsed !== null
      ? [{
          icon: "memory",
          label: resolveMemoryCopy(memoryUsed ? "exclude.action" : "resume.action"),
          onSelect: () => onMemoryMode(memoryUsed ? "EXCLUDED" : "NORMAL")
        }] as const
      : [])
  ];
  const exportItems = [
    ...(onExport
      ? [
          { label: "Markdown", onSelect: () => onExport("markdown") },
          { label: "JSON", onSelect: () => onExport("json") }
        ] as const
      : []),
    ...(onCopyThread ? [{ label: "Copy entire thread", onSelect: onCopyThread }] as const : [])
  ];
  const content: UiV2MenuAction[] = [
    ...(surface === "header" && onShare
      ? [{
          disabled: shareDisabled,
          icon: "share",
          label: "Share",
          mobileOnly: true,
          onSelect: onShare
        }] as const
      : []),
    ...(surface === "header" && onBranches
      ? [{ icon: "branch", label: "Branches", onSelect: onBranches }] as const
      : []),
    ...(surface === "header" && exportItems.length > 0
      ? [{ icon: "download", label: "Export", submenu: exportItems }] as const
      : []),
    ...(surface === "header" && onCopyLink
      ? [{ icon: "link", label: "Copy link to chat", onSelect: onCopyLink }] as const
      : [])
  ];
  const destructive: UiV2MenuAction[] = [
    ...(onArchive ? [{ disabled: archiveDisabled, icon: "archive", label: "Archive", onSelect: onArchive }] as const : []),
    ...(onDelete
      ? [{ disabled: deleteDisabled, icon: "trash", label: "Delete…", onSelect: onDelete, tone: "destructive" }] as const
      : [])
  ];
  return [chat, content, supplementalActions, destructive]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => index === 0
      ? group
      : group.map((action, position) => position === 0 ? { ...action, separatorBefore: true } : action));
}

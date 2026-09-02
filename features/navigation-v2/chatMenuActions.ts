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
  onRename?(): void;
  onShare?(): void;
  renameDisabled?: boolean;
  shareDisabled?: boolean;
  /**
   * "menu": Share is a menu entry on every width (the chat row has no Share
   * button); "mobile": only below 900px, where the header's Share button
   * collapses into the menu.
   */
  sharePlacement: "menu" | "mobile";
}>;

/**
 * The one action list of a chat, shared by the sidebar row menu and the
 * header "⋯" so both read identically: the chat itself · its content ·
 * destructive last (UX audit 2026-09-02 B4). Callers omit the callbacks a
 * surface cannot honour and the entries disappear with them.
 */
export function chatMenuActionsV2({
  archiveDisabled = false,
  deleteDisabled = false,
  favorite = false,
  folders,
  memoryUsed = null,
  moveDisabled = false,
  onArchive,
  onBranches,
  onCopyLink,
  onCopyThread,
  onDelete,
  onExport,
  onFavorite,
  onMemoryMode,
  onMove,
  onRename,
  onShare,
  renameDisabled = false,
  shareDisabled = false,
  sharePlacement
}: ChatMenuActionsInputV2): UiV2MenuAction[] {
  const chat: UiV2MenuAction[] = [
    ...(onRename ? [{ disabled: renameDisabled, icon: "edit", label: "Rename", onSelect: onRename }] as const : []),
    ...(onMove
      ? [{
          disabled: moveDisabled,
          icon: "folder",
          label: "Move to…",
          submenu: [
            { label: "No folder", onSelect: () => onMove(null) },
            ...flattenFolderTree(folders).map(({ depth, folder }) => ({
              depth,
              label: folder.name,
              onSelect: () => onMove(folder.id)
            }))
          ]
        }] as const
      : []),
    ...(onFavorite ? [{ icon: "star", label: "Favorite", onSelect: onFavorite, selected: favorite }] as const : []),
    ...(onMemoryMode && memoryUsed !== null
      ? [{
          icon: "memory",
          label: resolveMemoryCopy(memoryUsed ? "exclude.action" : "resume.action"),
          onSelect: () => onMemoryMode(memoryUsed ? "EXCLUDED" : "NORMAL")
        }] as const
      : [])
  ];
  const content: UiV2MenuAction[] = [
    ...(onShare
      ? [{
          disabled: shareDisabled,
          icon: "share",
          label: "Share",
          mobileOnly: sharePlacement === "mobile",
          onSelect: onShare
        }] as const
      : []),
    ...(onBranches ? [{ icon: "branch", label: "Branches", onSelect: onBranches }] as const : []),
    ...(onExport
      ? [
          { icon: "download", label: "Export", onSelect: () => onExport("markdown") },
          { icon: "braces", label: "Export as JSON", onSelect: () => onExport("json") }
        ] as const
      : []),
    ...(onCopyThread ? [{ icon: "copy", label: "Copy entire thread", onSelect: onCopyThread }] as const : []),
    ...(onCopyLink ? [{ icon: "link", label: "Copy link to chat", onSelect: onCopyLink }] as const : [])
  ];
  const destructive: UiV2MenuAction[] = [
    ...(onArchive ? [{ disabled: archiveDisabled, icon: "archive", label: "Archive", onSelect: onArchive }] as const : []),
    ...(onDelete
      ? [{ disabled: deleteDisabled, icon: "trash", label: "Delete…", onSelect: onDelete, tone: "destructive" }] as const
      : [])
  ];
  return [chat, content, destructive]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => index === 0
      ? group
      : group.map((action, position) => position === 0 ? { ...action, separatorBefore: true } : action));
}

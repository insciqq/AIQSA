import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";

/** Orders two checkpoints of one answer: the later call wins, its id breaking a tie of the same millisecond. */
function laterCheckpoint(a: NonNullable<ThreadGeneratedFile["checkpoint"]>, b: NonNullable<ThreadGeneratedFile["checkpoint"]>): boolean {
  const at = Date.parse(a.createdAt), bt = Date.parse(b.createdAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at > bt;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * The files of one answer with only the latest checkpoint of each Workspace
 * path: checkpointing a path again supersedes its earlier version, so the
 * answer, its connector deliveries and its export history never offer two
 * drafts of one file (production 2026-11-20: users asked which one is final).
 * Different paths with the same file name stay separate, and final exports
 * and files from the user's computer pass through unchanged, in order. The
 * earlier version stays stored: its tool result, an artifact or a link may
 * still name it.
 */
export function latestWorkspaceCheckpointVersions<T extends ThreadGeneratedFile>(files: readonly T[]): T[] {
  const latest = new Map<string, NonNullable<ThreadGeneratedFile["checkpoint"]>>();
  for (const file of files) {
    if (!file.checkpoint || file.source) continue;
    const current = latest.get(file.relativePath);
    if (!current || laterCheckpoint(file.checkpoint, current)) latest.set(file.relativePath, file.checkpoint);
  }
  return files.filter((file) => !file.checkpoint || Boolean(file.source) || latest.get(file.relativePath)?.id === file.checkpoint.id);
}

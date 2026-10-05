import { Image, ImageInUseError, ImageNotFoundError, type ImageHandle } from "microsandbox";
import { logEvent } from "../observability";
import { WORKSPACE_DEFAULT_IMAGE_REF } from "./config";

/** One cached guest image reference as the runtime reports it; never logged. */
export type WorkspaceCachedImage = Readonly<{
  createdAt: Date | null;
  manifestDigest: string | null;
  reference: string;
}>;

/**
 * The runtime's guest image cache. `remove` never forces: inside its own
 * transaction the runtime refuses an image whose manifest the root disk of
 * any existing sandbox pins, running or stopped with a retained disk.
 */
export type WorkspaceImageStore = Readonly<{
  find(reference: string): Promise<WorkspaceCachedImage | null>;
  list(): Promise<readonly WorkspaceCachedImage[]>;
  remove(reference: string): Promise<"in_use" | "missing" | "removed">;
}>;

export type WorkspaceImageEvictionSummary = Readonly<{
  /** Older guest references considered; the current and previous guests never are. */
  candidates: number;
  /** Left for a later startup by the pass bounds or an earlier failure. */
  deferred: number;
  failed: number;
  /** Still pinned by a sandbox disk. */
  inUse: number;
  outcome: "completed" | "degraded";
  /** Removed in this pass, including references that were already gone. */
  removed: number;
}>;

/** Removal attempts per pass; the rest wait for a later startup. */
const WORKSPACE_IMAGE_EVICTION_MAX_ATTEMPTS = 16;
/** No removal starts after this budget, so a pass cannot hold startup back further. */
const WORKSPACE_IMAGE_EVICTION_BUDGET_MS = 30_000;

/** The repository of an image reference, without its tag and digest. */
export function workspaceImageRepository(reference: string): string | null {
  const name = reference.split("@", 1)[0] ?? "";
  const tag = name.lastIndexOf(":");
  const repository = tag > name.lastIndexOf("/") ? name.slice(0, tag) : name;
  return repository || null;
}

function oldestFirst(left: WorkspaceCachedImage, right: WorkspaceCachedImage): number {
  return (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
    (left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0);
}

/**
 * Guest versions this runner may evict: references in the configured image's
 * repository or the bundled guest's, oldest first. The configured reference,
 * any alias of its manifest and entries without a manifest identity stay, and
 * so does the newest older version with its aliases: during a rollout or a
 * rollback the previous release can still start guests from it.
 */
function selectWorkspaceImageEvictions(input: Readonly<{
  current: WorkspaceCachedImage | null;
  currentReference: string;
  images: readonly WorkspaceCachedImage[];
}>): WorkspaceCachedImage[] {
  const repositories = new Set([input.currentReference, WORKSPACE_DEFAULT_IMAGE_REF]
    .map(workspaceImageRepository).filter((repository) => repository !== null));
  const currentDigest = input.current?.manifestDigest ?? null;
  const older = input.images.filter((image) => {
    const repository = workspaceImageRepository(image.reference);
    return image.reference !== input.currentReference && image.manifestDigest !== null &&
      image.manifestDigest !== currentDigest && repository !== null && repositories.has(repository);
  }).sort(oldestFirst);
  const previousDigest = older.at(-1)?.manifestDigest;
  return older.filter((image) => image.manifestDigest !== previousDigest);
}

/**
 * Evicts cached guest versions that are neither the configured or previous
 * guest nor pinned by a sandbox disk. The runner calls this before it accepts
 * any request, so no session operation can be creating a guest meanwhile; a
 * failure only leaves space unreclaimed until a later startup.
 */
export async function evictUnusedWorkspaceImages(input: Readonly<{
  budgetMs?: number;
  imageRef: string;
  maxAttempts?: number;
  now?: () => number;
  store: WorkspaceImageStore;
}>): Promise<WorkspaceImageEvictionSummary> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budgetMs = input.budgetMs ?? WORKSPACE_IMAGE_EVICTION_BUDGET_MS;
  const maxAttempts = input.maxAttempts ?? WORKSPACE_IMAGE_EVICTION_MAX_ATTEMPTS;
  const unavailable = () => report({
    candidates: 0, deferred: 0, failed: 0, inUse: 0, outcome: "degraded", removed: 0
  }, now() - startedAt);
  let candidates: WorkspaceCachedImage[];
  try {
    const current = await input.store.find(input.imageRef);
    // Without the current manifest identity an alias of it cannot be told apart.
    if (current && current.manifestDigest === null) return unavailable();
    candidates = selectWorkspaceImageEvictions({
      current, currentReference: input.imageRef, images: await input.store.list()
    });
  } catch {
    return unavailable();
  }
  let attempted = 0;
  let failed = 0;
  let inUse = 0;
  let removed = 0;
  for (const image of candidates) {
    if (failed > 0 || attempted >= maxAttempts || now() - startedAt >= budgetMs) break;
    attempted += 1;
    try {
      if (await input.store.remove(image.reference) === "in_use") inUse += 1;
      else removed += 1;
    } catch {
      failed += 1;
    }
  }
  return report({
    candidates: candidates.length, deferred: candidates.length - attempted, failed, inUse,
    outcome: failed > 0 ? "degraded" : "completed", removed
  }, now() - startedAt);
}

function report(summary: WorkspaceImageEvictionSummary, durationMs: number): WorkspaceImageEvictionSummary {
  logEvent("runtime_lifecycle", {
    subsystem: "workspace", stage: "evict", outcome: summary.outcome,
    ...(summary.outcome === "degraded" ? { action: "degrade" as const, code: "workspace_image_eviction_failed" } : {}),
    count: summary.candidates, completed_count: summary.removed, failed_count: summary.failed,
    pending_count: summary.inUse + summary.deferred, duration_ms: Math.max(0, durationMs)
  });
  return summary;
}

function cachedImage(handle: ImageHandle): WorkspaceCachedImage {
  return { createdAt: handle.createdAt, manifestDigest: handle.manifestDigest, reference: handle.reference };
}

export function createMicrosandboxImageStore(): WorkspaceImageStore {
  return {
    async find(reference) {
      try {
        return cachedImage(await Image.get(reference));
      } catch (error) {
        if (error instanceof ImageNotFoundError) return null;
        throw error;
      }
    },
    async list() {
      return (await Image.list()).map(cachedImage);
    },
    async remove(reference) {
      try {
        await Image.remove(reference, { force: false });
        return "removed";
      } catch (error) {
        if (error instanceof ImageInUseError) return "in_use";
        if (error instanceof ImageNotFoundError) return "missing";
        throw error;
      }
    }
  };
}

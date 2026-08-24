import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";

/**
 * The coordinator is deliberately driven by one small manifest.  Prisma's
 * enum is a persistence vocabulary and is allowed to contain retired values;
 * it must not silently become the set of jobs a worker claims.  Keep this
 * list next to the registry so adding a producer requires an explicit
 * handler and a startup completeness check.
 */
export const MEMORY_COORDINATOR_JOB_KINDS = Object.freeze([
  "INDEX_HISTORY",
  "EXTRACT_FACTS",
  "EMBED_ITEMS",
  "REBUILD_INDEX",
  "RECLASSIFY_FACTS",
  "RESOLVE_FACT_RELATIONS",
  "SYNTHESIZE_MEMORIES"
] as const satisfies readonly MemoryJobKind[]);

export type MemoryCoordinatorJobKind =
  (typeof MEMORY_COORDINATOR_JOB_KINDS)[number];

/** Values retained by the persistence enum but intentionally not claimed by
 * the v1 worker.  Legacy rows are terminalised by the repository rather than
 * being left in a queue that the worker cannot service. */
export const MEMORY_COORDINATOR_ORPHANED_JOB_KINDS = Object.freeze([
  "CONSOLIDATE_CANDIDATE",
  "RECONCILE_BRANCH",
  "RECONCILE_SOURCE",
  // Retired before the v1 worker manifest; existing rows are terminalised
  // rather than claimed by a verification handler.
  "VERIFY_CANDIDATE"
] as const satisfies readonly MemoryJobKind[]);

type MemoryCoordinatorJobManifestEntry = Readonly<{
  leaseRequired: boolean;
  maxAttempts?: number;
  retryable: boolean;
}>;

export const MEMORY_COORDINATOR_JOB_MANIFEST = Object.freeze({
  EMBED_ITEMS: Object.freeze({
    leaseRequired: true,
    retryable: true
  }),
  EXTRACT_FACTS: Object.freeze({
    leaseRequired: true,
    maxAttempts: 2,
    retryable: true
  }),
  INDEX_HISTORY: Object.freeze({
    leaseRequired: true,
    retryable: true
  }),
  REBUILD_INDEX: Object.freeze({
    leaseRequired: true,
    retryable: true
  }),
  RECLASSIFY_FACTS: Object.freeze({
    leaseRequired: true,
    retryable: true
  }),
  RESOLVE_FACT_RELATIONS: Object.freeze({
    leaseRequired: true,
    maxAttempts: 2,
    retryable: true
  }),
  SYNTHESIZE_MEMORIES: Object.freeze({
    leaseRequired: true,
    maxAttempts: 1,
    retryable: false
  })
} satisfies Record<MemoryCoordinatorJobKind, MemoryCoordinatorJobManifestEntry>);

export type MemoryCoordinatorRegistryCheck = Readonly<{
  extra: readonly MemoryJobKind[];
  missing: readonly MemoryCoordinatorJobKind[];
  ok: boolean;
}>;

export function isMemoryCoordinatorJobKind(
  value: unknown
): value is MemoryCoordinatorJobKind {
  return typeof value === "string" &&
    (MEMORY_COORDINATOR_JOB_KINDS as readonly string[]).includes(value);
}

export function memoryCoordinatorJobMaxAttempts(
  kind: MemoryJobKind,
  defaultMaxAttempts: number
): number {
  if (!isMemoryCoordinatorJobKind(kind)) return defaultMaxAttempts;
  const entry: MemoryCoordinatorJobManifestEntry =
    MEMORY_COORDINATOR_JOB_MANIFEST[kind];
  return Math.min(entry.maxAttempts ?? defaultMaxAttempts, defaultMaxAttempts);
}

function registryCheck(
  registered: readonly MemoryJobKind[]
): MemoryCoordinatorRegistryCheck {
  const registeredSet = new Set(registered);
  const declaredSet = new Set<MemoryJobKind>(MEMORY_COORDINATOR_JOB_KINDS);
  const missing = MEMORY_COORDINATOR_JOB_KINDS.filter((kind) =>
    !registeredSet.has(kind));
  const extra = registered.filter((kind) => !declaredSet.has(kind));
  return Object.freeze({
    extra: Object.freeze([...new Set(extra)]),
    missing: Object.freeze([...missing]),
    ok: missing.length === 0 && extra.length === 0
  });
}

export class MemoryCoordinatorRegistry {
  readonly #deletionHandlers = new Map<MemoryDeletionOperation, MemoryDeletionHandler>();
  readonly #jobHandlers = new Map<MemoryJobKind, MemoryJobHandler>();

  registerJob(handler: MemoryJobHandler): () => void {
    if (!isMemoryCoordinatorJobKind(handler.kind)) {
      throw new Error("memory_job_kind_undeclared");
    }
    if (this.#jobHandlers.has(handler.kind)) {
      throw new Error("memory_job_handler_duplicate");
    }
    this.#jobHandlers.set(handler.kind, Object.freeze(handler));
    return () => {
      if (this.#jobHandlers.get(handler.kind) === handler) {
        this.#jobHandlers.delete(handler.kind);
      }
    };
  }

  registerDeletion(handler: MemoryDeletionHandler): () => void {
    if (this.#deletionHandlers.has(handler.operation)) {
      throw new Error("memory_deletion_handler_duplicate");
    }
    this.#deletionHandlers.set(handler.operation, Object.freeze(handler));
    return () => {
      if (this.#deletionHandlers.get(handler.operation) === handler) {
        this.#deletionHandlers.delete(handler.operation);
      }
    };
  }

  jobHandler(kind: MemoryJobKind): MemoryJobHandler | null {
    return this.#jobHandlers.get(kind) ?? null;
  }

  deletionHandler(operation: MemoryDeletionOperation): MemoryDeletionHandler | null {
    return this.#deletionHandlers.get(operation) ?? null;
  }

  jobKinds(): readonly MemoryJobKind[] {
    return Object.freeze([...this.#jobHandlers.keys()]);
  }

  deletionOperations(): readonly MemoryDeletionOperation[] {
    return Object.freeze([...this.#deletionHandlers.keys()]);
  }

  /** Return a stable build/startup assertion for the active worker manifest. */
  checkCompleteness(): MemoryCoordinatorRegistryCheck {
    return registryCheck(this.jobKinds());
  }

  assertComplete(): void {
    const check = this.checkCompleteness();
    if (!check.ok) throw new Error("memory_job_registry_incomplete");
  }

  /**
   * Kinds that can be present in the database but must not be claimed by this
   * worker.  Keeping this derived from the manifest makes unknown rows
   * observable without giving the browser a repository object.
   */
  unsupportedJobKinds(): readonly MemoryJobKind[] {
    return Object.freeze([...MEMORY_COORDINATOR_ORPHANED_JOB_KINDS]);
  }
}

export const defaultMemoryCoordinatorRegistry = new MemoryCoordinatorRegistry();

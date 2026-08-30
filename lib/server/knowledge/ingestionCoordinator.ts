import { randomUUID } from "node:crypto";
import {
  KnowledgeIngestionError,
  knowledgeWorkIdentity,
  type KnowledgeIngestionFailureCode,
  type KnowledgeWorkClaim,
  type KnowledgeWorkIdentity
} from "./ingestionTypes";

export type KnowledgeIngestionCoordinatorRepository = Readonly<{
  claim(input: {
    claimToken: string;
    now: Date;
    staleBefore: Date;
  }): Promise<KnowledgeWorkClaim | null>;
  heartbeat(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean>;
  reconcile(input: { now: Date }): Promise<boolean>;
  retryLater(input: KnowledgeWorkIdentity & {
    errorCode: KnowledgeIngestionFailureCode;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<boolean>;
  settleFailed(input: KnowledgeWorkIdentity & {
    errorCode: KnowledgeIngestionFailureCode;
    now: Date;
  }): Promise<boolean>;
}>;

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 300_000] as const;

export const KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT = 8 as const;
export const KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM = 1 as const;
export const KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM = 64 as const;

export type KnowledgeIngestionParallelismSource =
  | number
  | (() => number | Promise<number>);

export function clampKnowledgeIngestionParallelism(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT;
  }
  return Math.min(
    Math.max(value, KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM),
    KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM
  );
}

function retryDelayMs(attemptCount: number, retryAfterMs: number | null): number {
  const localDelay = RETRY_DELAYS_MS[
    Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)
  ] ?? RETRY_DELAYS_MS.at(-1)!;
  if (
    retryAfterMs === null ||
    !Number.isSafeInteger(retryAfterMs) ||
    retryAfterMs <= 0
  ) return localDelay;
  return Math.max(localDelay, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

export class KnowledgeIngestionCoordinator {
  readonly #heartbeatMs: number;
  readonly #intervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #maxParallel: KnowledgeIngestionParallelismSource;
  readonly #now: () => Date;
  readonly #process: (claim: KnowledgeWorkClaim, signal?: AbortSignal) => Promise<void>;
  readonly #repository: KnowledgeIngestionCoordinatorRepository;
  #pending: Promise<void> | null = null;
  #rerun = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: Readonly<{
    heartbeatMs?: number;
    intervalMs?: number;
    leaseMs?: number;
    maxAttempts?: number;
    maxParallel?: KnowledgeIngestionParallelismSource;
    now?: () => Date;
    process: (claim: KnowledgeWorkClaim, signal?: AbortSignal) => Promise<void>;
    repository: KnowledgeIngestionCoordinatorRepository;
  }>) {
    this.#heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#maxParallel = input.maxParallel ?? KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT;
    this.#now = input.now ?? (() => new Date());
    this.#process = input.process;
    this.#repository = input.repository;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.kick(), this.#intervalMs);
    this.#timer.unref?.();
    this.kick();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  kick(): void {
    this.#rerun = true;
    if (this.#pending) return;
    this.#pending = this.#drain().finally(() => {
      this.#pending = null;
      if (this.#rerun) this.kick();
    });
  }

  async reconcileNow(): Promise<void> {
    this.kick();
    await this.#pending;
  }

  async #drain(): Promise<void> {
    do {
      this.#rerun = false;
      const maxParallel = await this.#resolveMaxParallel();
      await Promise.all(Array.from({ length: maxParallel }, () => this.#worker()));
      try {
        if (await this.#repository.reconcile({ now: this.#now() })) this.#rerun = true;
      } catch {
        // A later interval owns durable reconciliation retry.
      }
    } while (this.#rerun);
  }

  async #resolveMaxParallel(): Promise<number> {
    const source = this.#maxParallel;
    try {
      return clampKnowledgeIngestionParallelism(
        typeof source === "function" ? await source() : source
      );
    } catch {
      return KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT;
    }
  }

  async #worker(): Promise<void> {
    while (true) {
      const now = this.#now();
      let claim: KnowledgeWorkClaim | null;
      try {
        claim = await this.#repository.claim({
          claimToken: randomUUID(),
          now,
          staleBefore: new Date(now.getTime() - this.#leaseMs)
        });
      } catch {
        return;
      }
      if (!claim) return;
      await this.#processClaim(claim);
    }
  }

  async #processClaim(claim: KnowledgeWorkClaim): Promise<void> {
    let leaseLost = false;
    const identity = knowledgeWorkIdentity(claim);
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.#repository.heartbeat({ ...identity, now: this.#now() }).then((accepted) => {
        if (!accepted) {
          leaseLost = true;
          controller.abort(new Error("knowledge_ingestion_lease_lost"));
        }
      }).catch(() => undefined);
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      await this.#process(claim, controller.signal);
    } catch (error) {
      if (leaseLost || controller.signal.aborted) return;
      const failure = error instanceof KnowledgeIngestionError
        ? error
        : new KnowledgeIngestionError("knowledge_ingestion_failed", true);
      if (failure.retryable && claim.attemptCount < this.#maxAttempts) {
        const delay = retryDelayMs(claim.attemptCount, failure.retryAfterMs);
        const now = this.#now();
        await this.#repository.retryLater({
          ...identity,
          errorCode: failure.code,
          nextAttemptAt: new Date(now.getTime() + delay),
          now
        }).catch(() => undefined);
      } else {
        await this.#repository.settleFailed({
          ...identity,
          errorCode: failure.code,
          now: this.#now()
        }).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

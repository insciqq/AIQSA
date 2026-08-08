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
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PARALLEL = 2;
const RETRY_DELAYS_MS = [1_000, 5_000] as const;

export class KnowledgeIngestionCoordinator {
  readonly #heartbeatMs: number;
  readonly #intervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #maxParallel: number;
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
    maxParallel?: number;
    now?: () => Date;
    process: (claim: KnowledgeWorkClaim, signal?: AbortSignal) => Promise<void>;
    repository: KnowledgeIngestionCoordinatorRepository;
  }>) {
    this.#heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#maxParallel = input.maxParallel ?? DEFAULT_MAX_PARALLEL;
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
      await Promise.all(Array.from({ length: this.#maxParallel }, () => this.#worker()));
      try {
        if (await this.#repository.reconcile({ now: this.#now() })) this.#rerun = true;
      } catch {
        // A later interval owns durable reconciliation retry.
      }
    } while (this.#rerun);
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
        const delay = RETRY_DELAYS_MS[
          Math.min(claim.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
        ] ?? RETRY_DELAYS_MS.at(-1)!;
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

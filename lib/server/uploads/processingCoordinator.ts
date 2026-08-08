import { randomUUID } from "node:crypto";
import type {
  AttachmentProcessingErrorCode,
  AttachmentProcessingRecord,
  AttachmentProcessingResult
} from "./processing";
import { AttachmentProcessingError } from "./processing";

export type AttachmentProcessingRepository = Readonly<{
  claim(input: { claimToken: string; now: Date; staleBefore: Date }): Promise<AttachmentProcessingRecord | null>;
  heartbeat(input: { claimToken: string; jobId: string; now: Date }): Promise<boolean>;
  retryLater(input: {
    claimToken: string;
    errorCode: AttachmentProcessingErrorCode;
    jobId: string;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<boolean>;
  settleFailed(input: {
    attachmentId: string;
    claimToken: string;
    errorCode: AttachmentProcessingErrorCode;
    jobId: string;
    now: Date;
  }): Promise<boolean>;
  settleReady(input: {
    attachmentId: string;
    claimToken: string;
    jobId: string;
    now: Date;
    result: AttachmentProcessingResult;
  }): Promise<boolean>;
}>;

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PARALLEL = 2;
const RETRY_DELAYS_MS = [1_000, 5_000] as const;

export class AttachmentProcessingCoordinator {
  readonly #heartbeatMs: number;
  readonly #intervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #maxParallel: number;
  readonly #now: () => Date;
  readonly #process: (
    record: AttachmentProcessingRecord,
    signal?: AbortSignal
  ) => Promise<AttachmentProcessingResult>;
  readonly #repository: AttachmentProcessingRepository;
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
    process: (
      record: AttachmentProcessingRecord,
      signal?: AbortSignal
    ) => Promise<AttachmentProcessingResult>;
    repository: AttachmentProcessingRepository;
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
    } while (this.#rerun);
  }

  async #worker(): Promise<void> {
    while (true) {
      const now = this.#now();
      let claim: AttachmentProcessingRecord | null;
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

  async #processClaim(claim: AttachmentProcessingRecord): Promise<void> {
    let leaseLost = false;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.#repository.heartbeat({
        claimToken: claim.claimToken,
        jobId: claim.jobId,
        now: this.#now()
      }).then((accepted) => {
        if (!accepted) {
          leaseLost = true;
          controller.abort(new Error("attachment_processing_lease_lost"));
        }
      }).catch(() => undefined);
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      const result = await this.#process(claim, controller.signal);
      if (leaseLost) return;
      await this.#repository.settleReady({
        attachmentId: claim.id,
        claimToken: claim.claimToken,
        jobId: claim.jobId,
        now: this.#now(),
        result
      });
    } catch (error) {
      if (leaseLost) return;
      const failure = error instanceof AttachmentProcessingError
        ? error
        : new AttachmentProcessingError("attachment_processing_failed", true);
      if (failure.retryable && claim.attemptCount < this.#maxAttempts) {
        const delay = RETRY_DELAYS_MS[Math.min(claim.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ??
          RETRY_DELAYS_MS.at(-1)!;
        const now = this.#now();
        await this.#repository.retryLater({
          claimToken: claim.claimToken,
          errorCode: failure.code,
          jobId: claim.jobId,
          nextAttemptAt: new Date(now.getTime() + delay),
          now
        }).catch(() => undefined);
        return;
      }
      await this.#repository.settleFailed({
        attachmentId: claim.id,
        claimToken: claim.claimToken,
        errorCode: failure.code,
        jobId: claim.jobId,
        now: this.#now()
      }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }
}

import { randomUUID } from "node:crypto";
import { bindContext, logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
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
const DEFAULT_SETTLE_RETRY_DELAYS_MS = [100, 500] as const;

function waitForSettleRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
  readonly #settleRetryDelaysMs: readonly number[];
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
    settleRetryDelaysMs?: readonly number[];
  }>) {
    this.#heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#maxParallel = input.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.#now = input.now ?? (() => new Date());
    this.#process = input.process;
    this.#repository = input.repository;
    this.#settleRetryDelaysMs = input.settleRetryDelaysMs ?? DEFAULT_SETTLE_RETRY_DELAYS_MS;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = runInBackground(() => setInterval(() => this.kick(), this.#intervalMs));
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
    this.#pending = runInBackground(() => this.#drain().finally(() => {
      this.#pending = null;
      if (this.#rerun) this.kick();
    }));
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
      } catch (error) {
        reportSubsystemFailure({ subsystem: "attachments", stage: "claim", prisma_code: databaseFailureCode(error), action: "retry" });
        return;
      }
      reportSubsystemHealthy("attachments", "claim");
      if (!claim) return;
      await runInBackground(() => runWithContext(
        { job_id: claim.jobId },
        () => this.#processClaim(claim)
      ));
    }
  }

  async #processClaim(claim: AttachmentProcessingRecord): Promise<void> {
    const started = performance.now();
    logEvent("job_attempt", { subsystem: "attachments", stage: "claim", outcome: "started", attempt: claim.attemptCount });
    let leaseLost = false;
    const controller = new AbortController();
    const heartbeat = setInterval(bindContext(() => {
      void this.#repository.heartbeat({
        claimToken: claim.claimToken,
        jobId: claim.jobId,
        now: this.#now()
      }).then((accepted) => {
        if (!accepted) {
          if (!leaseLost) logEvent("job_attempt", { subsystem: "attachments", stage: "heartbeat", outcome: "lost_lease",
            code: "attachment_processing_lease_lost", action: "stop", attempt: claim.attemptCount });
          leaseLost = true;
          controller.abort(new Error("attachment_processing_lease_lost"));
        } else reportSubsystemHealthy("attachments", "heartbeat");
      }).catch((error: unknown) => reportSubsystemFailure({ subsystem: "attachments", stage: "heartbeat",
        prisma_code: databaseFailureCode(error), action: "wait" }));
    }), this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      let result: AttachmentProcessingResult;
      try {
        result = await this.#process(claim, controller.signal);
      } catch (error) {
        if (!leaseLost) await this.#settleProcessingFailure(claim, error);
        return;
      }

      if (leaseLost) return;
      logEvent("job_attempt", { subsystem: "attachments", stage: "process", outcome: "completed",
        attempt: claim.attemptCount, duration_ms: performance.now() - started });
      await this.#settleReady(claim, result, controller.signal);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #settleProcessingFailure(
    claim: AttachmentProcessingRecord,
    error: unknown
  ): Promise<void> {
    const failure = error instanceof AttachmentProcessingError
      ? error
      : new AttachmentProcessingError("attachment_processing_failed", true);
    logEvent("job_attempt", { subsystem: "attachments", stage: "process", outcome: "failed",
      attempt: claim.attemptCount, code: failure.code, prisma_code: databaseFailureCode(error), action: "none" });
    if (failure.retryable && claim.attemptCount < this.#maxAttempts) {
      const delay = RETRY_DELAYS_MS[Math.min(claim.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ??
        RETRY_DELAYS_MS.at(-1)!;
      const now = this.#now();
      const nextAttemptAt = new Date(now.getTime() + delay);
      try {
        const accepted = await this.#repository.retryLater({
          claimToken: claim.claimToken, errorCode: failure.code, jobId: claim.jobId, nextAttemptAt, now
        });
        logEvent("job_persistence", { subsystem: "attachments", stage: "retry", outcome: accepted ? "confirmed" : "not_applied",
          attempt: claim.attemptCount, code: failure.code, action: accepted ? "retry" : "skip",
          ...(accepted ? { delay_ms: delay, retry_at: nextAttemptAt.toISOString() } : {}) });
      } catch (writeError) {
        logEvent("job_persistence", { subsystem: "attachments", stage: "retry", outcome: "unconfirmed",
          attempt: claim.attemptCount, prisma_code: databaseFailureCode(writeError), action: "wait" });
      }
      return;
    }
    try {
      const accepted = await this.#repository.settleFailed({
        attachmentId: claim.id, claimToken: claim.claimToken, errorCode: failure.code, jobId: claim.jobId, now: this.#now()
      });
      logEvent("job_persistence", { subsystem: "attachments", stage: "fail", outcome: accepted ? "confirmed" : "not_applied",
        attempt: claim.attemptCount, code: failure.code, action: accepted ? "fail" : "skip" });
    } catch (writeError) {
      logEvent("job_persistence", { subsystem: "attachments", stage: "fail", outcome: "unconfirmed",
        attempt: claim.attemptCount, prisma_code: databaseFailureCode(writeError), action: "wait" });
    }
  }

  async #settleReady(
    claim: AttachmentProcessingRecord,
    result: AttachmentProcessingResult,
    signal: AbortSignal
  ): Promise<void> {
    let retryIndex = 0;
    while (!signal.aborted) {
      try {
        const accepted = await this.#repository.settleReady({
          attachmentId: claim.id,
          claimToken: claim.claimToken,
          jobId: claim.jobId,
          now: this.#now(),
          result
        });
        logEvent("job_persistence", { subsystem: "attachments", stage: "complete", outcome: accepted ? "confirmed" : "not_applied",
          attempt: claim.attemptCount, action: accepted ? "complete" : "skip" });
        return;
      } catch (error) {
        const delayMs = this.#settleRetryDelaysMs[retryIndex];
        logEvent("job_persistence", { subsystem: "attachments", stage: "complete", outcome: "unconfirmed",
          attempt: claim.attemptCount, prisma_code: databaseFailureCode(error), action: typeof delayMs === "number" ? "retry" : "wait",
          ...(typeof delayMs === "number" ? { delay_ms: delayMs } : {}) });
        if (typeof delayMs !== "number") return;
        retryIndex += 1;
        if (!await waitForSettleRetry(delayMs, signal)) return;
      }
    }
  }
}

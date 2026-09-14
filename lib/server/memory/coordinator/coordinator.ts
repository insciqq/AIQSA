import { randomUUID } from "node:crypto";
import {
  logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext,
  type LifecycleStage
} from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { memoryAttempt, memoryFailureOutcome, memoryPersistence, memoryStage } from "./observability";
import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import {
  isMemoryCoordinatorErrorCode,
  MemoryCoordinatorError
} from "./errors";
import {
  memoryRetryDelay,
  resolveMemoryCoordinatorPolicy,
  type MemoryCoordinatorPolicy
} from "./policy";
import type { MemoryCoordinatorRepository } from "./prismaRepository";
import {
  memoryCoordinatorJobMaxAttempts,
  type MemoryCoordinatorRegistry
} from "./registry";
import { MemoryScheduler } from "./scheduler";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim,
  MemoryJobExecutionResult,
  MemoryJobGateDecision
} from "./types";
import { decodeMemoryOperationalCounters } from "../operational/counters";

const sha256 = /^[a-f0-9]{64}$/u;
function reportFailure(stage: LifecycleStage, error: unknown): void {
  reportSubsystemFailure({ subsystem: "memory", stage, action: "retry",
    code: error instanceof MemoryCoordinatorError ? error.code : "memory_coordinator_failed",
    prisma_code: databaseFailureCode(error) });
}

const safeStage = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  const result = new Date(value.getTime() + milliseconds);
  if (!validDate(result)) throw new Error("memory_coordinator_clock_invalid");
  return result;
}

function validGateDecision(value: MemoryJobGateDecision): boolean {
  return value.status === "READY" ||
    isMemoryCoordinatorErrorCode(value.errorCode);
}

function validJobResult(value: MemoryJobExecutionResult): boolean {
  return Boolean(value) && sha256.test(value.acceptedResultHash) &&
    (value.stage === undefined || value.stage === null || safeStage.test(value.stage)) &&
    (value.operationalCounters === undefined ||
      decodeMemoryOperationalCounters(value.operationalCounters) !== null) &&
    (value.apply === undefined || typeof value.apply === "function");
}

export class MemoryCoordinator {
  readonly #activeControllers = new Set<AbortController>();
  readonly #failedHeartbeats = new Set<AbortController>();
  readonly #now: () => Date;
  readonly #onDrain: (() => Promise<void>) | null;
  readonly #policy: MemoryCoordinatorPolicy;
  readonly #registry: MemoryCoordinatorRegistry;
  readonly #repository: MemoryCoordinatorRepository;
  readonly #reconcileWork: (() => Promise<void>) | null;
  readonly #scheduler: MemoryScheduler;
  #pending: Promise<void> | null = null;
  #rerun = false;
  #running = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: Readonly<{
    now?: () => Date;
    onDrain?: () => Promise<void>;
    policy?: Partial<MemoryCoordinatorPolicy>;
    reconcileWork?: () => Promise<void>;
    registry: MemoryCoordinatorRegistry;
    repository: MemoryCoordinatorRepository;
    scheduler?: MemoryScheduler;
  }>) {
    this.#now = input.now ?? (() => new Date());
    this.#onDrain = input.onDrain ?? null;
    this.#policy = resolveMemoryCoordinatorPolicy(input.policy);
    this.#reconcileWork = input.reconcileWork ?? null;
    this.#registry = input.registry;
    this.#repository = input.repository;
    this.#scheduler = input.scheduler ?? new MemoryScheduler({
      policy: this.#policy
    });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = false;
    this.kick();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#rerun = false;
    this.#running = false;
    this.#stopped = true;
    for (const controller of this.#activeControllers) {
      controller.abort(new Error("memory_coordinator_stopped"));
    }
  }

  kick(): void {
    this.#schedule(true);
  }

  #armTimer(): void {
    if (!this.#running || this.#stopped || this.#pending || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#schedule(false);
    }, this.#policy.intervalMs);
    this.#timer.unref?.();
  }

  #schedule(rerunIfPending: boolean): void {
    if (this.#stopped) return;
    if (this.#pending) {
      if (rerunIfPending) this.#rerun = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = runInBackground(() => this.#drain().finally(() => {
      this.#pending = null;
      if (this.#rerun) {
        this.kick();
      } else {
        this.#armTimer();
      }
    }));
  }

  async reconcileNow(): Promise<void> {
    this.kick();
    await this.#pending;
  }

  #clock(): Date {
    const value = this.#now();
    if (!validDate(value)) throw new Error("memory_coordinator_clock_invalid");
    return new Date(value.getTime());
  }

  async #drain(): Promise<void> {
    do {
      this.#rerun = false;
      try {
        await this.#onDrain?.();
        if (this.#onDrain) reportSubsystemHealthy("memory", "health");
      } catch (error) {
        reportFailure("health", error);
        // Liveness evidence is observability, never work ownership. The next
        // idle drain retries it while durable job/deletion leases remain the
        // execution authority.
      }
      await this.#reconcileJobs();
      let claimFailed = false;
      let claimObserved = false;
      const observeClaim = (success: boolean) => {
        claimObserved = true;
        if (!success) claimFailed = true;
      };
      await Promise.all([
        ...Array.from({ length: this.#policy.maxJobParallel }, () => this.#jobWorker(observeClaim)),
        ...Array.from(
          { length: this.#policy.maxDeletionParallel },
          () => this.#deletionWorker(observeClaim)
        )
      ]);
      if (claimObserved && !claimFailed && !this.#stopped) reportSubsystemHealthy("memory", "claim");
      await this.#reconcileJobs();
      try {
        await this.#reconcileWork?.();
        if (this.#reconcileWork) reportSubsystemHealthy("memory", "discover");
      } catch (error) {
        reportFailure("discover", error);
        // The timer retries optional durable work discovery after existing
        // jobs and privacy-critical deletions have had their pass.
      }
    } while (this.#rerun && !this.#stopped);
  }

  async #reconcileJobs(): Promise<void> {
    const kinds = this.#registry.jobKinds();
    const now = this.#clock();
    try {
      // Rows written by an older build (or by a producer that forgot to
      // register a handler) must become an explicit terminal failure.  They
      // are intentionally not included in claim waves, so this is the only
      // safe cleanup path and prevents silent queue starvation.
      const unavailable = await this.#repository.terminalUnavailableJobs({
        now,
        supportedKinds: kinds
      });
      if (unavailable && unavailable > 0) {
        this.#rerun = true;
        logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "failed",
          action: "fail", code: "memory_job_handler_unavailable", count: unavailable });
      }
      if (kinds.length === 0) {
        reportSubsystemHealthy("memory", "reconcile");
        return;
      }
      const [cancelled, requeued] = await Promise.all([
        this.#repository.cancelUnavailableJobOwners({ kinds, now }),
        this.#repository.requeueDueJobs({ kinds, now })
      ]);
      if (cancelled + requeued > 0) this.#rerun = true;
      if (cancelled > 0) logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile",
        outcome: "cancelled", count: cancelled });
      if (requeued > 0) logEvent("runtime_lifecycle", { subsystem: "memory", stage: "retry",
        outcome: "completed", action: "retry", count: requeued });
      const waiting = await this.#repository.listWaitingJobs({
        kinds,
        limit: this.#policy.reconciliationBatchSize
      });
      let preflightFailed = false;
      for (const job of waiting) {
        const handler = this.#registry.jobHandler(job.kind);
        if (!handler) {
          // A repository implementation must not be able to hide a kind that
          // fell outside the active manifest.  Mark it through the same
          // durable terminal path used by normal reconciliation.
          await this.#repository.terminalUnavailableJobs({
            now: this.#clock(),
            supportedKinds: kinds
          });
          continue;
        }
        let decision: MemoryJobGateDecision;
        try {
          decision = await handler.preflight(job);
        } catch (error) {
          preflightFailed = true;
          reportFailure("preflight", error);
          continue;
        }
        if (!validGateDecision(decision)) {
          preflightFailed = true;
          reportFailure("preflight", new MemoryCoordinatorError("memory_job_gate_invalid", false));
          continue;
        }
        const resolve = () => this.#repository.resolveWaitingJob({ decision, job, now: this.#clock() });
        const resolved = decision.status === "WAITING_FOR_CONFIGURATION"
          ? await resolve()
          : await memoryPersistence(job, "preflight", resolve);
        if (resolved && decision.status !== "WAITING_FOR_CONFIGURATION") this.#rerun = true;
      }
      if (waiting.length > 0 && !preflightFailed) reportSubsystemHealthy("memory", "preflight");
      reportSubsystemHealthy("memory", "reconcile");
    } catch (error) {
      reportFailure("reconcile", error);
      // The timer owns durable reconciliation retry. Queue contents remain authoritative.
    }
  }

  async #jobWorker(observeClaim: (success: boolean) => void): Promise<void> {
    let claims = 0;
    while (claims < this.#policy.maxJobClaimsPerWorkerPass) {
      if (this.#stopped) return;
      const kinds = this.#registry.jobKinds();
      if (kinds.length === 0) return;
      const now = this.#clock();
      let claim: MemoryJobClaim | null = null;
      try {
        for (const wave of this.#scheduler.claimWaves(kinds)) {
          claim = await this.#repository.claimJob({
            claimToken: randomUUID(),
            kinds: wave,
            leaseExpiresAt: addMilliseconds(now, this.#policy.leaseMs),
            now
          });
          if (claim) break;
        }
        observeClaim(true);
      } catch (error) {
        observeClaim(false);
        reportFailure("claim", error);
        return;
      }
      if (!claim) return;
      claims += 1;
      const claimedJob = claim;
      await runInBackground(() => runWithContext(
        { job_id: claimedJob.id },
        () => this.#processJob(claimedJob)
      ));
    }
  }

  async #deletionWorker(observeClaim: (success: boolean) => void): Promise<void> {
    let claims = 0;
    while (claims < this.#policy.maxDeletionClaimsPerWorkerPass) {
      if (this.#stopped) return;
      const operations = this.#registry.deletionOperations();
      if (operations.length === 0) return;
      const now = this.#clock();
      let claim: MemoryDeletionClaim | null;
      try {
        claim = await this.#repository.claimDeletion({
          claimToken: randomUUID(),
          leaseExpiresAt: addMilliseconds(now, this.#policy.leaseMs),
          now,
          operations
        });
        observeClaim(true);
      } catch (error) {
        observeClaim(false);
        reportFailure("claim", error);
        return;
      }
      if (!claim) return;
      claims += 1;
      await runInBackground(() => runWithContext(
        { job_id: claim.id },
        () => this.#processDeletion(claim)
      ));
    }
  }

  #startHeartbeat(input: Readonly<{
    controller: AbortController;
    heartbeat: (now: Date, leaseExpiresAt: Date) => Promise<boolean>;
    lostCode: string;
    onLostLease: () => void;
    work: MemoryJobClaim | MemoryDeletionClaim;
  }>): ReturnType<typeof setInterval> {
    let pending = false;
    const timer = setInterval(() => {
      if (pending || input.controller.signal.aborted) return;
      pending = true;
      let now: Date;
      try {
        now = this.#clock();
      } catch (error) {
        reportFailure("heartbeat", error);
        input.controller.abort(new Error(input.lostCode));
        pending = false;
        return;
      }
      void memoryPersistence(input.work, "heartbeat", () =>
        input.heartbeat(now, addMilliseconds(now, this.#policy.leaseMs)), {}, true)
        .then((accepted) => {
          if (this.#activeControllers.has(input.controller)) {
            this.#failedHeartbeats.delete(input.controller);
            if (this.#failedHeartbeats.size === 0) reportSubsystemHealthy("memory", "heartbeat");
          }
          if (!accepted) {
            input.onLostLease();
            input.controller.abort(new Error(input.lostCode));
          }
        })
        .catch((error) => {
          if (this.#activeControllers.has(input.controller)) {
            this.#failedHeartbeats.add(input.controller);
            reportFailure("heartbeat", error);
          }
          input.controller.abort(new Error(input.lostCode));
        })
        .finally(() => {
          pending = false;
        });
    }, this.#policy.heartbeatMs);
    timer.unref?.();
    return timer;
  }

  async #processJob(claim: MemoryJobClaim): Promise<void> {
    const controller = new AbortController();
    let leaseLost = false;
    let stage: LifecycleStage = "preflight";
    memoryAttempt(claim, { stage: claim.recoveredLease ? "recovery" : "claim", outcome: "started" });
    this.#activeControllers.add(controller);
    const heartbeat = this.#startHeartbeat({
      controller,
      heartbeat: (now, leaseExpiresAt) => this.#repository.heartbeatJob({
        claim,
        leaseExpiresAt,
        now
      }),
      lostCode: "memory_job_lease_lost",
      onLostLease: () => { leaseLost = true; },
      work: claim
    });
    let currentStage = claim.stage;
    let releaseOwner: (() => void) | null = null;
    try {
      releaseOwner = await this.#scheduler.acquireOwner(
        claim.userId,
        controller.signal
      );
      const handler = this.#registry.jobHandler(claim.kind);
      if (!handler) {
        // This should only be reachable during a rolling deployment race;
        // terminalise immediately rather than retrying a permanently
        // unsupported kind.
        throw new MemoryCoordinatorError("memory_job_handler_unavailable", false);
      }
      const decision = await handler.preflight(claim);
      if (!validGateDecision(decision)) {
        throw new MemoryCoordinatorError("memory_job_gate_invalid", false);
      }
      if (decision.status !== "READY") {
        memoryAttempt(claim, { stage: "preflight", code: decision.errorCode,
          outcome: decision.status === "WAITING_FOR_CONFIGURATION" ? "waiting"
            : decision.status === "CANCELLED" ? "cancelled" : "stale" });
        const accepted = await memoryPersistence(claim, "preflight", () => this.#repository.settleJobGate({
          claim,
          decision,
          now: this.#clock()
        }));
        if (!accepted) {
          leaseLost = true;
          controller.abort(new Error("memory_job_lease_lost"));
        }
        return;
      }
      stage = "process";
      const result = await handler.execute(claim, {
        now: () => this.#clock(),
        setStage: async (requestedStage) => {
          if (!safeStage.test(requestedStage)) {
            throw new MemoryCoordinatorError("memory_job_stage_invalid", false);
          }
          stage = "progress";
          const workStage = memoryStage(requestedStage);
          const accepted = await memoryPersistence(claim, "progress", () => this.#repository.setJobStage({
            claim,
            now: this.#clock(),
            stage: requestedStage
          }), { work_stage: workStage });
          if (!accepted) {
            leaseLost = true;
            controller.abort(new Error("memory_job_lease_lost"));
            throw new MemoryCoordinatorError("memory_job_lease_lost", false);
          }
          currentStage = requestedStage;
          stage = workStage;
        },
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      if (!validJobResult(result)) {
        throw new MemoryCoordinatorError("memory_job_result_invalid", false);
      }
      stage = "preflight";
      const commitDecision = await handler.preflight(claim);
      if (!validGateDecision(commitDecision)) {
        throw new MemoryCoordinatorError("memory_job_gate_invalid", false);
      }
      if (commitDecision.status !== "READY") {
        memoryAttempt(claim, { stage: "preflight", code: commitDecision.errorCode,
          outcome: commitDecision.status === "WAITING_FOR_CONFIGURATION" ? "waiting"
            : commitDecision.status === "CANCELLED" ? "cancelled" : "stale" });
        const accepted = await memoryPersistence(claim, "preflight", () => this.#repository.settleJobGate({
          claim,
          decision: commitDecision,
          now: this.#clock()
        }));
        if (!accepted) {
          leaseLost = true;
          controller.abort(new Error("memory_job_lease_lost"));
        }
        return;
      }
      stage = "complete";
      const committed = await memoryPersistence(claim, "complete", () => this.#repository.commitJobSuccess({
        acceptedResultHash: result.acceptedResultHash,
        apply: result.apply,
        claim,
        now: this.#clock(),
        operationalCounters: result.operationalCounters,
        stage: result.stage === undefined ? currentStage : result.stage
      }));
      if (!committed) {
        leaseLost = true;
        controller.abort(new Error("memory_job_lease_lost"));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof MemoryCoordinatorError
        ? error
        : new MemoryCoordinatorError("memory_job_failed", true);
      const now = this.#clock();
      const maxAttempts = memoryCoordinatorJobMaxAttempts(
        claim.kind,
        this.#policy.maxJobAttempts
      );
      const retry = failure.retryable && claim.attemptCount < maxAttempts;
      memoryAttempt(claim, { stage, outcome: memoryFailureOutcome(failure.code), code: failure.code,
        prisma_code: databaseFailureCode(error), action: retry ? "retry" : "fail" });
      if (retry) {
        const delay = memoryRetryDelay(this.#policy.jobRetryDelaysMs, claim.attemptCount);
        const nextAttemptAt = addMilliseconds(now, delay);
        await memoryPersistence(claim, "retry", () => this.#repository.retryJob({
          claim, errorCode: failure.code, nextAttemptAt, now
        }), { action: "retry", code: failure.code, delay_ms: delay, retry_at: nextAttemptAt.toISOString() }).catch(() => false);
      } else {
        await memoryPersistence(claim, "fail", () => this.#repository.terminalJob({
          claim, errorCode: failure.code, now
        }), { action: "fail", code: failure.code }).catch(() => false);
      }
    } finally {
      if (controller.signal.aborted) memoryAttempt(claim, { stage,
        outcome: leaseLost ? "lost_lease" : "cancelled", action: "stop" });
      releaseOwner?.();
      clearInterval(heartbeat);
      this.#activeControllers.delete(controller);
      this.#failedHeartbeats.delete(controller);
    }
  }

  async #processDeletion(claim: MemoryDeletionClaim): Promise<void> {
    const controller = new AbortController();
    let leaseLost = false;
    let stage: LifecycleStage = "delete";
    memoryAttempt(claim, { stage: claim.recoveredLease ? "recovery" : "claim", outcome: "started" });
    this.#activeControllers.add(controller);
    const heartbeat = this.#startHeartbeat({
      controller,
      heartbeat: (now, leaseExpiresAt) => this.#repository.heartbeatDeletion({
        claim,
        leaseExpiresAt,
        now
      }),
      lostCode: "memory_deletion_lease_lost",
      onLostLease: () => { leaseLost = true; },
      work: claim
    });
    try {
      const handler = this.#registry.deletionHandler(claim.operation);
      if (!handler) {
        throw new MemoryCoordinatorError("memory_deletion_handler_unavailable", true);
      }
      const result = await handler.execute(claim, {
        now: () => this.#clock(),
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      if (!result || (result.apply !== undefined && typeof result.apply !== "function")) {
        throw new MemoryCoordinatorError("memory_deletion_result_invalid", true);
      }
      stage = "complete";
      const committed = await memoryPersistence(claim, "complete", () => this.#repository.commitDeletionSuccess({
        apply: result.apply,
        claim,
        now: this.#clock()
      }));
      if (!committed) {
        leaseLost = true;
        controller.abort(new Error("memory_deletion_lease_lost"));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof MemoryCoordinatorError
        ? error
        : new MemoryCoordinatorError("memory_deletion_failed", true);
      const now = this.#clock();
      const blocked = claim.resumedFromBlocked ||
        claim.attemptCount >= this.#policy.maxDeletionFastAttempts;
      const delay = blocked
        ? this.#policy.blockedDeletionRetryMs
        : memoryRetryDelay(
            this.#policy.deletionFastRetryDelaysMs,
            claim.attemptCount
          );
      memoryAttempt(claim, { stage, outcome: memoryFailureOutcome(failure.code, blocked ? "blocked" : "failed"), code: failure.code,
        prisma_code: databaseFailureCode(error), action: "retry" });
      const nextAttemptAt = addMilliseconds(now, delay);
      await memoryPersistence(claim, "retry", () => this.#repository.retryDeletion({
        blocked, claim, errorCode: failure.code, nextAttemptAt, now
      }), { action: "retry", code: failure.code, delay_ms: delay, retry_at: nextAttemptAt.toISOString() }).catch(() => false);
    } finally {
      if (controller.signal.aborted) memoryAttempt(claim, { stage,
        outcome: leaseLost ? "lost_lease" : "cancelled", action: "stop" });
      clearInterval(heartbeat);
      this.#activeControllers.delete(controller);
      this.#failedHeartbeats.delete(controller);
    }
  }
}

export type { MemoryDeletionOperation, MemoryJobKind };

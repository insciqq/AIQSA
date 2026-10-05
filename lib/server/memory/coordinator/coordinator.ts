import { randomUUID } from "node:crypto";
import {
  logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext,
  type LifecycleOutcome, type LifecycleStage
} from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { memoryAttempt, memoryFailureOutcome, memoryPersistence, memoryStage } from "./observability";
import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import {
  isMemoryCoordinatorErrorCode,
  MemoryCoordinatorError,
  MemoryJobFencedError
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
  MemoryJobFenceDecision,
  MemoryJobGateDecision,
  MemoryJobHandler
} from "./types";
import { decodeMemoryOperationalCounters } from "../operational/counters";
import { MEMORY_RECOVERY_BATCH_SIZE, MEMORY_RECOVERY_INTERVAL_MS } from "./recoveryPolicy";

const sha256 = /^[a-f0-9]{64}$/u;
const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Compose stops the worker 30 s after SIGTERM. Stop waits at most this long
 * for claimed work to settle its executions, leaving the entrypoint time to
 * clear liveness and close the database. Work still running stays claimed
 * until its lease expires and recovers after restart. */
export const MEMORY_COORDINATOR_SHUTDOWN_DRAIN_MS = 20_000;
const MAX_SHUTDOWN_DRAIN_MS = 25_000;

export type MemoryCoordinatorStopResult = Readonly<{
  /** False when the bound elapsed before this coordinator's work settled. */
  drained: boolean;
  /** Claimed jobs and deletions still running when stop returned. */
  pendingCount: number;
}>;

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

function fenceOutcome(decision: MemoryJobFenceDecision): LifecycleOutcome {
  return decision.status === "CANCELLED" ? "cancelled" : "stale";
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
  readonly #leaseWrites = new Set<Promise<void>>();
  readonly #now: () => Date;
  readonly #onWorkerHeartbeat: (() => Promise<void>) | null;
  readonly #policy: MemoryCoordinatorPolicy;
  readonly #registry: MemoryCoordinatorRegistry;
  readonly #repository: MemoryCoordinatorRepository;
  readonly #reconcileWork: ((signal: AbortSignal) => Promise<void>) | null;
  readonly #scheduler: MemoryScheduler;
  /** Aborted when stop begins; discovery admits no further work after it. */
  #admission = new AbortController();
  #busyDiscoveryPhase: object | null = null;
  #discoveryPending: Promise<void> | null = null;
  #discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #idleJobSlots = new Set<() => void>();
  #pending: Promise<void> | null = null;
  #runningJobs = 0;
  #rerun = false;
  #running = false;
  #stopped = false;
  #stopping: Promise<MemoryCoordinatorStopResult> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #workerHeartbeatPending: Promise<void> | null = null;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #nextRecoveryAt = 0;

  constructor(input: Readonly<{
    now?: () => Date;
    onWorkerHeartbeat?: () => Promise<void>;
    policy?: Partial<MemoryCoordinatorPolicy>;
    /** Durable work discovery. The signal aborts when stop begins; a pass
     * stops admitting work at its next step. */
    reconcileWork?: (signal: AbortSignal) => Promise<void>;
    registry: MemoryCoordinatorRegistry;
    repository: MemoryCoordinatorRepository;
    scheduler?: MemoryScheduler;
  }>) {
    this.#now = input.now ?? (() => new Date());
    this.#onWorkerHeartbeat = input.onWorkerHeartbeat ?? null;
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
    this.#stopping = null;
    if (this.#admission.signal.aborted) this.#admission = new AbortController();
    if (this.#onWorkerHeartbeat) {
      runInBackground(() => {
        this.#workerHeartbeatTimer = setInterval(
          () => this.#beatWorkerHeartbeat(), WORKER_HEARTBEAT_INTERVAL_MS
        );
        this.#workerHeartbeatTimer.unref?.();
        this.#beatWorkerHeartbeat();
      });
    }
    this.kick();
  }

  /** Ends admission at once: no claim, reconciliation or discovery starts
   * after this call, and a claim already in flight never starts its work.
   * Active jobs and deletions are aborted, then stop waits, bounded, until
   * they have settled their executions and no database write of this
   * coordinator is in flight. Repeated calls share one stop; it never rejects. */
  stop(options: Readonly<{ drainTimeoutMs?: number }> = {}): Promise<MemoryCoordinatorStopResult> {
    const bound = options.drainTimeoutMs ?? MEMORY_COORDINATOR_SHUTDOWN_DRAIN_MS;
    this.#stopping ??= this.#shutdown(Number.isSafeInteger(bound) && bound >= 0 &&
      bound <= MAX_SHUTDOWN_DRAIN_MS ? bound : MEMORY_COORDINATOR_SHUTDOWN_DRAIN_MS);
    return this.#stopping;
  }

  async #shutdown(drainTimeoutMs: number): Promise<MemoryCoordinatorStopResult> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#stopBusyDiscovery();
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    this.#timer = null;
    this.#workerHeartbeatTimer = null;
    this.#rerun = false;
    this.#running = false;
    this.#stopped = true;
    this.#admission.abort(new Error("memory_coordinator_stopped"));
    this.#wakeIdleJobSlots();
    const active = this.#activeControllers.size;
    for (const controller of this.#activeControllers) {
      controller.abort(new Error("memory_coordinator_stopped"));
    }
    const startedAt = Date.now();
    // Aborted work still settles its executions; a database write already in
    // flight cannot be cancelled. The entrypoint disconnects only after this.
    const drained = await this.#quiesce(drainTimeoutMs);
    const pendingCount = drained ? 0 : this.#activeControllers.size;
    if (!drained || active > 0) {
      logEvent("runtime_lifecycle", { subsystem: "memory", stage: "shutdown", action: "stop",
        outcome: drained ? "completed" : "failed",
        code: drained ? undefined : "memory_coordinator_drain_timeout",
        count: active, pending_count: pendingCount, duration_ms: Date.now() - startedAt });
    }
    return Object.freeze({ drained, pendingCount });
  }

  /** Waits for the current pass with its claimed jobs and deletions,
   * discovery, worker liveness and lease writes. False when the bound wins. */
  async #quiesce(timeoutMs: number): Promise<boolean> {
    const inFlight = () => [
      this.#pending, this.#discoveryPending, this.#workerHeartbeatPending, ...this.#leaseWrites
    ].filter((work): work is Promise<void> => work !== null);
    let pending = inFlight();
    if (pending.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      while (pending.length > 0) {
        if (!await Promise.race([Promise.allSettled(pending).then(() => true), deadline])) return false;
        pending = inFlight();
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  kick(): void {
    this.#schedule(true);
  }

  #beatWorkerHeartbeat(): void {
    if (!this.#running || this.#stopped || this.#workerHeartbeatPending || !this.#onWorkerHeartbeat) return;
    this.#workerHeartbeatPending = runInBackground(async () => {
      try {
        await this.#onWorkerHeartbeat!();
        if (!this.#stopped) reportSubsystemHealthy("memory", "health");
      } catch (error) {
        reportFailure("health", error);
        // Installation liveness is observability, never job ownership. Its
        // independent timer retries without changing durable job/deletion leases.
      }
    }).finally(() => { this.#workerHeartbeatPending = null; });
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
      await this.#reconcileJobs();
      if (this.#stopped) return;
      let claimFailed = false;
      let claimObserved = false;
      const observeClaim = (success: boolean) => {
        claimObserved = true;
        if (!success) claimFailed = true;
      };
      const jobLane = Promise.all(
        Array.from({ length: this.#policy.maxJobParallel }, () => this.#jobWorker(observeClaim))
      );
      const deletionLane = Promise.all(Array.from(
        { length: this.#policy.maxDeletionParallel },
        () => this.#deletionWorker(observeClaim)
      ));
      // One long job must not starve optional discovery for the rest of the
      // pass. Its own cadence starts only after this pass reconciled jobs and
      // drained privacy-critical deletions, so their precedence is unchanged.
      const phase = {};
      this.#busyDiscoveryPhase = phase;
      void deletionLane.then(() => this.#armBusyDiscovery(phase), () => undefined);
      try {
        await Promise.all([jobLane, deletionLane]);
      } finally {
        this.#stopBusyDiscovery();
      }
      // A stopped pass ends with its claimed work: nothing is reconciled,
      // requeued or discovered after stop began.
      if (this.#stopped) return;
      if (claimObserved && !claimFailed) reportSubsystemHealthy("memory", "claim");
      await this.#reconcileJobs();
      // The pass still ends with discovery that starts after its claims and
      // reconciliation; it waits for a busy-phase pass instead of overlapping.
      while (this.#discoveryPending) await this.#discoveryPending;
      await this.#discover();
    } while (this.#rerun && !this.#stopped);
  }

  /** Single-flight per process: callers start a pass only when none is pending. */
  #discover(): Promise<void> {
    const reconcileWork = this.#reconcileWork;
    if (!reconcileWork || this.#stopped) return Promise.resolve();
    if (this.#discoveryPending) return this.#discoveryPending;
    const signal = this.#admission.signal;
    const pass = runInBackground(async () => {
      try {
        await reconcileWork(signal);
        reportSubsystemHealthy("memory", "discover");
      } catch (error) {
        reportFailure("discover", error);
        // A later cadence tick or pass retries optional durable work
        // discovery; queue contents remain authoritative.
      }
    }).finally(() => {
      if (this.#discoveryPending === pass) this.#discoveryPending = null;
    });
    this.#discoveryPending = pass;
    return pass;
  }

  /** Re-arms only after a pass settles, so a slow pass cannot cause catch-up. */
  #armBusyDiscovery(phase: object): void {
    if (!this.#reconcileWork || !this.#running || this.#stopped ||
      this.#busyDiscoveryPhase !== phase || this.#discoveryTimer) return;
    this.#discoveryTimer = setTimeout(() => {
      this.#discoveryTimer = null;
      if (this.#stopped || this.#busyDiscoveryPhase !== phase) return;
      void this.#discover().finally(() => this.#armBusyDiscovery(phase));
    }, this.#policy.intervalMs);
    this.#discoveryTimer.unref?.();
  }

  #stopBusyDiscovery(): void {
    if (this.#discoveryTimer) clearTimeout(this.#discoveryTimer);
    this.#discoveryTimer = null;
    this.#busyDiscoveryPhase = null;
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
      // Stop ends reconciliation between its writes: nothing is requeued,
      // recovered or released from waiting after stop began.
      if (this.#stopped) return;
      const [cancelled, requeued] = await Promise.all([
        this.#repository.cancelUnavailableJobOwners({ kinds, now }),
        this.#repository.requeueDueJobs({
          kinds,
          limit: this.#policy.reconciliationBatchSize,
          now
        })
      ]);
      if (cancelled + requeued > 0) this.#rerun = true;
      if (cancelled > 0) logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile",
        outcome: "cancelled", count: cancelled });
      if (requeued > 0) logEvent("runtime_lifecycle", { subsystem: "memory", stage: "retry",
        outcome: "completed", action: "retry", count: requeued });
      if (this.#stopped) return;
      if (now.getTime() >= this.#nextRecoveryAt) {
        this.#nextRecoveryAt = now.getTime() + MEMORY_RECOVERY_INTERVAL_MS;
        const recovered = await this.#repository.recoverEligibleJobs({
          limit: MEMORY_RECOVERY_BATCH_SIZE, now
        });
        if (recovered > 0) {
          this.#rerun = true;
          logEvent("runtime_lifecycle", { subsystem: "memory", stage: "recovery",
            outcome: "completed", action: "retry", count: recovered });
        }
      }
      if (this.#stopped) return;
      const waiting = await this.#repository.listWaitingJobs({
        kinds,
        limit: this.#policy.reconciliationBatchSize
      });
      let preflightFailed = false;
      for (const job of waiting) {
        if (this.#stopped) return;
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
      if (!claim) {
        // A sibling's long job keeps this pass open. Rather than leave work
        // enqueued meanwhile waiting for it, the idle slot claims again once
        // per interval (or when a job settles); with no running sibling it
        // ends the pass as before.
        if (this.#runningJobs === 0) return;
        await this.#waitForIdleJobSlotTick();
        if (this.#runningJobs === 0) return;
        continue;
      }
      if (this.#stopped) {
        // The claim committed while stop began. Its work never starts here;
        // the lease returns the job to the queue for the next worker.
        memoryAttempt(claim, { stage: "claim", outcome: "cancelled", action: "stop" });
        return;
      }
      claims += 1;
      const claimedJob = claim;
      this.#runningJobs += 1;
      try {
        await runInBackground(() => runWithContext(
          { job_id: claimedJob.id },
          () => this.#processJob(claimedJob)
        ));
      } finally {
        this.#runningJobs -= 1;
        this.#wakeIdleJobSlots();
      }
    }
  }

  #waitForIdleJobSlotTick(): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#idleJobSlots.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, this.#policy.intervalMs);
      timer.unref?.();
      this.#idleJobSlots.add(wake);
    });
  }

  #wakeIdleJobSlots(): void {
    for (const wake of [...this.#idleJobSlots]) wake();
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
      if (this.#stopped) {
        memoryAttempt(claim, { stage: "claim", outcome: "cancelled", action: "stop" });
        return;
      }
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
      this.#trackLeaseWrite(memoryPersistence(input.work, "heartbeat", () =>
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
        }));
    }, this.#policy.heartbeatMs);
    timer.unref?.();
    return timer;
  }

  /** A lease write outlives its job's interval; stop waits for it. */
  #trackLeaseWrite(write: Promise<void>): void {
    this.#leaseWrites.add(write);
    const settled = () => { this.#leaseWrites.delete(write); };
    void write.then(settled, settled);
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
    let registeredHandler: MemoryJobHandler | null = null;
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
      registeredHandler = handler;
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
      const maxAttempts = memoryCoordinatorJobMaxAttempts(
        claim.kind,
        this.#policy.maxJobAttempts
      );
      const retry = failure.retryable && claim.attemptCount < maxAttempts;
      const fence = retry ? null : await this.#failureFence(registeredHandler, claim, failure);
      const now = this.#clock();
      memoryAttempt(claim, { stage, code: failure.code, prisma_code: databaseFailureCode(error),
        outcome: fence && failure instanceof MemoryJobFencedError
          ? fenceOutcome(fence) : memoryFailureOutcome(failure.code),
        action: retry ? "retry" : fence ? "none" : "fail" });
      if (retry) {
        const delay = memoryRetryDelay(this.#policy.jobRetryDelaysMs, claim.attemptCount);
        const nextAttemptAt = addMilliseconds(now, delay);
        await memoryPersistence(claim, "retry", () => this.#repository.retryJob({
          claim, errorCode: failure.code, nextAttemptAt, now
        }), { action: "retry", code: failure.code, delay_ms: delay, retry_at: nextAttemptAt.toISOString() }).catch(() => false);
      } else if (fence) {
        memoryAttempt(claim, { stage: "preflight", code: fence.errorCode, outcome: fenceOutcome(fence) });
        await memoryPersistence(claim, "preflight", () => this.#repository.settleJobGate({
          claim, decision: fence, now
        }), { code: fence.errorCode }).catch(() => false);
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

  /** Work often fails because the fence it raced already won. Before any
   * terminal write the gate runs again, as the commit gate would have: its
   * STALE/CANCELLED decision settles the job, so fenced work never becomes a
   * failure that blocks its source. READY keeps a genuine failure terminal; a
   * waiting gate never re-admits a failed attempt; a gate that cannot decide
   * never masks a failure, except a proven fence that carries its decision. */
  async #failureFence(
    handler: MemoryJobHandler | null,
    claim: MemoryJobClaim,
    failure: MemoryCoordinatorError
  ): Promise<MemoryJobFenceDecision | null> {
    if (!handler || failure.code === "memory_job_lease_lost") return null;
    const proven = failure instanceof MemoryJobFencedError ? failure.decision : null;
    let decision: MemoryJobGateDecision | null;
    try {
      decision = await handler.preflight(claim);
    } catch {
      decision = null;
    }
    if (decision && decision.status === "READY") return null;
    if (decision && (decision.status === "STALE" || decision.status === "CANCELLED") &&
      isMemoryCoordinatorErrorCode(decision.errorCode)) {
      return { errorCode: decision.errorCode, status: decision.status };
    }
    return proven;
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

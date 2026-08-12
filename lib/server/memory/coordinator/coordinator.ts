import { randomUUID } from "node:crypto";
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
import type { MemoryCoordinatorRegistry } from "./registry";
import {
  createEmptyMemorySchedulerUsageSource,
  MemoryScheduler
} from "./scheduler";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim,
  MemoryJobExecutionResult,
  MemoryJobGateDecision
} from "./types";

const sha256 = /^[a-f0-9]{64}$/u;
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
    (value.apply === undefined || typeof value.apply === "function");
}

export class MemoryCoordinator {
  readonly #activeControllers = new Set<AbortController>();
  readonly #now: () => Date;
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
    policy?: Partial<MemoryCoordinatorPolicy>;
    reconcileWork?: () => Promise<void>;
    registry: MemoryCoordinatorRegistry;
    repository: MemoryCoordinatorRepository;
    scheduler?: MemoryScheduler;
  }>) {
    this.#now = input.now ?? (() => new Date());
    this.#policy = resolveMemoryCoordinatorPolicy(input.policy);
    this.#reconcileWork = input.reconcileWork ?? null;
    this.#registry = input.registry;
    this.#repository = input.repository;
    this.#scheduler = input.scheduler ?? new MemoryScheduler({
      policy: this.#policy,
      usageSource: createEmptyMemorySchedulerUsageSource()
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
    this.#pending = this.#drain().finally(() => {
      this.#pending = null;
      if (this.#rerun) {
        this.kick();
      } else {
        this.#armTimer();
      }
    });
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
      await Promise.all([
        ...Array.from({ length: this.#policy.maxJobParallel }, () => this.#jobWorker()),
        ...Array.from(
          { length: this.#policy.maxDeletionParallel },
          () => this.#deletionWorker()
        )
      ]);
      await this.#reconcileJobs();
      try {
        await this.#reconcileWork?.();
      } catch {
        // The timer retries optional durable work discovery after existing
        // jobs and privacy-critical deletions have had their pass.
      }
    } while (this.#rerun && !this.#stopped);
  }

  async #reconcileJobs(): Promise<void> {
    const kinds = this.#registry.jobKinds();
    if (kinds.length === 0) return;
    const now = this.#clock();
    try {
      const [cancelled, requeued] = await Promise.all([
        this.#repository.cancelUnavailableJobOwners({ kinds, now }),
        this.#repository.requeueDueJobs({ kinds, now })
      ]);
      if (cancelled + requeued > 0) this.#rerun = true;
      const waiting = await this.#repository.listWaitingJobs({
        kinds,
        limit: this.#policy.reconciliationBatchSize
      });
      for (const job of waiting) {
        const handler = this.#registry.jobHandler(job.kind);
        if (!handler) continue;
        let decision: MemoryJobGateDecision;
        try {
          decision = await handler.preflight(job);
        } catch {
          continue;
        }
        if (!validGateDecision(decision) || decision.status === "WAITING_FOR_EGRESS_CONSENT") {
          continue;
        }
        if (await this.#repository.resolveWaitingJob({
          decision,
          job,
          now: this.#clock()
        })) {
          this.#rerun = true;
        }
      }
    } catch {
      // The timer owns durable reconciliation retry. Queue contents remain authoritative.
    }
  }

  async #jobWorker(): Promise<void> {
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
      } catch {
        return;
      }
      if (!claim) return;
      claims += 1;
      await this.#processJob(claim);
    }
  }

  async #deletionWorker(): Promise<void> {
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
      } catch {
        return;
      }
      if (!claim) return;
      claims += 1;
      await this.#processDeletion(claim);
    }
  }

  #startHeartbeat(input: Readonly<{
    controller: AbortController;
    heartbeat: (now: Date, leaseExpiresAt: Date) => Promise<boolean>;
    lostCode: string;
  }>): ReturnType<typeof setInterval> {
    let pending = false;
    const timer = setInterval(() => {
      if (pending || input.controller.signal.aborted) return;
      pending = true;
      let now: Date;
      try {
        now = this.#clock();
      } catch {
        input.controller.abort(new Error(input.lostCode));
        pending = false;
        return;
      }
      void input.heartbeat(now, addMilliseconds(now, this.#policy.leaseMs))
        .then((accepted) => {
          if (!accepted) input.controller.abort(new Error(input.lostCode));
        })
        .catch(() => {
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
    this.#activeControllers.add(controller);
    const heartbeat = this.#startHeartbeat({
      controller,
      heartbeat: (now, leaseExpiresAt) => this.#repository.heartbeatJob({
        claim,
        leaseExpiresAt,
        now
      }),
      lostCode: "memory_job_lease_lost"
    });
    let currentStage = claim.stage;
    let releaseOwner: (() => void) | null = null;
    try {
      const schedulerDecision = await this.#scheduler.decide(claim, this.#clock());
      if (schedulerDecision.status === "DEFER") {
        const accepted = await this.#repository.deferJob({
          claim,
          errorCode: schedulerDecision.errorCode,
          nextAttemptAt: schedulerDecision.nextAttemptAt,
          now: this.#clock()
        });
        if (!accepted) controller.abort(new Error("memory_job_lease_lost"));
        return;
      }
      releaseOwner = await this.#scheduler.acquireOwner(
        claim.userId,
        controller.signal
      );
      const handler = this.#registry.jobHandler(claim.kind);
      if (!handler) throw new MemoryCoordinatorError("memory_job_handler_unavailable", true);
      const decision = await handler.preflight(claim);
      if (!validGateDecision(decision)) {
        throw new MemoryCoordinatorError("memory_job_gate_invalid", false);
      }
      if (decision.status !== "READY") {
        const accepted = await this.#repository.settleJobGate({
          claim,
          decision,
          now: this.#clock()
        });
        if (!accepted) controller.abort(new Error("memory_job_lease_lost"));
        return;
      }
      const result = await handler.execute(claim, {
        now: () => this.#clock(),
        setStage: async (stage) => {
          if (!safeStage.test(stage)) {
            throw new MemoryCoordinatorError("memory_job_stage_invalid", false);
          }
          const accepted = await this.#repository.setJobStage({
            claim,
            now: this.#clock(),
            stage
          });
          if (!accepted) {
            controller.abort(new Error("memory_job_lease_lost"));
            throw new MemoryCoordinatorError("memory_job_lease_lost", false);
          }
          currentStage = stage;
        },
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      if (!validJobResult(result)) {
        throw new MemoryCoordinatorError("memory_job_result_invalid", false);
      }
      const commitDecision = await handler.preflight(claim);
      if (!validGateDecision(commitDecision)) {
        throw new MemoryCoordinatorError("memory_job_gate_invalid", false);
      }
      if (commitDecision.status !== "READY") {
        const accepted = await this.#repository.settleJobGate({
          claim,
          decision: commitDecision,
          now: this.#clock()
        });
        if (!accepted) controller.abort(new Error("memory_job_lease_lost"));
        return;
      }
      const committed = await this.#repository.commitJobSuccess({
        acceptedResultHash: result.acceptedResultHash,
        apply: result.apply,
        claim,
        now: this.#clock(),
        stage: result.stage === undefined ? currentStage : result.stage
      });
      if (!committed) controller.abort(new Error("memory_job_lease_lost"));
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof MemoryCoordinatorError
        ? error
        : new MemoryCoordinatorError("memory_job_failed", true);
      const now = this.#clock();
      if (failure.retryable && claim.attemptCount < this.#policy.maxJobAttempts) {
        await this.#repository.retryJob({
          claim,
          errorCode: failure.code,
          nextAttemptAt: addMilliseconds(
            now,
            memoryRetryDelay(this.#policy.jobRetryDelaysMs, claim.attemptCount)
          ),
          now
        }).catch(() => false);
      } else {
        await this.#repository.terminalJob({
          claim,
          errorCode: failure.code,
          now
        }).catch(() => false);
      }
    } finally {
      releaseOwner?.();
      clearInterval(heartbeat);
      this.#activeControllers.delete(controller);
    }
  }

  async #processDeletion(claim: MemoryDeletionClaim): Promise<void> {
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const heartbeat = this.#startHeartbeat({
      controller,
      heartbeat: (now, leaseExpiresAt) => this.#repository.heartbeatDeletion({
        claim,
        leaseExpiresAt,
        now
      }),
      lostCode: "memory_deletion_lease_lost"
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
      const committed = await this.#repository.commitDeletionSuccess({
        apply: result.apply,
        claim,
        now: this.#clock()
      });
      if (!committed) controller.abort(new Error("memory_deletion_lease_lost"));
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
      await this.#repository.retryDeletion({
        blocked,
        claim,
        errorCode: failure.code,
        nextAttemptAt: addMilliseconds(now, delay),
        now
      }).catch(() => false);
    } finally {
      clearInterval(heartbeat);
      this.#activeControllers.delete(controller);
    }
  }
}

export type { MemoryDeletionOperation, MemoryJobKind };

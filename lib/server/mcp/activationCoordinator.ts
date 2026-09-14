import type {
  McpDraftConfiguration,
  McpJsonObject,
  McpSlotValue,
  McpToolInventoryEntry,
  McpValidationIssue
} from "@/lib/contracts/mcp";
import { mcpValidationIssue } from "@/lib/contracts/mcp";
import {
  McpDraftValidationAbortedError,
  McpDraftValidationUnavailableError,
  type McpDraftValidationOutcome,
  type McpEndpointCorrection,
  type McpDraftValidationStage,
  type McpDraftValidator
} from "./draftValidator";
import { bindContext, logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";

export type McpActivationClaim = Readonly<{
  draft: McpDraftConfiguration;
  id: string;
  leaseId: string;
  serverId: string;
  validationUserId: string | null;
  values: Readonly<Record<string, McpSlotValue>>;
  workloadToken: string;
}>;

export type McpActivationPublication = Readonly<{
  evidence: McpJsonObject;
  endpointCorrection?: McpEndpointCorrection;
  resolvedArtifact: McpJsonObject | null;
  toolInventory: readonly McpToolInventoryEntry[];
}>;

export type McpActivationPublishResult =
  | Readonly<{ kind: "published" }>
  | Readonly<{ issues: readonly McpValidationIssue[]; kind: "invalid" }>
  | Readonly<{ kind: "lease_lost" }>;

export type McpActivationCoordinatorRepository = Readonly<{
  advanceActivation(input: {
    id: string;
    leaseId: string;
    now: Date;
    stage: McpDraftValidationStage | "publishing";
  }): Promise<boolean>;
  claimActivation(input: { now: Date; staleBefore: Date }): Promise<McpActivationClaim | null>;
  failActivation(input: {
    errorCode: string;
    id: string;
    issues: readonly McpValidationIssue[];
    leaseId: string;
    now: Date;
  }): Promise<boolean>;
  heartbeatActivation(input: { id: string; leaseId: string; now: Date }): Promise<boolean>;
  publishActivation(input: {
    claim: McpActivationClaim;
    now: Date;
    publication: McpActivationPublication;
  }): Promise<McpActivationPublishResult>;
}>;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_LEASE_MS = 60_000;
const DEFAULT_MAX_PARALLEL = 2;
const MAX_FAILURE_ISSUES = 20;
const SAFE_TOKEN = /^[a-z0-9_.-]{1,128}$/u;
const OBSERVED_STAGES: Record<McpDraftValidationStage | "publishing", LifecycleStage> = {
  resolving: "prepare", preparing_runtime: "initialize", connecting: "dispatch", discovering_tools: "discover", publishing: "publish"
};

function safeIssues(issues: readonly McpValidationIssue[]): McpValidationIssue[] {
  return issues.slice(0, MAX_FAILURE_ISSUES).map((issue) => mcpValidationIssue(issue, "mcp_activation_validation_failed"));
}

function validPublication(outcome: Extract<McpDraftValidationOutcome, { kind: "ok" }>): boolean {
  return Boolean(outcome.evidence) && !Array.isArray(outcome.evidence) &&
    (outcome.resolvedArtifact === null || (
      Boolean(outcome.resolvedArtifact) && !Array.isArray(outcome.resolvedArtifact)
    )) && outcome.toolInventory.length <= 512;
}

export class McpActivationCoordinator {
  readonly #draftValidator: McpDraftValidator;
  readonly #heartbeatMs: number;
  readonly #intervalMs: number;
  readonly #maxParallel: number;
  readonly #now: () => Date;
  readonly #onPublished?: () => void;
  readonly #repository: McpActivationCoordinatorRepository;
  readonly #staleLeaseMs: number;
  #pending: Promise<void> | null = null;
  #rerun = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: Readonly<{
    draftValidator: McpDraftValidator;
    heartbeatMs?: number;
    intervalMs?: number;
    maxParallel?: number;
    now?: () => Date;
    onPublished?: () => void;
    repository: McpActivationCoordinatorRepository;
    staleLeaseMs?: number;
  }>) {
    this.#draftValidator = input.draftValidator;
    this.#heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#maxParallel = input.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.#now = input.now ?? (() => new Date());
    this.#onPublished = input.onPublished;
    this.#repository = input.repository;
    this.#staleLeaseMs = input.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
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
    this.#pending = runInBackground(() => this.#drain()).finally(() => {
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
      let claim: McpActivationClaim | null;
      try {
        const now = this.#now();
        claim = await this.#repository.claimActivation({
          now,
          staleBefore: new Date(now.getTime() - this.#staleLeaseMs)
        });
      } catch (error) {
        reportSubsystemFailure({ subsystem: "mcp", stage: "claim", code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "retry" });
        return;
      }
      reportSubsystemHealthy("mcp", "claim");
      if (!claim) return;
      await runInBackground(() => runWithContext({ job_id: claim.id }, () => this.#process(claim)));
    }
  }

  async #process(claim: McpActivationClaim): Promise<void> {
    const started = performance.now();
    logEvent("job_attempt", { subsystem: "mcp", stage: "claim", outcome: "started" });
    let leaseLost = false;
    const heartbeat = setInterval(bindContext(() => {
      void this.#repository.heartbeatActivation({
        id: claim.id,
        leaseId: claim.leaseId,
        now: this.#now()
      }).then((accepted) => {
        if (!accepted) {
          if (!leaseLost) logEvent("job_attempt", { subsystem: "mcp", stage: "heartbeat", outcome: "lost_lease", action: "stop" });
          leaseLost = true;
        } else reportSubsystemHealthy("mcp", "heartbeat", claim.id);
      }).catch((error: unknown) => {
        reportSubsystemFailure({ subsystem: "mcp", stage: "heartbeat", scope_id: claim.id, code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "wait" });
        // A transient storage failure is retried by the next heartbeat or stale-lease reclaim.
      });
    }), this.#heartbeatMs);
    heartbeat.unref?.();

    const progress = async (stage: McpDraftValidationStage | "publishing") => {
      if (leaseLost || !await this.#write("progress", () => this.#repository.advanceActivation({
        id: claim.id,
        leaseId: claim.leaseId,
        now: this.#now(),
        stage
      }))) {
        leaseLost = true;
        throw new McpDraftValidationAbortedError();
      }
      logEvent("job_attempt", { subsystem: "mcp", stage: OBSERVED_STAGES[stage], outcome: "started" });
    };

    try {
      const outcome = await this.#draftValidator.validate({
        draft: claim.draft,
        onProgress: progress,
        serverId: claim.serverId,
        ...(claim.validationUserId ? { validationUserId: claim.validationUserId } : {}),
        values: claim.values,
        workloadToken: claim.workloadToken
      });
      if (outcome.kind === "invalid") {
        logEvent("job_attempt", { subsystem: "mcp", stage: "validate", outcome: "failed",
          code: observedFailureCode(outcome.issues[0]), count: outcome.issues.length, action: "fail" });
        await this.#fail(claim, "mcp_draft_test_failed", outcome.issues);
        return;
      }
      if (!validPublication(outcome)) {
        await this.#fail(claim, "mcp_activation_validator_result_invalid", [
          { code: "validator_result_invalid", path: "validator" }
        ]);
        return;
      }
      await progress("publishing");
      let published: McpActivationPublishResult;
      try { published = await this.#repository.publishActivation({
        claim,
        now: this.#now(),
        publication: {
          evidence: outcome.evidence,
          ...(outcome.endpointCorrection ? { endpointCorrection: outcome.endpointCorrection } : {}),
          resolvedArtifact: outcome.resolvedArtifact,
          toolInventory: outcome.toolInventory
        }
      }); } catch (error) {
        logEvent("job_persistence", { subsystem: "mcp", stage: "publish", outcome: "unconfirmed", prisma_code: databaseFailureCode(error) });
        throw error;
      }
      logEvent("job_persistence", { subsystem: "mcp", stage: "publish", outcome: published.kind === "published" ? "confirmed" : "not_applied" });
      if (published.kind === "invalid") {
        const code = observedFailureCode(published.issues[0]);
        logEvent("job_attempt", { subsystem: "mcp", stage: "publish", outcome: code === "mcp_draft_changed" ? "stale" : "failed",
          code, count: published.issues.length, action: "fail" });
        await this.#fail(claim, "mcp_draft_test_failed", published.issues);
      } else if (published.kind === "published") {
        logEvent("job_attempt", { subsystem: "mcp", stage: "complete", outcome: "completed", duration_ms: performance.now() - started });
        try {
          this.#onPublished?.();
        } catch (error) {
          logEvent("job_attempt", { subsystem: "mcp", stage: "dispatch", outcome: "failed", code: observedFailureCode(error), action: "wait" });
          // Publication is durable. Periodic runtime reconciliation will catch a missed kick.
        }
      } else logEvent("job_attempt", { subsystem: "mcp", stage: "publish", outcome: "lost_lease", action: "stop" });
    } catch (error) {
      logEvent("job_attempt", { subsystem: "mcp", stage: "process", outcome: leaseLost ? "lost_lease"
        : error instanceof McpDraftValidationAbortedError ? "cancelled" : "failed",
        code: error instanceof McpDraftValidationUnavailableError ? "mcp_draft_validation_unavailable"
          : error instanceof McpDraftValidationAbortedError ? "mcp_draft_validation_aborted" : observedFailureCode(error),
        prisma_code: databaseFailureCode(error), duration_ms: performance.now() - started, action: "stop" });
      if (error instanceof McpDraftValidationAbortedError || leaseLost) return;
      await this.#fail(
        claim,
        error instanceof McpDraftValidationUnavailableError
          ? "mcp_validation_unavailable"
          : "mcp_activation_failed",
        []
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #write(stage: LifecycleStage, operation: () => Promise<boolean>): Promise<boolean> {
    try {
      const applied = await operation();
      logEvent("job_persistence", { subsystem: "mcp", stage, outcome: applied ? "confirmed" : "not_applied" });
      return applied;
    } catch (error) {
      logEvent("job_persistence", { subsystem: "mcp", stage, outcome: "unconfirmed", prisma_code: databaseFailureCode(error) });
      throw error;
    }
  }

  async #fail(
    claim: McpActivationClaim,
    errorCode: string,
    issues: readonly McpValidationIssue[]
  ): Promise<void> {
    logEvent("job_attempt", { subsystem: "mcp", stage: "fail",
      outcome: issues.some((issue) => observedFailureCode(issue) === "mcp_draft_changed") ? "stale" : "failed",
      code: errorCode, count: issues.length, action: "fail" });
    await this.#write("fail", () => this.#repository.failActivation({
      errorCode: SAFE_TOKEN.test(errorCode) ? errorCode : "mcp_activation_failed",
      id: claim.id,
      issues: safeIssues(issues),
      leaseId: claim.leaseId,
      now: this.#now()
    })).catch(() => undefined);
  }
}

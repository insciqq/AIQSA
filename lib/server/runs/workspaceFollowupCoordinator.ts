import { bindContext, logEvent, runInBackground, runWithContext } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailure } from "../providers/providerObservability";
import type { ActiveRunControllerRegistry } from "./activeRunControllerRegistry";
import { WorkspaceRunConflictError } from "./runRepositoryContract";
import {
  predecessorReleasesSuccessor, WorkspaceFollowupError, type createWorkspaceFollowupRepository, type WorkspaceFollowupClaim
} from "./workspaceFollowupPersistence";

type Repository = ReturnType<typeof createWorkspaceFollowupRepository>;

/** How long a successor waits before trying its activation again, while its chat's Workspace operation settles. */
export const WORKSPACE_FOLLOWUP_BUSY_RETRY_MS = 1_000;

/**
 * Refusals of the successor's own Workspace reservation that only mean the chat's run operation is in passing: its
 * last run is leaving (the operation closes, then settles) or has just left it held (`workspaceJoinRefusal`).
 */
const WORKSPACE_OPERATION_IN_PASSING: ReadonlySet<string> = new Set([
  "workspace_busy_join_closing", "workspace_busy_join_no_active_run", "workspace_busy_join_no_attachment"
]);

/**
 * A transient refusal: the activation is tried again, never failed, and its admission's deadline bounds the retries
 * (`workspace_followup_expired`). Every other refusal, a failed session included, still fails the successor visibly.
 */
function workspaceBusyForNow(error: unknown): boolean {
  return error instanceof WorkspaceRunConflictError && error.code === "workspace_busy" &&
    error.reason !== undefined && WORKSPACE_OPERATION_IN_PASSING.has(error.reason);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type WorkspaceFollowupLoaded = NonNullable<Awaited<ReturnType<Repository["load"]>>>;
export type WorkspaceFollowupContinuationInput = Readonly<{
  claim: WorkspaceFollowupClaim;
  loaded: WorkspaceFollowupLoaded;
  releaseRegistry(): void;
  signal: AbortSignal;
}>;
export type WorkspaceFollowupCoordinatorDependencies = Readonly<{
  continueRun(input: WorkspaceFollowupContinuationInput): Promise<void>;
  fail(claim: WorkspaceFollowupClaim, error: WorkspaceFollowupError): Promise<void>;
  registry: ActiveRunControllerRegistry;
  repository: Repository;
}>;

/** Durable jobs survive navigation/restart. Poll only while work is waiting;
 * independent chats may finish preparation concurrently, without holding an
 * answer stream or adding a global first-in-first-out message queue. */
export function createWorkspaceFollowupCoordinator(deps: WorkspaceFollowupCoordinatorDependencies) {
  const active = new Set<Promise<void>>();
  let pumping: Promise<void> | null = null;
  let wake: ReturnType<typeof setTimeout> | null = null;

  function report(error: unknown, stage: "claim" | "process" | "release" | "heartbeat") {
    logEvent("job_attempt", { subsystem: "workspace", stage, outcome: "failed", action: "retry",
      code: error instanceof WorkspaceFollowupError ? error.code : observedFailure(error).code,
      prisma_code: databaseFailureCode(error) });
  }

  async function processClaim(claim: WorkspaceFollowupClaim): Promise<void> {
    const registration = deps.registry.register(claim.runId);
    if (!registration) { await deps.repository.release(claim); return; }
    const lease = new AbortController();
    const signal = AbortSignal.any([lease.signal, registration.signal]);
    let renewal: Promise<void> | null = null;
    const timer = setInterval(bindContext(() => {
      renewal ??= deps.repository.heartbeat(claim).then((current) => {
        if (!current) lease.abort();
      }, (error: unknown) => { report(error, "heartbeat"); lease.abort(); }).finally(() => { renewal = null; });
    }), 10_000);
    timer.unref?.();
    try {
      const loaded = await deps.repository.load(claim);
      if (!loaded) throw new WorkspaceFollowupError("workspace_followup_unavailable");
      if (loaded.modelRun.workspaceWaitPending && loaded.deadlineAt <= new Date()) {
        throw new WorkspaceFollowupError("workspace_followup_expired");
      }
      if (!predecessorReleasesSuccessor(loaded.predecessor)) throw new WorkspaceFollowupError("workspace_followup_predecessor_failed");
      signal.throwIfAborted();
      await deps.continueRun({ claim, loaded, releaseRegistry: registration.release, signal });
    } catch (error) {
      if (workspaceBusyForNow(error) && !signal.aborted) {
        logEvent("job_attempt", { subsystem: "workspace", stage: "process", outcome: "failed", action: "wait",
          code: "workspace_followup_workspace_busy" });
        // Released after the pause, so the next pump claims it again.
        await pause(WORKSPACE_FOLLOWUP_BUSY_RETRY_MS, signal);
        return;
      }
      report(error, "process");
      // Stop owns its cancellation transaction; a lost lease grants no writes.
      if (!signal.aborted) await deps.fail(claim, error instanceof WorkspaceFollowupError ? error
        : new WorkspaceFollowupError("workspace_followup_interrupted"));
    } finally {
      clearInterval(timer);
      await renewal;
      registration.release();
      await deps.repository.release(claim);
    }
  }

  function schedule(delay: number) {
    if (wake || pumping) return;
    wake = setTimeout(() => { wake = null; kick(); }, delay);
    wake.unref?.();
  }

  function kick(): void {
    if (pumping) return;
    if (wake) { clearTimeout(wake); wake = null; }
    pumping = runInBackground(async () => {
      while (active.size < 4) {
        const claim = await deps.repository.claim(new Date(), deps.registry.ids());
        if (!claim) break;
        const work = runWithContext({ run_id: claim.runId, user_id: claim.userId }, () => processClaim(claim))
          .catch((error: unknown) => report(error, "release"))
          .finally(() => { active.delete(work); schedule(0); });
        active.add(work);
      }
    }).catch((error: unknown) => report(error, "claim")).finally(() => {
      pumping = null;
      if (active.size < 4) void deps.repository.hasPending().then((pending) => {
        if (pending) schedule(250);
      }, (error: unknown) => report(error, "claim"));
    });
  }

  return { kick, async runOne(): Promise<boolean> {
    const claim = await deps.repository.claim(new Date(), deps.registry.ids());
    if (!claim) return false;
    await runInBackground(() => runWithContext({ run_id: claim.runId, user_id: claim.userId }, () => processClaim(claim)));
    return true;
  } };
}

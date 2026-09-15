import { bindContext, logEvent, runInBackground, runWithContext } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailure } from "../providers/providerObservability";
import type { ActiveRunControllerRegistry } from "./activeRunControllerRegistry";
import { WorkspaceFollowupError, type createWorkspaceFollowupRepository, type WorkspaceFollowupClaim } from "./workspaceFollowupPersistence";

type Repository = ReturnType<typeof createWorkspaceFollowupRepository>;
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
      if (loaded.predecessor.status !== "complete") throw new WorkspaceFollowupError("workspace_followup_predecessor_failed");
      signal.throwIfAborted();
      await deps.continueRun({ claim, loaded, releaseRegistry: registration.release, signal });
    } catch (error) {
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
        const work = runWithContext({ run_id: claim.runId }, () => processClaim(claim))
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
    await runInBackground(() => runWithContext({ run_id: claim.runId }, () => processClaim(claim)));
    return true;
  } };
}

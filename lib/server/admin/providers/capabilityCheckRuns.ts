import { randomUUID } from "node:crypto";
import type {
  AdminProviderBootstrapResult,
  AdminProviderCheckRun,
  AdminProviderCheckRunReason
} from "../../../contracts/adminProviders";

/**
 * In-process background capability checks (PRD B3). One run checks a list
 * of models on one connection with one key; at most `concurrency` checks of
 * the same connection run at once even across overlapping runs. State is
 * content-free (ids, counts, timestamps) and lives only in this process: a
 * run id that is not known here is reported as `interrupted`, which is what
 * a restart looks like to a client that was following it.
 */

export type CapabilityCheckOutcome = "cancelled" | "failed" | "skipped" | "stored";

export type CapabilityCheckRequest = Readonly<{
  connectionId: string;
  credentialId: string;
  providerModelId: string;
  signal: AbortSignal;
}>;

export type CapabilityCheckRunStart = Readonly<{
  completeSetup?(signal: AbortSignal): Promise<AdminProviderBootstrapResult>;
  connectionId: string;
  credentialId: string;
  modelIds: readonly string[];
  reason: AdminProviderCheckRunReason;
}>;

export type CapabilityCheckRunner = Readonly<{
  /** Aborts the queue and every in-flight check; false when the run is unknown or finished. */
  cancel(runId: string): boolean;
  /** Owner connection of a known run. */
  connectionOf(runId: string): string | null;
  /** The run as the client sees it, or null when this process never saw the id. */
  get(runId: string): AdminProviderCheckRun | null;
  /** Interrupted marker for an id this process does not know. */
  interrupted(runId: string): AdminProviderCheckRun;
  /** The running run of a connection, else its most recently finished one. */
  latest(connectionId: string): AdminProviderCheckRun | null;
  /** A running run of the connection with this key, when there is one. */
  running(connectionId: string, credentialId: string): AdminProviderCheckRun | null;
  start(input: CapabilityCheckRunStart): { id: string; settled: Promise<void> };
}>;

export const CAPABILITY_CHECK_CANCELLED = "capability_check_cancelled";

type Run = {
  setup?: AdminProviderCheckRun["setup"];
  setupController: AbortController;
  skipped: string[];
  connectionId: string;
  controllers: Map<string, AbortController>;
  credentialId: string;
  done: number;
  finishedAt: Date | null;
  id: string;
  inFlight: string[];
  modelIds: string[];
  reason: AdminProviderCheckRunReason;
  /** Monotonic start order; breaks ties between runs with equal timestamps. */
  sequence: number;
  startedAt: Date;
  state: "cancelled" | "completed" | "running";
  total: number;
};

const RETAINED_FINISHED_RUNS_PER_CONNECTION = 8;

export function createCapabilityCheckRunner(input: Readonly<{
  check(request: CapabilityCheckRequest): Promise<CapabilityCheckOutcome>;
  /** Parallel checks per connection; PRD decision: 3. */
  concurrency?: number;
  idFactory?: () => string;
  now?: () => Date;
}>): CapabilityCheckRunner {
  const concurrency = Math.max(1, input.concurrency ?? 3);
  const idFactory = input.idFactory ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const runs = new Map<string, Run>();
  let sequence = 0;
  /** `${connectionId}:${credentialId}:${modelId}` → models whose latest check failed transiently. */
  const failures = new Set<string>();
  const active = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();

  function failureKey(connectionId: string, credentialId: string, modelId: string): string {
    return `${connectionId}:${credentialId}:${modelId}`;
  }

  function failedModels(connectionId: string, credentialId: string): string[] {
    const prefix = `${connectionId}:${credentialId}:`;
    return [...failures]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  function project(run: Run): AdminProviderCheckRun {
    return {
      ...(run.setup ? { setup: run.setup } : {}),
      ...(run.skipped.length ? { skipped: [...run.skipped] } : {}),
      credentialId: run.credentialId,
      current: run.inFlight[0] ?? null,
      done: run.done,
      failed: failedModels(run.connectionId, run.credentialId),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      id: run.id,
      inFlight: [...run.inFlight],
      reason: run.reason,
      startedAt: run.startedAt.toISOString(),
      state: run.state,
      total: run.total
    };
  }

  async function acquire(connectionId: string): Promise<void> {
    while ((active.get(connectionId) ?? 0) >= concurrency) {
      await new Promise<void>((resolve) => {
        const queue = waiters.get(connectionId) ?? [];
        queue.push(resolve);
        waiters.set(connectionId, queue);
      });
    }
    active.set(connectionId, (active.get(connectionId) ?? 0) + 1);
  }

  function release(connectionId: string): void {
    active.set(connectionId, Math.max(0, (active.get(connectionId) ?? 1) - 1));
    const queue = waiters.get(connectionId);
    const next = queue?.shift();
    if (next) next();
  }

  function prune(connectionId: string): void {
    const finished = [...runs.values()]
      .filter((run) => run.connectionId === connectionId && run.state !== "running")
      .sort((left, right) => right.sequence - left.sequence);
    for (const run of finished.slice(RETAINED_FINISHED_RUNS_PER_CONNECTION)) runs.delete(run.id);
  }

  async function checkOne(run: Run, modelId: string): Promise<void> {
    if (run.state !== "running") return;
    const controller = new AbortController();
    run.controllers.set(modelId, controller);
    run.inFlight.push(modelId);
    let outcome: CapabilityCheckOutcome = "cancelled";
    try {
      outcome = await input.check({
        connectionId: run.connectionId,
        credentialId: run.credentialId,
        providerModelId: modelId,
        signal: controller.signal
      });
    } catch {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
    }
    run.controllers.delete(modelId);
    run.inFlight = run.inFlight.filter((id) => id !== modelId);
    run.done += 1;
    const key = failureKey(run.connectionId, run.credentialId, modelId);
    if (outcome === "failed") failures.add(key);
    else if (outcome === "stored") failures.delete(key);
    else if (outcome === "skipped") run.skipped.push(modelId);
  }

  async function worker(run: Run, queue: string[]): Promise<void> {
    while (run.state === "running") {
      const modelId = queue.shift();
      if (modelId === undefined) return;
      await acquire(run.connectionId);
      try {
        await checkOne(run, modelId);
      } finally {
        release(run.connectionId);
      }
    }
  }

  function finish(run: Run): void {
    if (run.state === "running") run.state = "completed";
    run.finishedAt = now();
    prune(run.connectionId);
  }

  return {
    cancel(runId) {
      const run = runs.get(runId);
      if (!run || run.state !== "running") return false;
      run.state = "cancelled";
      run.setupController.abort(CAPABILITY_CHECK_CANCELLED);
      for (const controller of run.controllers.values()) controller.abort(CAPABILITY_CHECK_CANCELLED);
      return true;
    },

    connectionOf(runId) {
      return runs.get(runId)?.connectionId ?? null;
    },

    get(runId) {
      const run = runs.get(runId);
      return run ? project(run) : null;
    },

    interrupted(runId) {
      return {
        credentialId: "",
        current: null,
        done: 0,
        failed: [],
        finishedAt: null,
        id: runId,
        inFlight: [],
        reason: "requested",
        startedAt: now().toISOString(),
        state: "interrupted",
        total: 0
      };
    },

    latest(connectionId) {
      const candidates = [...runs.values()].filter((run) => run.connectionId === connectionId);
      const running = candidates
        .filter((run) => run.state === "running")
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (running) return project(running);
      const finished = candidates
        .filter((run) => run.finishedAt !== null)
        .sort((left, right) => right.sequence - left.sequence)[0];
      return finished ? project(finished) : null;
    },

    running(connectionId, credentialId) {
      const run = [...runs.values()].find((candidate) =>
        candidate.connectionId === connectionId &&
        candidate.credentialId === credentialId &&
        candidate.state === "running");
      return run ? project(run) : null;
    },

    start(value) {
      const modelIds = [...new Set(value.modelIds)];
      const run: Run = {
        setupController: new AbortController(),
        skipped: [],
        connectionId: value.connectionId,
        controllers: new Map(),
        credentialId: value.credentialId,
        done: 0,
        finishedAt: null,
        id: idFactory(),
        inFlight: [],
        modelIds,
        reason: value.reason,
        sequence: ++sequence,
        startedAt: now(),
        state: "running",
        total: modelIds.length
      };
      runs.set(run.id, run);
      const queue = [...modelIds];
      const workers = Array.from(
        { length: Math.min(concurrency, Math.max(queue.length, 1)) },
        () => worker(run, queue)
      );
      const settled = Promise.all(workers).then(async () => {
        if (value.completeSetup && run.total > 0 && run.state === "running") {
          run.setup = { state: "running" };
          try {
            const result = await value.completeSetup(run.setupController.signal);
            if (!run.setupController.signal.aborted) run.setup = result;
          } catch {
            if (!run.setupController.signal.aborted) {
              run.setup = { defaults: [], search: "failed", state: "partial" };
            }
          }
        }
      }).then(() => finish(run), () => finish(run));
      return { id: run.id, settled };
    }
  };
}

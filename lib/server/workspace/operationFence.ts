import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logEvent } from "../observability";
import { WorkspaceRuntimeError } from "./runtime";

/** Private authority. Never include this value in model/browser projections. */
export type WorkspaceOperation = Readonly<{ generation: number; owner: string }>;
type RecordState = WorkspaceOperation & Readonly<{ phase: "active" | "claiming" | "retired" | "retiring" }>;
type Pending = Readonly<{ controller: AbortController; done: Promise<void> }>;
type SessionState = {
  pending: Set<Pending>;
  record: RecordState | null;
  tail: Promise<void>;
};
export type WorkspaceOperationFenceState = Map<string, Promise<SessionState>>;

/**
 * Keeps a guest's own idle stop away while an operation owns it. Microsandbox fixes a VM's idle timeout when it
 * creates the VM, so one created by an earlier release, with a shorter timeout, would otherwise stop mid-turn when the
 * run works without it for a while, and the processes the run started would be lost.
 */
export type WorkspaceIdleRefresh = Readonly<{
  /** Between touches: well under the shortest idle timeout a guest may have. */
  intervalMs: number;
  /**
   * How long after the operation became active, or last ran a request, the touches go on: a whole turn and its
   * handoff, so an app that never retires its operation (a crash) does not keep a guest up for good.
   */
  lifetimeMs: number;
  /** Refreshes a running guest only (`WorkspaceRuntime.touchSession`). */
  touch(input: Readonly<{ sessionId: string }>): Promise<void>;
}>;
type IdleBeat = { operation: WorkspaceOperation; timer: ReturnType<typeof setInterval> | undefined; until: number };

export function parseWorkspaceOperation(value: unknown): WorkspaceOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceRuntimeError("workspace_operation_stale");
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1 ||
    typeof input.owner !== "string" || input.owner.length < 1 ||
    Buffer.byteLength(input.owner, "utf8") > 160 || /[\u0000-\u001f\u007f]/u.test(input.owner)) {
    throw new WorkspaceRuntimeError("workspace_operation_stale");
  }
  return { generation: input.generation as number, owner: input.owner };
}

/** One receiver per private runtime volume; no database/provider credentials. */
export class WorkspaceOperationFence {
  private readonly sessions: WorkspaceOperationFenceState;
  private readonly beats = new Map<string, IdleBeat>();

  constructor(private readonly options: Readonly<{
    directory?: string;
    drainTimeoutMs?: number;
    idleRefresh?: WorkspaceIdleRefresh;
    state?: WorkspaceOperationFenceState;
    stop: (input: { runtimeSandboxId: string | null; sessionId: string }) => Promise<void>;
  }>) { this.sessions = options.state ?? new Map(); }

  /** Touches the session's guest while `operation` owns it, until `lifetimeMs` after its latest activity. */
  private keepAwake(sessionId: string, operation: WorkspaceOperation): void {
    const refresh = this.options.idleRefresh;
    if (!refresh) return;
    const until = Date.now() + refresh.lifetimeMs;
    const current = this.beats.get(sessionId);
    if (current && current.operation.generation === operation.generation && current.operation.owner === operation.owner) {
      current.until = until;
      return;
    }
    this.letSleep(sessionId);
    const beat: IdleBeat = { operation, timer: undefined, until };
    beat.timer = setInterval(() => {
      if (Date.now() >= beat.until) {
        this.letSleep(sessionId, operation);
        return;
      }
      // A failed refresh never fails the operation: at worst the guest stops early, and its next call starts it again.
      void refresh.touch({ sessionId }).catch((error: unknown) => {
        logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "heartbeat", outcome: "failed",
          code: "workspace_idle_refresh_failed", action: "retry" });
      });
    }, refresh.intervalMs);
    beat.timer.unref?.();
    this.beats.set(sessionId, beat);
  }

  /** Ends the touches of the session's guest; with `operation`, only that operation's. */
  private letSleep(sessionId: string, operation?: WorkspaceOperation): void {
    const beat = this.beats.get(sessionId);
    if (!beat || (operation && (beat.operation.generation !== operation.generation || beat.operation.owner !== operation.owner))) return;
    clearInterval(beat.timer);
    this.beats.delete(sessionId);
  }

  private file(sessionId: string): string {
    return join(this.options.directory!, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  private state(sessionId: string): Promise<SessionState> {
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = (async () => {
        let record: RecordState | null = null;
        if (this.options.directory) {
          const serialized = await readFile(this.file(sessionId), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (serialized !== null) {
            const parsed = JSON.parse(serialized) as Record<string, unknown>;
            const operation = parseWorkspaceOperation(parsed);
            if (parsed.phase !== "active" && parsed.phase !== "claiming" && parsed.phase !== "retired" && parsed.phase !== "retiring") {
              throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
            }
            record = { ...operation, phase: parsed.phase };
          }
        }
        return { pending: new Set<Pending>(), record, tail: Promise.resolve() };
      })();
      this.sessions.set(sessionId, pending);
    }
    return pending;
  }

  private async persist(sessionId: string, state: SessionState, record: RecordState): Promise<void> {
    // A failed durable write may already have reached rename: never continue
    // serving an older in-memory owner after attempting the transition.
    state.record = record;
    if (this.options.directory) {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const file = this.file(sessionId);
      const temporary = file + "." + randomUUID();
      try {
        // Runtime volume state is never an application build input.
        const handle = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, file);
        const directory = await open(this.options.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => undefined); }
    }
  }

  private async locked<T>(sessionId: string, action: (state: SessionState) => Promise<T>): Promise<T> {
    const state = await this.state(sessionId);
    const result = state.tail.then(() => action(state));
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private exact(state: SessionState, operation: WorkspaceOperation): boolean {
    return state.record?.generation === operation.generation && state.record.owner === operation.owner;
  }

  private async drain(state: SessionState, sessionId: string, runtimeSandboxId: string | null): Promise<void> {
    const active = [...state.pending];
    for (const entry of active) entry.controller.abort();
    let finish!: () => void;
    const receipt: Pending = { controller: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve; }) };
    state.pending.add(receipt);
    // Abort ends a request, not its guest process. A stop also lets a blocked
    // guest call return. Do not admit a successor until every accepted handler
    // has left and a final exact VM stop has acknowledged process death.
    const stop = () => this.options.stop({ runtimeSandboxId, sessionId });
    const work = (async () => {
      await stop();
      await Promise.all(active.map((entry) => entry.done));
      if (active.length > 0) await stop();
    })().finally(() => {
      state.pending.delete(receipt);
      finish();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new WorkspaceRuntimeError("workspace_execution_cleanup_failed")), this.options.drainTimeoutMs ?? 10_000);
          timer.unref?.();
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * `predecessor` is the operation a successor continues (an export of the
   * same run). While it is the exact active operation and none of its requests
   * is in flight, the handover needs no VM stop: that successor quiesces the
   * run's executions itself before it reads guest bytes. Otherwise the claim
   * drains as usual.
   */
  async claim(input: Readonly<{
    operation: WorkspaceOperation; predecessor?: WorkspaceOperation; runtimeSandboxId: string | null; sessionId: string;
  }>): Promise<void> {
    const operation = parseWorkspaceOperation(input.operation);
    const predecessor = input.predecessor ? parseWorkspaceOperation(input.predecessor) : null;
    await this.locked(input.sessionId, async (state) => {
      if (state.record && operation.generation <= state.record.generation) {
        if (!this.exact(state, operation) || (state.record.phase !== "active" && state.record.phase !== "claiming")) {
          throw new WorkspaceRuntimeError("workspace_operation_stale");
        }
        if (state.record.phase === "active") {
          this.keepAwake(input.sessionId, operation);
          return;
        }
      }
      if (predecessor && state.record?.phase === "active" && this.exact(state, predecessor) && state.pending.size === 0) {
        // Nothing to abort or stop; later requests of the predecessor are stale.
        await this.persist(input.sessionId, state, { ...operation, phase: "active" });
        this.keepAwake(input.sessionId, operation);
        return;
      }
      // The previous owner's touches end with its operation.
      this.letSleep(input.sessionId);
      // Persist the high-water mark BEFORE abort or any runtime mutation.
      // An interrupted claim stays unavailable until the same owner retries
      // the drain, or a higher durable generation takes it over.
      await this.persist(input.sessionId, state, { ...operation, phase: "claiming" });
      await this.drain(state, input.sessionId, input.runtimeSandboxId);
      await this.persist(input.sessionId, state, { ...operation, phase: "active" });
      this.keepAwake(input.sessionId, operation);
    });
  }

  async retire(input: Readonly<{ operation: WorkspaceOperation; runtimeSandboxId: string | null; sessionId: string }>): Promise<void> {
    const operation = parseWorkspaceOperation(input.operation);
    await this.locked(input.sessionId, async (state) => {
      if (!this.exact(state, operation)) throw new WorkspaceRuntimeError("workspace_operation_stale");
      this.letSleep(input.sessionId, operation);
      if (state.record?.phase === "retired") return;
      await this.persist(input.sessionId, state, { ...operation, phase: "retiring" });
      await this.drain(state, input.sessionId, input.runtimeSandboxId);
      await this.persist(input.sessionId, state, { ...operation, phase: "retired" });
    });
  }

  async run<T>(input: Readonly<{ operation: WorkspaceOperation; sessionId: string }>, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = parseWorkspaceOperation(input.operation);
    let finish!: () => void;
    const entry: Pending = { controller: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve; }) };
    const state = await this.locked(input.sessionId, async (state) => {
      if (!this.exact(state, operation) || state.record?.phase !== "active") {
        throw new WorkspaceRuntimeError("workspace_operation_stale");
      }
      state.pending.add(entry);
      // Also after a runner restart, which forgets the touches: the operation's next request starts them again.
      this.keepAwake(input.sessionId, operation);
      return state;
    });
    try {
      entry.controller.signal.throwIfAborted();
      return await action(entry.controller.signal);
    } finally {
      state.pending.delete(entry);
      finish();
    }
  }
}

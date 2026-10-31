import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceOperation } from "./operationFence";
import type { WorkspaceSkillBundleRef, WorkspaceSkillRunIdentity, WorkspaceSkillRunPreparation } from "./runtime";
import { parseSkillBundleRef, parseSkillInitial, sameSkillRef, skillConflict, skillPreparationFailed, skillRunStale,
  validateSkillIdentity } from "./skillBundles";

/** A long chain of wake-up runs keeps one operation open; a run that outlives this many later ones prepares again. */
const SKILL_RUN_RECEIPTS_MAX = 256;

type SkillRunReceipt = {
  modelRunId: string;
  manifestHash: string;
  phase: "preparing" | "ready";
  initial: WorkspaceSkillBundleRef[];
  /** Aliases this run installed, or found staged with the same bundle. */
  staged: string[];
};

/**
 * One guest's Skills directory. All attached runs of a chat work in one guest under one operation (`attachments.ts`), so
 * the directory belongs to the operation and a run owns only its receipt: the operation's first run clears what an
 * earlier operation left, and later runs add to it. One path serves an alias, so an alias holds one bundle until then.
 */
type SkillSessionRecord = {
  version: 2;
  runtimeSandboxId: string;
  /** The operation the directory serves. Null when none is known: only runs holding a receipt can continue then. */
  operation: string | null;
  phase: "resetting" | "live";
  bundles: WorkspaceSkillBundleRef[];
  runs: SkillRunReceipt[];
};

/** Written by releases that kept one run per session. */
type OneRunRecord = {
  version: 1;
  modelRunId: string;
  runtimeSandboxId: string;
  manifestHash: string;
  phase: "resetting" | "preparing" | "ready";
  initial: WorkspaceSkillBundleRef[];
  installed: WorkspaceSkillBundleRef[];
};

function parseBundles(value: unknown): WorkspaceSkillBundleRef[] {
  if (!Array.isArray(value)) return skillPreparationFailed();
  const refs = value.map(parseSkillBundleRef);
  if (new Set(refs.map(ref => ref.alias)).size !== refs.length) return skillPreparationFailed();
  return refs;
}

function parseOneRunRecord(value: OneRunRecord, sessionId: string): SkillSessionRecord {
  if (!["resetting", "preparing", "ready"].includes(value.phase)) return skillPreparationFailed();
  validateSkillIdentity({ ...value, sessionId });
  const shared = { version: 2, runtimeSandboxId: value.runtimeSandboxId, operation: null } as const;
  if (value.phase === "resetting") return { ...shared, phase: "resetting", bundles: [], runs: [] };
  const bundles = parseSkillInitial(value.installed);
  return { ...shared, phase: "live", bundles, runs: [{ modelRunId: value.modelRunId, manifestHash: value.manifestHash, phase: value.phase,
    initial: parseSkillInitial(value.initial), staged: bundles.map(ref => ref.alias) }] };
}

function parseRecord(value: OneRunRecord | SkillSessionRecord, sessionId: string): SkillSessionRecord {
  if (value.version === 1) return parseOneRunRecord(value, sessionId);
  if (value.version !== 2 || !["resetting", "live"].includes(value.phase) || !Array.isArray(value.runs) ||
    typeof value.runtimeSandboxId !== "string" || (value.operation !== null && typeof value.operation !== "string")) return skillPreparationFailed();
  const runs = value.runs.map(run => {
    validateSkillIdentity({ sessionId, runtimeSandboxId: value.runtimeSandboxId, modelRunId: run.modelRunId, manifestHash: run.manifestHash });
    if (!["preparing", "ready"].includes(run.phase) || !Array.isArray(run.staged) || run.staged.some(alias => typeof alias !== "string")) {
      return skillPreparationFailed();
    }
    return { modelRunId: run.modelRunId, manifestHash: run.manifestHash, phase: run.phase, initial: parseSkillInitial(run.initial), staged: run.staged };
  });
  return { version: 2, runtimeSandboxId: value.runtimeSandboxId, operation: value.operation, phase: value.phase, bundles: parseBundles(value.bundles), runs };
}

function operationKey(operation: WorkspaceOperation | undefined): string | null {
  return operation ? `${operation.generation}:${operation.owner}` : null;
}

/** Private receiver receipts, never guest-provided authority or browser data. */
export class WorkspaceSkillRunState {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly records = new Map<string, SkillSessionRecord>();
  constructor(private readonly directory?: string) {}

  private file(sessionId: string): string {
    return join(this.directory!, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  private async read(sessionId: string): Promise<SkillSessionRecord | null> {
    if (!this.directory) return this.records.get(sessionId) ?? null;
    try {
      return parseRecord(JSON.parse(await readFile(this.file(sessionId), "utf8")) as OneRunRecord | SkillSessionRecord, sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return skillPreparationFailed();
    }
  }

  private async save(sessionId: string, value: SkillSessionRecord): Promise<void> {
    if (!this.directory) { this.records.set(sessionId, value); return; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(sessionId); const temporary = `${target}.${randomUUID()}`;
    try {
      const handle = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async serialized<T>(sessionId: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => { signal?.throwIfAborted(); return action(); });
    this.tails.set(sessionId, next);
    try { return await next; } finally { if (this.tails.get(sessionId) === next) this.tails.delete(sessionId); }
  }

  private locked<T>(input: WorkspaceSkillRunIdentity, action: () => Promise<T>): Promise<T> {
    validateSkillIdentity(input);
    return this.serialized(input.sessionId, input.signal, action);
  }

  private receipt(record: SkillSessionRecord | null, input: WorkspaceSkillRunIdentity): { record: SkillSessionRecord; run: SkillRunReceipt } {
    const run = record?.phase === "live" && record.runtimeSandboxId === input.runtimeSandboxId
      ? record.runs.find(entry => entry.modelRunId === input.modelRunId) : undefined;
    if (!record || !run) return skillRunStale();
    if (run.manifestHash !== input.manifestHash) return skillConflict();
    return { record, run };
  }

  private async cleared(input: WorkspaceSkillRunIdentity, operation: string | null, reset: () => Promise<void>): Promise<SkillSessionRecord> {
    const record: SkillSessionRecord = { version: 2, runtimeSandboxId: input.runtimeSandboxId, operation, phase: "resetting", bundles: [], runs: [] };
    await this.save(input.sessionId, record);
    await reset(); input.signal?.throwIfAborted();
    return { ...record, phase: "live" };
  }

  async prepare(input: WorkspaceSkillRunPreparation, reset: () => Promise<void>, beforeMutation?: () => Promise<void>): Promise<{ state: "preparing" | "ready" }> {
    const initial = parseSkillInitial(input.initial);
    const operation = operationKey(input.operation);
    return this.locked(input, async () => {
      const found = await this.read(input.sessionId);
      const guest = found?.phase === "live" && found.runtimeSandboxId === input.runtimeSandboxId ? found : null;
      const own = guest?.runs.find(run => run.modelRunId === input.modelRunId);
      if (own && own.manifestHash !== input.manifestHash) return skillConflict();
      if (guest && own?.phase === "ready") {
        // A run keeps its receipt under a new lease generation, and later runs of that generation join it.
        if (operation && guest.operation !== operation) await this.save(input.sessionId, { ...guest, operation });
        return { state: "ready" };
      }
      await beforeMutation?.(); input.signal?.throwIfAborted();
      const shared = guest && (own || (operation !== null && guest.operation === operation)) ? guest : null;
      const record = shared ?? await this.cleared(input, operation, reset);
      const wanted = [...own?.initial ?? []];
      for (const ref of initial) {
        const prior = wanted.find(entry => entry.alias === ref.alias);
        if (prior && !sameSkillRef(prior, ref)) return skillConflict();
        if (!prior) wanted.push(ref);
      }
      const held = new Map(record.bundles.map(ref => [ref.alias, ref]));
      if (parseSkillInitial(wanted).some(ref => { const prior = held.get(ref.alias); return prior && !sameSkillRef(prior, ref); })) return skillConflict();
      const staged = wanted.filter(ref => held.has(ref.alias)).map(ref => ref.alias);
      // Only `complete` publishes links, so a bundle that wants one still passes through it.
      const phase = staged.length === wanted.length && !wanted.some(ref => ref.discover) ? "ready" : "preparing";
      const receipt: SkillRunReceipt = { modelRunId: input.modelRunId, manifestHash: input.manifestHash, phase, initial: wanted, staged };
      await this.save(input.sessionId, { ...record, operation: operation ?? record.operation,
        runs: [...record.runs.filter(run => run !== own), receipt].slice(-SKILL_RUN_RECEIPTS_MAX) });
      return { state: phase };
    });
  }

  /**
   * `install` receives whether the same bundle is already staged and owes no guest write: for a run still preparing, or
   * one meeting another run's bundle for the first time. A run's repeated explicit load writes its alias again.
   */
  async install<T>(input: WorkspaceSkillRunIdentity, bundle: WorkspaceSkillBundleRef, install: (present: boolean) => Promise<T>): Promise<T> {
    const ref = parseSkillBundleRef(bundle);
    return this.locked(input, async () => {
      const { record, run } = this.receipt(await this.read(input.sessionId), input);
      const held = record.bundles.find(entry => entry.alias === ref.alias);
      const wanted = run.initial.find(entry => entry.alias === ref.alias);
      if ((held && !sameSkillRef(held, ref)) || (wanted && !sameSkillRef(wanted, ref))) return skillConflict();
      if (ref.discover && !wanted) return skillPreparationFailed();
      const result = await install(held !== undefined && (run.phase === "preparing" || !run.staged.includes(ref.alias)));
      input.signal?.throwIfAborted();
      const staged = run.staged.includes(ref.alias) ? run.staged : [...run.staged, ref.alias];
      await this.save(input.sessionId, { ...record, bundles: held ? record.bundles : [...record.bundles, ref],
        runs: record.runs.map(entry => entry === run ? { ...run, staged } : entry) });
      return result;
    });
  }

  async complete(input: WorkspaceSkillRunIdentity, publishLinks: (available: readonly WorkspaceSkillBundleRef[]) => Promise<void>): Promise<void> {
    await this.locked(input, async () => {
      const { record, run } = this.receipt(await this.read(input.sessionId), input);
      if (run.phase === "ready") return;
      if (run.initial.some(ref => !run.staged.includes(ref.alias))) return skillPreparationFailed();
      // The guest has one discovery directory, so it lists every run's links and no run's completion takes another's away.
      await publishLinks(record.bundles.filter(ref => ref.discover)); input.signal?.throwIfAborted();
      await this.save(input.sessionId, { ...record, runs: record.runs.map(entry => entry === run ? { ...run, phase: "ready" } : entry) });
    });
  }

  /** Called only after exact guest removal; a stale cleanup cannot erase its successor. */
  async removeSession(input: { sessionId: string; runtimeSandboxId: string | null }): Promise<void> {
    await this.serialized(input.sessionId, undefined, async () => {
      const record = await this.read(input.sessionId);
      if (!record || input.runtimeSandboxId && record.runtimeSandboxId !== input.runtimeSandboxId) return;
      if (this.directory) {
        await unlink(this.file(input.sessionId));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } else this.records.delete(input.sessionId);
    });
  }
}

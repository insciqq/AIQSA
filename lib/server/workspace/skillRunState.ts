import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSkillBundleRef, WorkspaceSkillRunIdentity, WorkspaceSkillRunPreparation } from "./runtime";
import { parseSkillBundleRef, parseSkillInitial, sameSkillRef, skillPreparationFailed, validateSkillIdentity } from "./skillBundles";

type SkillRunRecord = {
  version: 1;
  modelRunId: string;
  runtimeSandboxId: string;
  manifestHash: string;
  phase: "resetting" | "preparing" | "ready";
  initial: WorkspaceSkillBundleRef[];
  installed: WorkspaceSkillBundleRef[];
};

/** Private receiver receipts, never guest-provided authority or browser data. */
export class WorkspaceSkillRunState {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly records = new Map<string, SkillRunRecord>();
  constructor(private readonly directory?: string) {}

  private file(sessionId: string): string {
    return join(this.directory!, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  private async read(sessionId: string): Promise<SkillRunRecord | null> {
    if (!this.directory) return this.records.get(sessionId) ?? null;
    try {
      const value = JSON.parse(await readFile(this.file(sessionId), "utf8")) as SkillRunRecord;
      if (value.version !== 1 || !["resetting", "preparing", "ready"].includes(value.phase)) return skillPreparationFailed();
      validateSkillIdentity({ ...value, sessionId });
      return { ...value, initial: parseSkillInitial(value.initial), installed: parseSkillInitial(value.installed) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return skillPreparationFailed();
    }
  }

  private async save(sessionId: string, value: SkillRunRecord): Promise<void> {
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

  private async locked<T>(input: WorkspaceSkillRunIdentity, action: () => Promise<T>): Promise<T> {
    validateSkillIdentity(input);
    const prior = this.tails.get(input.sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => { input.signal?.throwIfAborted(); return action(); });
    this.tails.set(input.sessionId, next);
    try { return await next; } finally { if (this.tails.get(input.sessionId) === next) this.tails.delete(input.sessionId); }
  }

  private exact(record: SkillRunRecord | null, input: WorkspaceSkillRunIdentity): record is SkillRunRecord {
    return !!record && record.modelRunId === input.modelRunId && record.runtimeSandboxId === input.runtimeSandboxId && record.manifestHash === input.manifestHash;
  }

  async prepare(input: WorkspaceSkillRunPreparation, reset: () => Promise<void>, beforeMutation?: () => Promise<void>): Promise<{ state: "preparing" | "ready" }> {
    const initial = parseSkillInitial(input.initial);
    return this.locked(input, async () => {
      let record = await this.read(input.sessionId);
      if (record?.modelRunId === input.modelRunId && record.runtimeSandboxId === input.runtimeSandboxId && record.manifestHash !== input.manifestHash) return skillPreparationFailed();
      if (this.exact(record, input) && record.phase === "ready") return { state: "ready" };
      await beforeMutation?.(); input.signal?.throwIfAborted();
      if (this.exact(record, input) && record.phase !== "resetting") {
        const merged = [...record.initial];
        for (const ref of initial) {
          const prior = merged.find(entry => entry.alias === ref.alias);
          if (prior && !sameSkillRef(prior, ref)) return skillPreparationFailed();
          if (!prior) merged.push(ref);
        }
        record = { ...record, initial: parseSkillInitial(merged) };
      } else {
        record = { version: 1, modelRunId: input.modelRunId, runtimeSandboxId: input.runtimeSandboxId,
          manifestHash: input.manifestHash, phase: "resetting", initial, installed: [] };
        await this.save(input.sessionId, record);
        await reset(); input.signal?.throwIfAborted();
        record.phase = "preparing";
      }
      await this.save(input.sessionId, record);
      return { state: "preparing" };
    });
  }

  async install<T>(input: WorkspaceSkillRunIdentity, bundle: WorkspaceSkillBundleRef, install: () => Promise<T>): Promise<T> {
    const ref = parseSkillBundleRef(bundle);
    return this.locked(input, async () => {
      const record = await this.read(input.sessionId);
      if (!this.exact(record, input) || record.phase === "resetting") return skillPreparationFailed();
      const prior = [...record.initial, ...record.installed].find(entry => entry.alias === ref.alias);
      if (prior && !sameSkillRef(prior, ref)) return skillPreparationFailed();
      if (ref.discover && !record.initial.some(entry => sameSkillRef(entry, ref))) return skillPreparationFailed();
      const installed = parseSkillInitial([...record.installed.filter(entry => entry.alias !== ref.alias), ref]);
      const result = await install(); input.signal?.throwIfAborted();
      await this.save(input.sessionId, { ...record, installed });
      return result;
    });
  }

  async complete(input: WorkspaceSkillRunIdentity, publishLinks: (available: readonly WorkspaceSkillBundleRef[]) => Promise<void>): Promise<void> {
    await this.locked(input, async () => {
      const record = await this.read(input.sessionId);
      if (!this.exact(record, input) || record.phase === "resetting") return skillPreparationFailed();
      if (record.phase === "ready") return;
      if (record.initial.some(ref => !record.installed.some(installed => sameSkillRef(installed, ref)))) return skillPreparationFailed();
      await publishLinks(record.initial.filter(ref => ref.discover)); input.signal?.throwIfAborted();
      await this.save(input.sessionId, { ...record, phase: "ready" });
    });
  }

  async start<T>(input: WorkspaceSkillRunIdentity, action: () => Promise<T>): Promise<T> {
    return this.locked(input, async () => {
      const record = await this.read(input.sessionId);
      if (!this.exact(record, input) || record.phase !== "ready") return skillPreparationFailed();
      return action();
    });
  }

  /** Called only after exact guest removal; a stale cleanup cannot erase its successor. */
  async removeSession(input: { sessionId: string; runtimeSandboxId: string | null }): Promise<void> {
    const record = await this.read(input.sessionId);
    if (!record || input.runtimeSandboxId && record.runtimeSandboxId !== input.runtimeSandboxId) return;
    const identity = { ...record, sessionId: input.sessionId };
    await this.locked(identity, async () => {
      if (!this.exact(await this.read(input.sessionId), identity)) return;
      if (this.directory) {
        await unlink(this.file(input.sessionId));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } else this.records.delete(input.sessionId);
    });
  }
}

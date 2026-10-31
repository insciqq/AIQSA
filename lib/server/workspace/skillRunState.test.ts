import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSkillRunState } from "./skillRunState";

const identity = { sessionId: "session", runtimeSandboxId: "guest", modelRunId: "run", manifestHash: "a".repeat(64) };
const pinned = { alias: "pinned", revisionId: "rev-a", bundleDigest: "b".repeat(64), discover: false };
const available = { alias: "available", revisionId: "rev-b", bundleDigest: "c".repeat(64), discover: true };

describe("durable Workspace Skill preparation", () => {
  it("preserves a ready same-run guest across receiver restart and lease generations, and resets a recreated guest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-state-"));
    try {
      const first = new WorkspaceSkillRunState(directory); const reset = vi.fn(async () => {});
      await first.prepare({ ...identity, initial: [pinned] }, reset);
      await expect(first.complete(identity, async () => {})).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
      await first.install(identity, pinned, async () => {});
      await first.complete(identity, async refs => { expect(refs).toEqual([]); });
      const recovered = new WorkspaceSkillRunState(directory);
      await expect(recovered.prepare({ ...identity, operation: { generation: 9, owner: "recovery" },
        initial: [pinned, available] }, reset)).resolves.toEqual({ state: "ready" });
      expect(reset).toHaveBeenCalledTimes(1);
      await expect(recovered.prepare({ ...identity, runtimeSandboxId: "new-guest", initial: [pinned, available] }, reset))
        .resolves.toEqual({ state: "preparing" });
      expect(reset).toHaveBeenCalledTimes(2);
      await recovered.removeSession(identity);
      expect(await readdir(directory)).toHaveLength(1);
      await recovered.removeSession({ ...identity, runtimeSandboxId: "new-guest" });
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("retries interrupted reset and initial installs, and exposes only accepted available links after all installs", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = vi.fn().mockRejectedValueOnce(new Error("interrupted")).mockResolvedValue(undefined);
    await expect(state.prepare({ ...identity, initial: [pinned] }, reset)).rejects.toThrow("interrupted");
    await expect(state.install(identity, pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skill_run_stale" });
    await state.prepare({ ...identity, initial: [pinned] }, reset);
    await state.install(identity, pinned, async () => {});
    await state.prepare({ ...identity, initial: [pinned, available] }, reset);
    expect(reset).toHaveBeenCalledTimes(2);
    const links = vi.fn(async () => {});
    await expect(state.complete(identity, links)).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
    expect(links).not.toHaveBeenCalled();
    await state.install(identity, available, async () => {});
    await state.complete(identity, links);
    expect(links).toHaveBeenCalledWith([available]);
    await expect(state.prepare({ ...identity, manifestHash: "d".repeat(64), initial: [] }, reset)).rejects.toMatchObject({ code: "workspace_skill_conflict" });
  });

  it("installs an explicit new load again without treating it as a replay", async () => {
    const state = new WorkspaceSkillRunState();
    await state.prepare({ ...identity, initial: [] }, async () => {});
    await state.complete(identity, async () => {});
    const install = vi.fn(async () => {});
    await state.install(identity, pinned, install);
    await state.install(identity, pinned, install);
    expect(install).toHaveBeenCalledTimes(2);
    await expect(state.install(identity, { ...pinned, bundleDigest: "e".repeat(64) }, install)).rejects.toMatchObject({ code: "workspace_skill_conflict" });
  });
});

describe("Skills of the runs that share one guest", () => {
  const operation = { generation: 3, owner: "run:first" };
  const run = (modelRunId: string, overrides: Partial<typeof identity> = {}) => ({ ...identity, modelRunId, operation, ...overrides });
  const bundle = (alias: string) => ({ alias, revisionId: `rev-${alias}`, bundleDigest: createHash("sha256").update(alias).digest("hex"), discover: false });
  const revised = { ...pinned, revisionId: "rev-next", bundleDigest: "e".repeat(64) };
  const custom = run("custom", { manifestHash: "d".repeat(64) });

  async function staged(state: WorkspaceSkillRunState, modelRunId: string, reset = vi.fn(async () => {})) {
    await state.prepare({ ...run(modelRunId), initial: [pinned] }, reset);
    await state.install(run(modelRunId), pinned, async () => {});
    await state.complete(run(modelRunId), async () => {});
    return reset;
  }

  it("keeps runs that prepare, install and complete in turns valid", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = vi.fn(async () => {});
    const guest = vi.fn(async () => {});
    await state.prepare({ ...run("first"), initial: [pinned] }, reset);
    await state.prepare({ ...run("second"), initial: [pinned] }, reset);
    await state.install(run("first"), pinned, guest);
    await state.install(run("second"), pinned, async () => {});
    await state.complete(run("second"), async () => {});
    await state.complete(run("first"), async () => {});
    expect(reset).toHaveBeenCalledOnce();
    expect(guest).toHaveBeenCalledOnce();
    await expect(state.prepare({ ...run("first"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    await expect(state.prepare({ ...run("second"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
  });

  it("brings five runs with interleaved calls to ready, each alias staged once", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = vi.fn(async () => {});
    const written: string[] = [];
    const refs = [bundle("one"), bundle("two"), bundle("three")];
    const flow = async (modelRunId: string, order: typeof refs) => {
      const prepared = await state.prepare({ ...run(modelRunId), initial: refs }, reset);
      if (prepared.state === "ready") return prepared;
      for (const ref of order) {
        await Promise.resolve();
        await state.install(run(modelRunId), ref, async present => { if (!present) written.push(ref.alias); });
      }
      await state.complete(run(modelRunId), async () => {});
      return state.prepare({ ...run(modelRunId), initial: refs }, reset);
    };
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((id, index) =>
      flow(id, [...refs.slice(index % 3), ...refs.slice(0, index % 3)])));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ state: "ready" })));
    expect(reset).toHaveBeenCalledOnce();
    expect([...written].sort()).toEqual(["one", "three", "two"]);
  });

  it("never resets an earlier run's Skills for a later run, which finds the same bundle ready", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = await staged(state, "first");
    await expect(state.prepare({ ...run("later"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    expect(reset).toHaveBeenCalledOnce();
    // Neither run lost its authority to load more, and a load of what the other staged writes nothing.
    await state.install(run("first"), bundle("loaded"), async () => {});
    await expect(state.install(run("later"), bundle("loaded"), async present => present)).resolves.toBe(true);
  });

  it("lets a run with another manifest add its own Skills beside the first run's", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = await staged(state, "first");
    await expect(state.prepare({ ...custom, initial: [bundle("custom-only")] }, reset)).resolves.toEqual({ state: "preparing" });
    await state.install(custom, bundle("custom-only"), async () => {});
    await state.complete(custom, async () => {});
    expect(reset).toHaveBeenCalledOnce();
    await expect(state.prepare({ ...run("first"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    await expect(state.prepare({ ...custom, initial: [bundle("custom-only")] }, reset)).resolves.toEqual({ state: "ready" });
  });

  it("refuses one alias at two bundles with a stable code, and leaves the first run untouched", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = await staged(state, "first");
    await expect(state.prepare({ ...custom, initial: [revised] }, reset)).rejects.toMatchObject({ code: "workspace_skill_conflict" });
    // A later load finds the same refusal, and writes nothing.
    await state.prepare({ ...custom, initial: [] }, reset);
    const guest = vi.fn(async () => {});
    await expect(state.install(custom, revised, guest)).rejects.toMatchObject({ code: "workspace_skill_conflict" });
    expect(guest).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();
    await expect(state.prepare({ ...run("first"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    // A restored revision is the same bundle under a new id, not a conflict.
    const restored = { ...pinned, revisionId: "rev-restored" };
    await expect(state.prepare({ ...run("restored"), initial: [restored] }, reset)).resolves.toEqual({ state: "ready" });
  });

  it("settles a race for one alias on the bundle that reached the guest first", async () => {
    const state = new WorkspaceSkillRunState();
    await state.prepare({ ...run("first"), initial: [pinned] }, async () => {});
    await state.prepare({ ...custom, initial: [revised] }, async () => {});
    await state.install(run("first"), pinned, async () => {});
    await expect(state.install(custom, revised, async () => {})).rejects.toMatchObject({ code: "workspace_skill_conflict" });
  });

  it("clears the directory only for a new operation, a new sandbox or a fresh session", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = await staged(state, "first");
    expect(reset).toHaveBeenCalledTimes(1);
    const next = { ...run("next"), operation: { generation: 4, owner: "run:next" } };
    await expect(state.prepare({ ...next, initial: [pinned] }, reset)).resolves.toEqual({ state: "preparing" });
    expect(reset).toHaveBeenCalledTimes(2);
    // The ended operation's run has no receipt left to act on.
    await expect(state.install(run("first"), pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skill_run_stale" });
    await state.install(next, pinned, async () => {});
    await state.complete(next, async () => {});
    const recreated = { ...next, modelRunId: "after-loss", runtimeSandboxId: "new-guest" };
    await expect(state.prepare({ ...recreated, initial: [pinned] }, reset)).resolves.toEqual({ state: "preparing" });
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it("keeps a run's receipt across a new generation, and later runs join that generation", async () => {
    const state = new WorkspaceSkillRunState();
    const reset = await staged(state, "first");
    const moved = { generation: 4, owner: operation.owner };
    await expect(state.prepare({ ...run("first"), operation: moved, initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    await expect(state.prepare({ ...run("second"), operation: moved, initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("keeps every run's receipt across a receiver restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-state-"));
    try {
      const before = new WorkspaceSkillRunState(directory);
      const reset = await staged(before, "ready");
      await before.prepare({ ...run("midway"), initial: [pinned, bundle("second")] }, reset);
      const after = new WorkspaceSkillRunState(directory);
      await expect(after.prepare({ ...run("ready"), initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
      // The interrupted run goes on with what it had not finished, and the staged bundle stays staged.
      await expect(after.install(run("midway"), pinned, async present => present)).resolves.toBe(true);
      await expect(after.install(run("midway"), bundle("second"), async present => present)).resolves.toBe(false);
      await after.complete(run("midway"), async () => {});
      expect(reset).toHaveBeenCalledOnce();
      await after.removeSession(run("ready"));
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reads a record of the one-run shape, and resumes its interrupted reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-state-"));
    try {
      const file = join(directory, createHash("sha256").update(identity.sessionId).digest("hex") + ".json");
      await writeFile(file, JSON.stringify({ version: 1, modelRunId: identity.modelRunId, runtimeSandboxId: identity.runtimeSandboxId,
        manifestHash: identity.manifestHash, phase: "ready", initial: [pinned], installed: [pinned] }));
      const state = new WorkspaceSkillRunState(directory); const reset = vi.fn(async () => {});
      await expect(state.prepare({ ...identity, operation, initial: [pinned] }, reset)).resolves.toEqual({ state: "ready" });
      expect(reset).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 });
      await writeFile(file, JSON.stringify({ version: 1, modelRunId: identity.modelRunId, runtimeSandboxId: identity.runtimeSandboxId,
        manifestHash: identity.manifestHash, phase: "resetting", initial: [], installed: [] }));
      await expect(state.install(identity, pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skill_run_stale" });
      await state.prepare({ ...identity, operation, initial: [] }, reset);
      expect(reset).toHaveBeenCalledOnce();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("names a run with no receipt as stale, and keeps a corrupt record a preparation failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-state-"));
    try {
      const state = new WorkspaceSkillRunState(directory);
      await expect(state.install(run("unknown"), pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skill_run_stale" });
      await expect(state.complete(run("unknown"), async () => {})).rejects.toMatchObject({ code: "workspace_skill_run_stale" });
      await writeFile(join(directory, createHash("sha256").update(identity.sessionId).digest("hex") + ".json"), "{");
      await expect(state.install(run("unknown"), pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps a bounded number of receipts through a long chain of runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-state-"));
    try {
      const state = new WorkspaceSkillRunState(directory);
      for (let index = 0; index < 300; index++) await state.prepare({ ...run(`run-${index}`), initial: [] }, async () => {});
      const [name] = await readdir(directory);
      const record = JSON.parse(await readFile(join(directory, name!), "utf8")) as { runs: unknown[] };
      expect(record.runs.length).toBeLessThanOrEqual(256);
      const reset = vi.fn(async () => {});
      await expect(state.prepare({ ...run("run-299"), initial: [] }, reset)).resolves.toEqual({ state: "ready" });
      expect(reset).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});

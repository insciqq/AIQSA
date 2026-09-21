import { mkdtemp, readdir, rm } from "node:fs/promises";
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
      await expect(recovered.start(identity, async () => "started")).resolves.toBe("started");
      await recovered.prepare({ ...identity, runtimeSandboxId: "new-guest", initial: [pinned, available] }, reset);
      expect(reset).toHaveBeenCalledTimes(2);
      await expect(recovered.start({ ...identity, runtimeSandboxId: "new-guest" }, async () => {}))
        .rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
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
    await expect(state.install(identity, pinned, async () => {})).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
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
    await expect(state.prepare({ ...identity, manifestHash: "d".repeat(64), initial: [] }, reset)).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
  });

  it("serializes Agent start and installs without treating every explicit new load as a replay", async () => {
    const state = new WorkspaceSkillRunState();
    await state.prepare({ ...identity, initial: [] }, async () => {});
    await state.complete(identity, async () => {});
    let finish!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const start = state.start(identity, async () => { entered(); await barrier; });
    await started;
    const install = vi.fn(async () => {});
    const pending = state.install(identity, pinned, install);
    await Promise.resolve(); expect(install).not.toHaveBeenCalled();
    finish(); await start; await pending;
    await state.install(identity, pinned, install);
    expect(install).toHaveBeenCalledTimes(2);
    await expect(state.install(identity, { ...pinned, revisionId: "retargeted" }, install)).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
  });
});

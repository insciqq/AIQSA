import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { workspaceSandboxName, type WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { tarGzipStream } from "../chats/tarArchive";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import type { WorkspaceSkillBundleRef, WorkspaceSkillRunIdentity } from "./runtime";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const pinned = { alias: "example", revisionId: "revision-a", bundleDigest: "b".repeat(64), discover: false };
const available = { alias: "available", revisionId: "revision-b", bundleDigest: "c".repeat(64), discover: false };

async function install(runtime: DeterministicWorkspaceRuntime, identity: WorkspaceSkillRunIdentity, bundle: WorkspaceSkillBundleRef, text: string) {
  const bytes = Buffer.from(await new Response(tarGzipStream((async function* () {
    yield { path: "SKILL.md", content: text, mtime: new Date(0) };
    yield { path: "scripts/run.sh", content: "synthetic executable", mode: 0o755 as const, mtime: new Date(0) };
  })())).arrayBuffer());
  return runtime.installSkillBundle({ ...identity, bundle, byteSize: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    archive: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
}

describe("Skill bundles in a persistent deterministic guest", () => {
  it("resets old aliases only at new runs, reinstalls explicit loads, preserves same-run writes, and rehydrates lost guests", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    const sessionId = "ws_" + "e".repeat(40);
    const ensure = { sessionId, runtimeSandboxId: null, sandboxName: workspaceSandboxName(sessionId),
      imageRef: config.imageRef, cpus: config.cpus, memoryMiB: config.memoryMiB, diskMiB: config.diskMiB, internetEnabled: false };
    const created = await runtime.ensureSession(ensure);
    let identity = { sessionId, runtimeSandboxId: created.runtimeSandboxId, modelRunId: "run1", manifestHash: "a".repeat(64) };
    const call = async (originalName: WorkspaceMcpToolName, args: Record<string, unknown>) => {
      const result = await runtime.callBoundTool({ ...identity, arguments: args, originalName, modelRunToolCallId: "synthetic-call" });
      return JSON.parse(result.content[0]?.text ?? "null").data;
    };
    await runtime.prepareSkillRun({ ...identity, initial: [pinned] });
    expect(await call("sandbox_fs_exists", { path: "/workspace/.aiqsa/skills/available/SKILL.md" })).toMatchObject({ exists: false });
    await install(runtime, identity, pinned, "first revision");
    await runtime.completeSkillRunPreparation(identity);
    expect(await call("sandbox_fs_stat", { path: "/workspace/.aiqsa/skills/example/scripts/run.sh" })).toMatchObject({ mode: 0o755 });
    await call("sandbox_fs_write", { path: "/workspace/.aiqsa/skills/example/old.txt", content: "old bytes" });
    await call("sandbox_fs_write", { path: "/workspace/.aiqsa/skills/example/SKILL.md", content: "same-run edited bytes" });
    await runtime.stopSession(identity);
    await runtime.ensureSession({ ...ensure, runtimeSandboxId: identity.runtimeSandboxId });
    await expect(runtime.prepareSkillRun({ ...identity, initial: [pinned, available] })).resolves.toEqual({ state: "ready" });
    expect(await call("sandbox_fs_read", { path: "/workspace/.aiqsa/skills/example/SKILL.md" })).toMatchObject({ content: "same-run edited bytes" });
    await install(runtime, identity, available, "loaded bytes");
    await install(runtime, identity, pinned, "reinstalled bytes");
    expect(await call("sandbox_fs_exists", { path: "/workspace/.aiqsa/skills/example/old.txt" })).toMatchObject({ exists: false });
    const archive = await runtime.createProjectArchive(identity);
    expect(gunzipSync(Buffer.from(await new Response(archive.body).arrayBuffer())).includes(Buffer.from("reinstalled bytes"))).toBe(false);
    expect(await runtime.collectOutputs({ ...identity, outputDirectory: "/workspace/output/run1" })).toEqual([]);

    identity = { ...identity, modelRunId: "run2", manifestHash: "d".repeat(64) };
    const reused = { ...pinned, revisionId: "another-skill-revision", bundleDigest: "e".repeat(64) };
    await runtime.prepareSkillRun({ ...identity, initial: [reused] });
    expect(await call("sandbox_fs_exists", { path: "/workspace/.aiqsa/skills/available/SKILL.md" })).toMatchObject({ exists: false });
    expect(await call("sandbox_fs_exists", { path: "/workspace/.aiqsa/skills/example/SKILL.md" })).toMatchObject({ exists: false });
    await install(runtime, identity, reused, "new alias owner");
    await runtime.completeSkillRunPreparation(identity);
    await runtime.removeSession(identity);
    const recreated = await runtime.ensureSession(ensure);
    expect(recreated.runtimeSandboxId).not.toBe(identity.runtimeSandboxId);
    identity = { ...identity, runtimeSandboxId: recreated.runtimeSandboxId };
    await expect(runtime.prepareSkillRun({ ...identity, initial: [reused, available] })).resolves.toEqual({ state: "preparing" });
    await expect(runtime.completeSkillRunPreparation(identity)).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
    await install(runtime, identity, reused, "frozen restored owner");
    await install(runtime, identity, available, "frozen restored loaded");
    await runtime.completeSkillRunPreparation(identity);
    expect(await call("sandbox_fs_read", { path: "/workspace/.aiqsa/skills/available/SKILL.md" })).toMatchObject({ content: "frozen restored loaded" });
    await runtime.removeSession(identity);
  });

  it("keeps every run's Skills beside the others in one guest, and clears them for the next operation", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    const sessionId = "ws_" + "f".repeat(40);
    const created = await runtime.ensureSession({ sessionId, runtimeSandboxId: null, sandboxName: workspaceSandboxName(sessionId),
      imageRef: config.imageRef, cpus: config.cpus, memoryMiB: config.memoryMiB, diskMiB: config.diskMiB, internetEnabled: false });
    const operation = { generation: 2, owner: "run:main" };
    const shared = { sessionId, runtimeSandboxId: created.runtimeSandboxId, operation };
    const main = { ...shared, modelRunId: "main", manifestHash: "a".repeat(64) };
    const subagent = { ...shared, modelRunId: "subagent", manifestHash: "a".repeat(64) };
    const custom = { ...shared, modelRunId: "custom", manifestHash: "d".repeat(64) };
    const read = async (path: string) => {
      const result = await runtime.callBoundTool({ ...main, arguments: { path }, originalName: "sandbox_fs_exists", modelRunToolCallId: "synthetic-call" });
      return (JSON.parse(result.content[0]?.text ?? "null") as { data: { exists: boolean } }).data.exists;
    };
    await runtime.prepareSkillRun({ ...main, initial: [pinned] });
    await runtime.prepareSkillRun({ ...subagent, initial: [pinned] });
    await install(runtime, main, pinned, "shared bytes");
    await install(runtime, subagent, pinned, "bytes that must not replace the staged ones");
    await runtime.completeSkillRunPreparation(subagent);
    await runtime.completeSkillRunPreparation(main);
    await expect(runtime.prepareSkillRun({ ...custom, initial: [available] })).resolves.toEqual({ state: "preparing" });
    await install(runtime, custom, available, "custom bytes");
    await runtime.completeSkillRunPreparation(custom);
    expect(await read("/workspace/.aiqsa/skills/example/SKILL.md")).toBe(true);
    expect(await read("/workspace/.aiqsa/skills/available/SKILL.md")).toBe(true);
    const content = await runtime.callBoundTool({ ...main, arguments: { path: "/workspace/.aiqsa/skills/example/SKILL.md" }, originalName: "sandbox_fs_read", modelRunToolCallId: "synthetic-read" });
    expect(JSON.parse(content.content[0]?.text ?? "null")).toMatchObject({ data: { content: "shared bytes" } });
    const revised = { ...pinned, revisionId: "revision-next", bundleDigest: "e".repeat(64) };
    await expect(runtime.prepareSkillRun({ ...custom, modelRunId: "late", initial: [revised] })).rejects.toMatchObject({ code: "workspace_skill_conflict" });
    expect(await read("/workspace/.aiqsa/skills/example/SKILL.md")).toBe(true);

    const next = { ...main, modelRunId: "next", operation: { generation: 3, owner: "run:next" } };
    await runtime.prepareSkillRun({ ...next, initial: [revised] });
    expect(await read("/workspace/.aiqsa/skills/example/SKILL.md")).toBe(false);
    expect(await read("/workspace/.aiqsa/skills/available/SKILL.md")).toBe(false);
    await runtime.removeSession({ ...shared });
  });
});

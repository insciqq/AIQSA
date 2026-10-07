import { describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { WORKSPACE_UV_CACHE_DIRECTORY } from "./guestCache";

// A few bytes stand in for the 1 GiB threshold so the model stays small.
vi.mock("./guestCache", async (original) => ({ ...await original<typeof import("./guestCache")>(), WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES: 16 }));

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });

describe("deterministic Workspace runtime uv cache bound", () => {
  it("prunes the cache over the threshold only when asked, and touches nothing else", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    const sessionId = "ws_" + "c".repeat(40);
    const session = await runtime.ensureSession({ cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef,
      internetEnabled: false, memoryMiB: 1024, runtimeSandboxId: null, sandboxName: workspaceSandboxName(sessionId), sessionId });
    const identity = { runtimeSandboxId: session.runtimeSandboxId, sessionId, modelRunId: "scheduled_run" };
    const write = (path: string, content: string) => runtime.callBoundTool({ ...identity, modelRunToolCallId: `write:${path}`,
      originalName: "sandbox_fs_write", arguments: { path, content } });
    const read = async (path: string) => (await runtime.callBoundTool({ ...identity, modelRunToolCallId: `read:${path}`,
      originalName: "sandbox_fs_read", arguments: { path } })).status;
    const cached = `${WORKSPACE_UV_CACHE_DIRECTORY}/archive-v0/entry`;
    const project = "/workspace/project/keep.txt";
    await write(cached, "x".repeat(32));
    await write(project, "kept");
    await runtime.syncPersonalSecrets({ ...identity, secrets: [] });
    expect(await read(cached)).toBe("complete");
    await runtime.syncPersonalSecrets({ ...identity, secrets: [], boundUvCache: true });
    expect(await read(cached)).toBe("error");
    expect(await read(project)).toBe("complete");
    await write(cached, "x".repeat(8));
    await runtime.syncPersonalSecrets({ ...identity, secrets: [], boundUvCache: true });
    expect(await read(cached)).toBe("complete");
  });
});

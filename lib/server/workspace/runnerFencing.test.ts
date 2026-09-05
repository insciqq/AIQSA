import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { createWorkspaceRunnerServer } from "./runnerServer";
import { workspaceSandboxName } from "@/lib/domain/workspace";

const token = "workspace-operation-fence-synthetic-token";
const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const sessionId = "session_fence_fixture";
const operation = (generation: number) => ({ generation, owner: `run:fixture_${generation}` });

describe("Workspace runner stale operation requests", () => {
  const servers: ReturnType<typeof createWorkspaceRunnerServer>[] = [];
  const directories: string[] = [];
  const close = (server: ReturnType<typeof createWorkspaceRunnerServer>) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-runner-fence-"));
    directories.push(directory);
    const runtime = new DeterministicWorkspaceRuntime(config);
    async function start() {
      const options = { runtime, token, operationDirectory: directory };
      const server = createWorkspaceRunnerServer(options);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return {
        server,
        post: (suffix: string, body: Record<string, unknown>, method = "POST") => fetch(`${url}/v1/sessions/${suffix}`, {
          body: JSON.stringify(body), method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }
        })
      };
    }
    const first = await start();
    const ensureBody = (generation: number, runtimeSandboxId: string | null) => ({
      cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef, internetEnabled: false,
      memoryMiB: 1024, operation: operation(generation), runtimeSandboxId,
      sandboxName: workspaceSandboxName(sessionId), sessionId
    });
    const created = await first.post("ensure", ensureBody(1, null));
    expect(created.status).toBe(200);
    const { runtimeSandboxId } = await created.json() as { runtimeSandboxId: string };
    return { ...first, close, ensureBody, runtime, runtimeSandboxId, start };
  }

  it.each([false, true])("rejects old commands, file writes and lifecycle work after handover (restart=%s)", async (restart) => {
    const value = await fixture();
    const next = await value.post("ensure", value.ensureBody(2, value.runtimeSandboxId));
    expect(next.status).toBe(200);
    let connection = value;
    if (restart) {
      await close(value.server);
      servers.splice(servers.indexOf(value.server), 1);
      connection = { ...value, ...await value.start() };
    }
    const calls = vi.spyOn(value.runtime, "callBoundTool");
    const stop = vi.spyOn(value.runtime, "stopSession");
    const remove = vi.spyOn(value.runtime, "removeSession");
    const terminate = vi.spyOn(value.runtime, "terminateExecutions");
    // These envelopes were authorized before the new owner won. Releasing
    // them after handover must not invoke any guest operation, even after
    // the receiver's in-memory state has been lost.
    const base = { operation: operation(1), runtimeSandboxId: value.runtimeSandboxId };
    const statuses: number[] = [];
    for (const originalName of ["sandbox_shell", "sandbox_fs_write"]) {
      const response = await connection.post(`${sessionId}/tools/${originalName}/call`, {
        ...base, modelRunId: "fixture_1", modelRunToolCallId: `old_${originalName}`,
        arguments: originalName === "sandbox_shell"
          ? { command: "touch /workspace/project/stale.txt" }
          : { path: "/workspace/project/stale.txt", content: "stale" }
      });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    for (const [suffix, method, extra] of [
      ["/executions/terminate", "POST", { executions: [] }],
      ["/stop", "POST", {}], ["", "DELETE", {}]
    ] as const) {
      const response = await connection.post(`${sessionId}${suffix}`, { ...base, ...extra }, method);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses).toEqual([409, 409, 409, 409, 409]);
    expect(calls).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("validates a replacement request before stopping the current owner", async () => {
    const value = await fixture();
    const stop = vi.spyOn(value.runtime, "stopSession");
    const response = await value.post("ensure", {
      ...value.ensureBody(2, value.runtimeSandboxId), cpus: 0
    });
    expect(response.status).toBe(400);
    await response.arrayBuffer();
    expect(stop).not.toHaveBeenCalled();
    const current = await value.post("ensure", value.ensureBody(1, value.runtimeSandboxId));
    expect(current.status).toBe(200);
    await current.arrayBuffer();
  });

  it("cancels active and unopened old output handles after export handover", async () => {
    const value = await fixture();
    const cancelled = [vi.fn(), vi.fn()];
    vi.spyOn(value.runtime, "collectOutputs").mockResolvedValueOnce(cancelled.map((cancel, index) => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("old")); }, cancel
      }),
      byteSize: 12, checksum: "a".repeat(64), mimeType: "text/plain", opaqueFileId: String(index).repeat(64), relativePath: `${index}.txt`
    })));
    const response = await value.post(`${sessionId}/outputs/list`, {
      operation: operation(1), runtimeSandboxId: value.runtimeSandboxId, modelRunId: "fixture_1", outputDirectory: "/workspace/out/fixture_1"
    });
    expect(response.status).toBe(200);
    const batch = await response.json() as { batchId: string; outputs: { opaqueFileId: string }[] };
    const address = value.server.address() as AddressInfo;
    const open = (index: number) => fetch(`http://127.0.0.1:${address.port}/v1/sessions/${sessionId}/outputs/stream?batchId=${batch.batchId}&opaqueFileId=${batch.outputs[index]!.opaqueFileId}`,
      { headers: { authorization: `Bearer ${token}` } });
    const stream = await open(0);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("old");
    const pending = reader.read().then(() => "continued", () => "aborted");
    const next = await value.post("ensure", value.ensureBody(2, value.runtimeSandboxId));
    expect(next.status).toBe(200);
    await next.arrayBuffer();
    expect(await pending).toBe("aborted");
    expect(cancelled[0]).toHaveBeenCalledOnce();
    const stale = await open(1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "workspace_operation_stale" });
    expect(cancelled[1]).toHaveBeenCalledOnce();
  });
});

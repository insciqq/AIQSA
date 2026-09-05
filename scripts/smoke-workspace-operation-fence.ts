import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Sandbox, SandboxNotFoundError } from "microsandbox";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { MicrosandboxWorkspaceRuntime } from "@/lib/server/workspace/microsandboxRuntime";
import { RemoteWorkspaceRuntime } from "@/lib/server/workspace/remoteRuntime";
import { WorkspaceRuntimeError, type WorkspaceRuntime, type WorkspaceToolResult } from "@/lib/server/workspace/runtime";

// Run as the sole command of an isolated KVM runner container. It owns one
// 1-GiB guest and one child receiver, with no provider or database credentials.
if (process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE") throw new Error("workspace_live_e2e_requires_disposable_confirmation");

const token = randomBytes(32).toString("hex");
const sessionId = `ws_${randomBytes(20).toString("hex")}`;
const sandboxName = workspaceSandboxName(sessionId);
const baseEnvironment = { ...process.env, AIQSA_TEST_MODE: "0", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0",
  AIQSA_WORKSPACE_CPUS: "1", AIQSA_WORKSPACE_MEMORY_MIB: "1024", AIQSA_WORKSPACE_RUNNER_TOKEN: token };
const config = getWorkspaceConfig({ ...baseEnvironment, AIQSA_WORKSPACE_RUNNER_TOKEN: undefined, AIQSA_WORKSPACE_RUNNER_URL: undefined });
const local = new MicrosandboxWorkspaceRuntime(config);
let child: ChildProcess | null = null;
let runtimeSandboxId: string | null = null;
let collision = true;
let phase = "initialization";
let ordinal = 0;
const operation = (generation: number) => ({ generation, owner: `run:fence_fixture_${generation}` });
const captureId = randomBytes(16).toString("hex");
const outputDirectory = "/workspace/output/capture-fixture";
const originals = ["original one", "original two"];

async function stopReceiver(): Promise<void> {
  if (!child) return;
  const current = child;
  child = null;
  if (current.exitCode !== null || current.signalCode !== null) return;
  const exited = once(current, "exit");
  current.kill("SIGKILL");
  await exited;
}

async function startReceiver(): Promise<RemoteWorkspaceRuntime> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const environment = { ...baseEnvironment, AIQSA_WORKSPACE_RUNNER_HOST: "127.0.0.1", AIQSA_WORKSPACE_RUNNER_PORT: String(port) };
  child = spawn(process.execPath, ["--import", "tsx", "scripts/workspace-runner.ts"], { env: environment, stdio: "ignore" });
  const remote = new RemoteWorkspaceRuntime(getWorkspaceConfig({ ...environment, AIQSA_WORKSPACE_RUNNER_URL: `http://127.0.0.1:${port}` }));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null);
    if ((await remote.health(AbortSignal.timeout(1_000))).state === "ready") return remote;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("workspace_receiver_start_timeout");
}

function data(result: WorkspaceToolResult): Record<string, unknown> {
  assert.equal(result.status, "complete");
  const parsed = JSON.parse(result.content[0]?.text ?? "null") as { data?: Record<string, unknown> } | null;
  assert.ok(parsed?.data);
  return parsed.data;
}

function ensure(remote: WorkspaceRuntime, generation: number) {
  return remote.ensureSession({ cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef, internetEnabled: false,
    memoryMiB: 1024, operation: operation(generation), runtimeSandboxId, sandboxName, sessionId, signal: AbortSignal.timeout(60_000) });
}

function call(remote: WorkspaceRuntime, generation: number, originalName: Parameters<WorkspaceRuntime["callBoundTool"]>[0]["originalName"], args: Record<string, unknown>) {
  assert.ok(runtimeSandboxId);
  return remote.callBoundTool({ arguments: args, modelRunId: `fence_fixture_${generation}`, modelRunToolCallId: `fence_call_${ordinal++}`,
    operation: operation(generation), originalName, runtimeSandboxId, sessionId, signal: AbortSignal.timeout(15_000) });
}

async function main(): Promise<void> {
  let rejected = 0;
  try {
    let remote = await startReceiver();
    collision = await Sandbox.get(sandboxName).then(() => true, (error: unknown) => {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    });
    assert.equal(collision, false);
    runtimeSandboxId = (await ensure(remote, 1)).runtimeSandboxId;
    await call(remote, 1, "sandbox_fs_write", { path: "/workspace/project/preserved.txt", content: "synthetic preserved file" });
    phase = "output_capture";
    assert.equal((await call(remote, 1, "sandbox_shell", { command: `mkdir -p ${outputDirectory}` })).status, "complete");
    for (let index = 0; index < originals.length; index += 1) {
      assert.equal((await call(remote, 1, "sandbox_fs_write", { path: `${outputDirectory}/${index}.txt`, content: originals[index]! })).status, "complete");
    }
    const capture = { modelRunId: "fence_fixture_1", outputDirectory, runtimeSandboxId, sessionId };
    const firstOutputs = await remote.collectOutputs({ ...capture, operation: operation(1), capture: { create: true, id: captureId } });
    assert.equal(firstOutputs.length, 2);
    assert.equal(await new Response(firstOutputs[0]!.body).text(), originals[0]);
    // A partial export loses the remaining HTTP handles, not its byte source.
    await remote.releaseOutputs({ batchId: firstOutputs[0]!.batchId!, operation: operation(1), runtimeSandboxId, sessionId });
    phase = "handover";
    assert.equal((await ensure(remote, 2)).runtimeSandboxId, runtimeSandboxId);
    await call(remote, 2, "sandbox_fs_write", { path: `${outputDirectory}/0.txt`, content: "replaced one" });
    await call(remote, 2, "sandbox_shell", { command: `mv ${outputDirectory}/1.txt ${outputDirectory}/renamed.txt && printf extra > ${outputDirectory}/extra.txt` });
    phase = "receiver_restart";
    await stopReceiver();
    remote = await startReceiver();
    // Release requests captured before handover only after the receiver
    // process was killed and restarted from its private durable high water.
    const old = { operation: operation(1), runtimeSandboxId, sessionId };
    const delayed = [
      () => call(remote, 1, "sandbox_shell", { command: "touch /workspace/project/stale.txt" }),
      () => call(remote, 1, "sandbox_fs_write", { path: "/workspace/project/stale.txt", content: "stale" }),
      () => remote.terminateExecutions({ ...old, executions: [] }),
      () => remote.stopSession(old),
      () => remote.removeSession(old),
      () => ensure(remote, 1),
      () => remote.retireSessionOperation(old),
      () => remote.releaseOutputCapture({ ...old, captureId, modelRunId: "fence_fixture_1" })
    ];
    phase = "delayed_requests";
    for (const request of delayed) {
      await assert.rejects(request, (error: unknown) => error instanceof WorkspaceRuntimeError && error.code === "workspace_operation_stale");
      rejected += 1;
    }
    const same = await Sandbox.get(sandboxName);
    assert.equal(same.id, runtimeSandboxId);
    assert.equal(same.status, "running");
    assert.equal(data(await call(remote, 2, "sandbox_fs_exists", { path: "/workspace/project/stale.txt" })).exists, false);
    assert.equal(data(await call(remote, 2, "sandbox_fs_read", { path: "/workspace/project/preserved.txt", encoding: "utf8" })).content, "synthetic preserved file");
    await call(remote, 2, "sandbox_fs_write", { path: "/workspace/project/current.txt", content: "current owner" });
    assert.equal(data(await call(remote, 2, "sandbox_fs_read", { path: "/workspace/project/current.txt", encoding: "utf8" })).content, "current owner");
    phase = "captured_outputs_after_restart";
    const recovered = await remote.collectOutputs({ ...capture, operation: operation(2), capture: { create: false, id: captureId } });
    assert.deepEqual(recovered.map((file) => file.relativePath), ["0.txt", "1.txt"]);
    for (let index = 0; index < recovered.length; index += 1) {
      const content = Buffer.from(await new Response(recovered[index]!.body).arrayBuffer());
      assert.equal(content.toString(), originals[index]);
      assert.equal(createHash("sha256").update(content).digest("hex"), recovered[index]!.checksum);
    }
    await remote.releaseOutputCapture({ ...capture, operation: operation(2), captureId });
    await assert.rejects(() => remote.collectOutputs({ ...capture, operation: operation(2), capture: { create: false, id: captureId } }),
      (error: unknown) => error instanceof WorkspaceRuntimeError && error.code === "workspace_output_export_failed");
    phase = "retirement";
    await remote.retireSessionOperation({ operation: operation(2), runtimeSandboxId, sessionId });
    assert.equal((await Sandbox.get(sandboxName)).status, "stopped");
  } finally {
    await stopReceiver();
    if (!collision) {
      await local.removeSession({ runtimeSandboxId, sessionId });
      assert.equal(await Sandbox.get(sandboxName).then(() => false, (error: unknown) => {
        if (error instanceof SandboxNotFoundError) return true;
        throw error;
      }), true);
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", staleRequestsRejected: rejected, receiverProcessRestart: true,
    capturedOutputsSurvived: 2, partialExportRecovered: true, laterTurnMutationIsolated: true, captureCleanup: true,
    currentOwnerWritable: true, sameDisk: true, staleFileAbsent: true, retirementStoppedVm: true, cleanup: true, guestMemoryMiB: 1024, concurrentGuests: 1 })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", phase, code: error instanceof WorkspaceRuntimeError ? error.code : "workspace_operation_proof_failed" })}\n`);
  process.exitCode = 1;
});

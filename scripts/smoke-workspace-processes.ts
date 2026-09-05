import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Sandbox, SandboxNotFoundError } from "microsandbox";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import {
  workspaceSyncCleanupId,
  type WorkspaceExecutionRecord,
  type WorkspaceExecutionRegistry
} from "@/lib/server/workspace/executionRegistry";
import { MicrosandboxWorkspaceRuntime } from "@/lib/server/workspace/microsandboxRuntime";
import { quiesceWorkspaceExecutions } from "@/lib/server/workspace/quiescence";
import { WorkspaceRuntimeError, type WorkspaceRuntime, type WorkspaceToolResult } from "@/lib/server/workspace/runtime";

// Run explicitly inside the acknowledged disposable KVM runner:
// AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE npx tsx scripts/smoke-workspace-processes.ts
// This exercises real guest processes and the shared quiescence boundary.
// Registry persistence/pagination is qualified separately against PostgreSQL.
if (process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE") {
  throw new Error("workspace_live_e2e_requires_disposable_confirmation");
}

const config = getWorkspaceConfig({
  ...process.env, AIQSA_TEST_MODE: "0", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0",
  AIQSA_WORKSPACE_CPUS: "1", AIQSA_WORKSPACE_MEMORY_MIB: "1024",
  AIQSA_WORKSPACE_RUNNER_TOKEN: undefined, AIQSA_WORKSPACE_RUNNER_URL: undefined, NODE_ENV: "production"
});
const runtime = new MicrosandboxWorkspaceRuntime(config);
const sessionId = `ws_${randomBytes(20).toString("hex")}`;
const sandboxName = workspaceSandboxName(sessionId);
let runtimeSandboxId: string | null = null;
let collision = false;
let phase = "initialization";
let ordinal = 0;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("workspace_process_observation_timeout");
}

function data(result: WorkspaceToolResult): Record<string, unknown> {
  assert.equal(result.status, "complete");
  const parsed = JSON.parse(result.content[0]?.text ?? "null") as { data?: Record<string, unknown> } | null;
  assert.ok(parsed?.data);
  return parsed.data;
}

const ensure = () => runtime.ensureSession({
  cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef, internetEnabled: false,
  memoryMiB: 1024, runtimeSandboxId, sandboxName, sessionId
});

function call(
  modelRunId: string,
  originalName: Parameters<WorkspaceRuntime["callBoundTool"]>[0]["originalName"],
  args: Record<string, unknown>,
  options: { modelRunToolCallId?: string; signal?: AbortSignal } = {}
): Promise<WorkspaceToolResult> {
  assert.ok(runtimeSandboxId);
  return runtime.callBoundTool({
    arguments: args, modelRunId, modelRunToolCallId: options.modelRunToolCallId ?? `probe_${ordinal++}`,
    originalName, runtimeSandboxId, sessionId, signal: options.signal
  });
}

function registryFixture() {
  const rows: Array<WorkspaceExecutionRecord & { state: WorkspaceExecutionRecord["state"] }> = [];
  const open = () => rows.filter((row) => row.state === "ACTIVE" || row.state === "TERMINATING");
  const registry: WorkspaceExecutionRegistry = {
    async closeAll({ to }) { const remaining = open(); remaining.forEach((row) => { row.state = to; }); return remaining.length; },
    async find({ runtimeExecSessionId }) { return rows.find((row) => row.runtimeExecSessionId === runtimeExecSessionId) ?? null; },
    async listOpen() { return open().slice(0, 256); },
    async register(input) {
      if (rows.some((row) => row.modelRunToolCallId === input.modelRunToolCallId)) return "conflict";
      rows.push({ ...input, id: `row_${rows.length}`, state: "ACTIVE" });
      return "registered";
    },
    async transition({ id, from, to }) {
      const row = rows.find((row) => row.id === id);
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      return true;
    }
  };
  return { open, registry };
}

async function main(): Promise<void> {
  const cases = ["sync_cancelled", "sync_descendant", "async_term_resistant", "async_leader_exit", "async_closed_handle"] as const;
  const results: Array<{ name: string; stoppedVm: boolean; markerAbsent: boolean; openExecutions: number; sameDisk: boolean }> = [];
  try {
    collision = await Sandbox.get(sandboxName).then(() => true, (error: unknown) => {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    });
    assert.equal(collision, false);
    runtimeSandboxId = (await ensure()).runtimeSandboxId;
    await call("fixture", "sandbox_fs_write", { path: "/workspace/project/preserved.txt", content: "synthetic persistence" });
    for (const [index, name] of cases.entries()) {
      phase = name;
      assert.equal((await ensure()).runtimeSandboxId, runtimeSandboxId);
      const { registry, open } = registryFixture();
      const runId = `process_run_${index}`;
      const callId = `process_call_${index}`;
      const ready = `/workspace/project/probe-${index}.ready`;
      const marker = `/workspace/project/probe-${index}.late`;
      const script = `printf ready > ${ready}; sleep 20; printf late > ${marker}`;
      const descendant = `setsid sh -c '${script}' </dev/null >/dev/null 2>&1 &`;
      const startedAt = Date.now();
      const handle = await Sandbox.get(sandboxName);
      assert.equal(handle.id, runtimeSandboxId);
      const sandbox = await handle.connectWithTimeout(10_000);
      if (name.startsWith("sync_")) {
        await registry.register({
          modelRunId: runId, modelRunToolCallId: callId,
          runtimeExecSessionId: workspaceSyncCleanupId(callId), sessionId
        });
        if (name === "sync_cancelled") {
          const controller = new AbortController();
          const pending = call(runId, "sandbox_shell", { command: script }, { modelRunToolCallId: callId, signal: controller.signal })
            .then(() => "complete", (error: unknown) => error instanceof WorkspaceRuntimeError ? error.code : "unexpected");
          try {
            await waitFor(() => sandbox.fs().exists(ready));
          } finally {
            controller.abort();
          }
          assert.equal(await pending, "workspace_tool_cancelled");
        } else {
          assert.equal(data(await call(runId, "sandbox_shell", { command: descendant }, { modelRunToolCallId: callId })).exitCode, 0);
          await waitFor(() => sandbox.fs().exists(ready));
        }
      } else {
        const started = await call(runId, "sandbox_exec_start", {
          command: name === "async_term_resistant" ? `trap '' TERM; ${script}` : descendant, shell: true
        }, { modelRunToolCallId: callId });
        assert.ok(started.execSessionId);
        await registry.register({
          modelRunId: runId, modelRunToolCallId: callId, runtimeExecSessionId: started.execSessionId, sessionId
        });
        await waitFor(() => sandbox.fs().exists(ready));
        if (name === "async_term_resistant") {
          await call(runId, "sandbox_exec_signal", { execSessionId: started.execSessionId, signal: "term" });
          await delay(100);
          assert.equal(data(await call(runId, "sandbox_exec_poll", { execSessionId: started.execSessionId })).done, false);
        } else {
          await waitFor(async () => {
            const polled = data(await call(runId, "sandbox_exec_poll", { execSessionId: started.execSessionId }));
            return polled.done === true && (polled.exitStatus as { code?: unknown } | null)?.code === 0;
          });
          if (name === "async_closed_handle") await call(runId, "sandbox_exec_close", { execSessionId: started.execSessionId });
        }
      }
      const quiescence = await quiesceWorkspaceExecutions({
        unregisteredCommands: 0, modelRunId: runId, registry, runtime, runtimeSandboxId, sessionId
      });
      assert.deepEqual(quiescence, { proven: true, stoppedVm: true });
      assert.equal(open().length, 0);
      const stopped = await Sandbox.get(sandboxName);
      assert.equal(stopped.id, runtimeSandboxId);
      assert.equal(stopped.status, "stopped");
      assert.equal((await ensure()).runtimeSandboxId, runtimeSandboxId);
      // Wait beyond the original side-effect deadline, including a resumed
      // guest, so pausing the writer cannot masquerade as terminating it.
      await delay(Math.max(0, startedAt + 22_000 - Date.now()));
      assert.equal(data(await call(runId, "sandbox_fs_exists", { path: marker })).exists, false);
      assert.equal(data(await call(runId, "sandbox_fs_read", { path: "/workspace/project/preserved.txt", encoding: "utf8" })).content, "synthetic persistence");
      results.push({ name, stoppedVm: true, markerAbsent: true, openExecutions: 0, sameDisk: true });
    }
  } finally {
    if (!collision) {
      await runtime.removeSession({ runtimeSandboxId, sessionId });
      const absent = await Sandbox.get(sandboxName).then(() => false, (error: unknown) => {
        if (error instanceof SandboxNotFoundError) return true;
        throw error;
      });
      assert.equal(absent, true);
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", cases: results, cleanup: true, guestMemoryMiB: 1024, concurrentGuests: 1 })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", phase, code: error instanceof WorkspaceRuntimeError ? error.code : "workspace_process_proof_failed" })}\n`);
  process.exitCode = 1;
});

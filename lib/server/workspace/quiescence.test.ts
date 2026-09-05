import { describe, expect, it, vi } from "vitest";
import type { WorkspaceExecutionRecord, WorkspaceExecutionRegistry } from "./executionRegistry";
import { quiesceWorkspaceExecutions } from "./quiescence";
import type { WorkspaceRuntime } from "./runtime";

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row_${index}`, modelRunId: "run_fixture", modelRunToolCallId: `call_${index}`,
    runtimeExecSessionId: `exec_${index}`, sessionId: "session_fixture", state: "ACTIVE"
  } as WorkspaceExecutionRecord & { state: WorkspaceExecutionRecord["state"] }));
  const open = () => rows.filter((row) => row.state === "ACTIVE" || row.state === "TERMINATING");
  const registry: WorkspaceExecutionRegistry = {
    closeAll: vi.fn(async ({ to }) => { const rest = open(); rest.forEach((row) => { row.state = to; }); return rest.length; }),
    find: vi.fn(async () => null),
    listOpen: vi.fn(async () => open().slice(0, 256)),
    register: vi.fn(async () => "registered" as const),
    transition: vi.fn(async ({ id, from, to }) => {
      const row = rows.find((row) => row.id === id);
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      return true;
    })
  };
  const runtime = {
    stopSession: vi.fn(async () => undefined),
    terminateExecutions: vi.fn<WorkspaceRuntime["terminateExecutions"]>(async ({ executions }) =>
      executions.map(({ runtimeExecSessionId }) => ({ outcome: "closed", runtimeExecSessionId })))
  } as unknown as WorkspaceRuntime;
  return {
    open, registry, rows, runtime,
    input: { unregisteredCommands: 0, modelRunId: "run_fixture", registry, runtime,
      runtimeSandboxId: "runtime_fixture", sessionId: "session_fixture" }
  };
}

describe("Workspace terminal registry drain", () => {
  it("cannot certify quiescence after visiting only the first 256 rows", async () => {
    const value = fixture(257);
    await expect(quiesceWorkspaceExecutions(value.input)).resolves.toMatchObject({ proven: true });
    expect(value.open()).toHaveLength(0);
  });

  it("does not settle when terminal registry transitions are not acknowledged", async () => {
    const value = fixture(1);
    vi.mocked(value.registry.transition).mockResolvedValue(false);
    vi.mocked(value.registry.closeAll).mockRejectedValue(new Error("synthetic registry unavailable"));
    await expect(quiesceWorkspaceExecutions(value.input)).resolves.toMatchObject({ proven: false });
    expect(value.open()).toHaveLength(1);
  });

  it("retains the fence if a fallback stop succeeds but closing the durable rows fails", async () => {
    const value = fixture(1);
    vi.mocked(value.runtime.terminateExecutions).mockResolvedValue([{ outcome: "unknown", runtimeExecSessionId: "exec_0" }]);
    vi.mocked(value.registry.closeAll).mockRejectedValue(new Error("synthetic registry unavailable"));
    await expect(quiesceWorkspaceExecutions(value.input)).resolves.toEqual({ proven: false, stoppedVm: true });
    expect(value.open()).toHaveLength(1);
  });
});

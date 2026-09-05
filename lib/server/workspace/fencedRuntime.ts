import { parseWorkspaceOperation, WorkspaceOperationFence, type WorkspaceOperation, type WorkspaceOperationFenceState } from "./operationFence";
import type { WorkspaceRuntime } from "./runtime";

// Only the explicitly test-gated deterministic runtime runs in the app. Its
// simulated VM and receiver fence must share the same process-wide lifetime.
const shared = globalThis as typeof globalThis & { aiqsaWorkspaceOperationFence?: WorkspaceOperationFenceState };

export function fenceDeterministicWorkspaceRuntime(runtime: WorkspaceRuntime, sharedState = false): WorkspaceRuntime {
  const state = sharedState
    ? shared.aiqsaWorkspaceOperationFence ??= new Map()
    : new Map();
  const fence = new WorkspaceOperationFence({ state, stop: (input) => runtime.stopSession(input) });
  const call = <T>(input: { operation?: WorkspaceOperation; sessionId: string; signal?: AbortSignal }, action: (signal: AbortSignal) => Promise<T>) =>
    fence.run({ operation: parseWorkspaceOperation(input.operation), sessionId: input.sessionId }, (signal) =>
      action(input.signal ? AbortSignal.any([input.signal, signal]) : signal));
  return {
    health: (signal) => runtime.health(signal),
    claimSessionOperation: (input) => fence.claim(input),
    retireSessionOperation: (input) => fence.retire(input),
    async ensureSession(input) {
      await fence.claim({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId, sessionId: input.sessionId });
      return call(input, (signal) => runtime.ensureSession({ ...input, signal }));
    },
    listStagedAttachments: (input) => call(input, (signal) => runtime.listStagedAttachments({ ...input, signal })),
    stageAttachments: (input) => call(input, (signal) => runtime.stageAttachments({ ...input, signal })),
    loadBoundTools: (input) => call(input, (signal) => runtime.loadBoundTools({ ...input, signal })),
    callBoundTool: (input) => call(input, (signal) => runtime.callBoundTool({ ...input, signal })),
    cancelToolCall: (input) => call(input, () => runtime.cancelToolCall(input)),
    terminateExecutions: (input) => call(input, (signal) => runtime.terminateExecutions({ ...input, signal })),
    collectOutputs: (input) => call(input, (signal) => runtime.collectOutputs({ ...input, signal })),
    ...(runtime.releaseOutputCapture ? { releaseOutputCapture: (input: Parameters<NonNullable<WorkspaceRuntime["releaseOutputCapture"]>>[0]) =>
      call(input, (signal) => runtime.releaseOutputCapture!({ ...input, signal })) } : {}),
    createProjectArchive: (input) => call(input, (signal) => runtime.createProjectArchive({ ...input, signal })),
    stopSession: (input) => call(input, (signal) => runtime.stopSession({ ...input, signal })),
    removeSession: (input) => call(input, (signal) => runtime.removeSession({ ...input, signal })),
    ...(runtime.releaseOutputs ? { releaseOutputs: runtime.releaseOutputs.bind(runtime) } : {})
  };
}

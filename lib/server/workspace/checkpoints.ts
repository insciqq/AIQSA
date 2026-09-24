import type { PrismaClient } from "@prisma/client";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import { CHECKPOINT_OUTPUTS_TOOL_NAME } from "../tools/checkpointOutputs";
import { parseWorkspaceCheckpointInput, WorkspaceCheckpointError } from "./checkpointInput";
import { createWorkspaceCheckpointStore, type CheckpointContext } from "./checkpointStore";
import type { createWorkspaceSelectedCaptures } from "./selectedCapture";

type CheckpointExecutionContext = Pick<ToolExecutionContext, "runId" | "userId" | "persistedToolCallId"> & Readonly<{
  request: Pick<ToolExecutionContext["request"], "workspaceCheckpoints" | "workspace" | "toolMode">;
}>;

export function createWorkspaceCheckpoints(prisma: PrismaClient, captures: ReturnType<typeof createWorkspaceSelectedCaptures>, maximumBytes: number) {
  const store = createWorkspaceCheckpointStore(prisma, maximumBytes);
  function context(call: ModelToolCall, value: CheckpointExecutionContext): CheckpointContext {
    if (!value.request.workspaceCheckpoints || !value.request.workspace || value.request.toolMode === "none" || !value.runId || !value.userId || !value.persistedToolCallId || call.name !== CHECKPOINT_OUTPUTS_TOOL_NAME)
      throw new WorkspaceCheckpointError("workspace_checkpoint_unavailable");
    return { runId: value.runId, userId: value.userId, toolCallId: value.persistedToolCallId, call };
  }
  async function execute(call: ModelToolCall, value: CheckpointExecutionContext, signal?: AbortSignal, recovering = false): Promise<ToolExecutionResult> {
    const c = context(call, value);
    const input = parseWorkspaceCheckpointInput(call.arguments, c.runId);
    signal?.throwIfAborted();
    const existing = recovering ? await store.read(c) : await store.reserve(c, input);
    if (!existing || existing.state === "UNAVAILABLE") throw new WorkspaceCheckpointError("workspace_checkpoint_unavailable");
    if (existing.state === "SETTLED") return store.decode(c, existing.result);
    const consumer = { runId: c.runId, userId: c.userId, consumerKey: c.toolCallId };
    // Known captured identity survives operation-generation changes. A crash
    // before any reservation never authorizes reading a later mutable version.
    const recoveredCapture = recovering && !existing.captureId && !input.captureId
      ? await prisma.workspaceSelectedCapture.findUnique({ where: {
        modelRunId_requestKey: { modelRunId: c.runId, requestKey: c.toolCallId }
      }, select: { id: true } }) : null;
    if (recovering && !existing.captureId && !input.captureId && !recoveredCapture) throw new WorkspaceCheckpointError("workspace_checkpoint_unavailable");
    const knownId = existing.captureId ?? recoveredCapture?.id;
    const capture = knownId ? await captures.lookup({ ...consumer, captureId: knownId })
      : input.captureId ? await captures.acquire({ ...consumer, captureId: input.captureId })
      : await captures.create({ ...consumer, requestKey: c.toolCallId, files: input.files, signal });
    const reference = { ...consumer, captureId: capture.id };
    await store.bind(c, capture.id, input.files.map(file => `${file.root}/${file.relativePath}`));
    await captures.retain({ ...reference, signal });
    signal?.throwIfAborted();
    return captures.settleRetained(reference, async (tx, files) => {
      signal?.throwIfAborted();
      return store.publish(tx, c, files);
    });
  }
  return {
    execute,
    restore: (call: ModelToolCall, value: CheckpointExecutionContext, signal?: AbortSignal) => execute(call, value, signal, true),
    /** Joins the existing export sweep. Only declared already-retained objects
     * may settle after an ended run; this never opens a guest or uploads bytes. */
    async recover(signal?: AbortSignal) {
      let completed = 0;
      for (const pending of await store.pending()) {
        if (signal?.aborted) break;
        const c: CheckpointContext = { runId: pending.modelRunId, userId: pending.binding.modelRun.userId,
          toolCallId: pending.toolCallId, call: { id: pending.toolCall.providerCallId, name: CHECKPOINT_OUTPUTS_TOOL_NAME,
            arguments: pending.arguments as Record<string, unknown> } };
        try {
          if (!pending.captureId || !pending.capture?.files.length || pending.capture.files.some(file => file.storageState !== "READY")) {
            await store.unavailable(c); continue;
          }
          await captures.settleRetained({ runId: c.runId, userId: c.userId, consumerKey: c.toolCallId, captureId: pending.captureId },
            (tx, files) => store.publish(tx, c, files, true), { allowEndedRun: true });
          completed++;
        } catch {
          // Rotate a blocked obligation so it cannot starve later ready checkpoints.
          await store.defer(pending.id).catch(() => undefined);
        }
      }
      return { completed };
    }
  };
}

export async function defaultWorkspaceCheckpoints() {
  const [{ prisma }, { createS3StorageAdapter }, { workspaceConfig, workspaceRuntime }, { createWorkspaceSelectedCaptures }] = await Promise.all([
    import("../prisma"), import("../uploads/storage"), import("./defaultServices"), import("./selectedCapture")
  ]);
  return createWorkspaceCheckpoints(prisma, createWorkspaceSelectedCaptures({ prisma, storage: createS3StorageAdapter(), config: workspaceConfig, runtime: workspaceRuntime }), workspaceConfig.outputTotalMaxBytes);
}

import type { ModelToolCall, ToolExecutionResult } from "../tools/types";

export type WorkspaceCheckpointView = import("@/lib/contracts/workspace").ThreadWorkspaceCheckpoint;
export type WorkspaceCheckpointFileView = import("@/lib/contracts/workspace").ThreadGeneratedFile & { checkpoint: WorkspaceCheckpointView };

/** Public evidence of preservation has no object key, runtime identity or private capture authority. */
export function workspaceCheckpointResult(call: ModelToolCall, checkpoint: WorkspaceCheckpointView,
  captureId: string, files: readonly WorkspaceCheckpointFileView[]): ToolExecutionResult {
  return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: {
    checkpoint_id: checkpoint.id, capture_id: captureId, status: "saved", intermediate: true,
    description: checkpoint.description,
    files: files.map(file => ({ attachment_id: file.attachmentId, path: file.relativePath, file_name: file.fileName,
      mime_type: file.mimeType, byte_size: file.byteSize })),
    meaning: "These exact intermediate files are durably saved. This is not a quality check or confirmation that the overall task is complete."
  } }], artifacts: [{ type: "artifact", data: { artifactType: "workspace_checkpoint", payload: { checkpoint, files } } }] };
}

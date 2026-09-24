import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { WORKSPACE_CHECKPOINT_LIMITS } from "../tools/checkpointOutputs";
import { parseWorkspaceFileSelection, type WorkspaceSelectedFile } from "./outputManifest";

export class WorkspaceCheckpointError extends Error {
  constructor(readonly code: "workspace_checkpoint_invalid" | "workspace_checkpoint_unavailable" | "workspace_checkpoint_limit_exceeded") {
    super(code); this.name = "WorkspaceCheckpointError";
  }
}
export type WorkspaceCheckpointInput = Readonly<{
  files: readonly WorkspaceSelectedFile[]; description: string; captureId?: string;
}>;

/** Publication is narrower than private capture: explicit deliverables only. */
export function parseWorkspaceCheckpointInput(value: unknown, runId: string): WorkspaceCheckpointInput {
  const invalid = () => new WorkspaceCheckpointError("workspace_checkpoint_invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["files", "description", "capture_id"].includes(key)) ||
    typeof input.description !== "string" || !input.description.trim() ||
    input.description.length > WORKSPACE_CHECKPOINT_LIMITS.descriptionCharacters || /[\u0000-\u001f\u007f]/u.test(input.description) ||
    input.capture_id !== undefined && (typeof input.capture_id !== "string" || !/^[a-f0-9]{32}$/u.test(input.capture_id)) ||
    !Array.isArray(input.files) || !input.files.length || input.files.length > WORKSPACE_CHECKPOINT_LIMITS.files) throw invalid();
  const outputDirectory = workspaceRunOutputDirectory(runId);
  const files = input.files.map((path): WorkspaceSelectedFile => {
    if (typeof path !== "string") throw invalid();
    let relative = path;
    if (path.startsWith("/workspace/project/")) relative = path.slice(11);
    else if (path.startsWith(`${outputDirectory}/`)) relative = `output/${path.slice(outputDirectory.length + 1)}`;
    else if (path.startsWith("/")) throw invalid();
    const match = /^(project|output)\/(.+)$/u.exec(relative);
    if (!match) throw invalid();
    const parts = match[2]!.split("/");
    if (parts.some(part => part.startsWith(".")) || parts.some(part => ["node_modules", "__pycache__", "cache", "caches", "tmp"].includes(part))) throw invalid();
    return { root: match[1] as "project" | "output", relativePath: match[2]! };
  });
  let validated: readonly WorkspaceSelectedFile[];
  try { validated = parseWorkspaceFileSelection({ files, producerOperation: { generation: 1, owner: "checkpoint-input-validation" } }, WORKSPACE_CHECKPOINT_LIMITS.files).files; }
  catch { throw invalid(); }
  return { files: validated, description: input.description.trim(),
    ...(typeof input.capture_id === "string" ? { captureId: input.capture_id } : {}) };
}

import { parseWorkspaceFileSelection, type WorkspaceSelectedFile } from "./outputManifest";
import { WorkspaceImageError, type WorkspaceImageTransform } from "./imageCapture";

/** Only guest-relative selected-file authority, never an arbitrary filesystem path. */
export function workspaceImageInput(value: unknown): { file: WorkspaceSelectedFile; transform?: WorkspaceImageTransform } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceImageError("workspace_image_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["path", "crop", "resize"].includes(key)) || typeof input.path !== "string") throw new WorkspaceImageError("workspace_image_invalid");
  const path = input.path.startsWith("/workspace/") ? input.path.slice(11) : input.path;
  const match = /^(inbox|project|output)\/(.+)$/u.exec(path);
  if (!match) throw new WorkspaceImageError("workspace_image_invalid");
  const file = parseWorkspaceFileSelection({ files: [{ root: match[1], relativePath: match[2] }],
    producerOperation: { generation: 1, owner: "image-input-validation" } }).files[0]!;
  // The shared image decoder owns geometry validation against actual dimensions.
  const transform = input.crop !== undefined || input.resize !== undefined ? {
    ...(input.crop !== undefined ? { crop: input.crop as NonNullable<WorkspaceImageTransform["crop"]> } : {}),
    ...(input.resize !== undefined ? { resize: input.resize as NonNullable<WorkspaceImageTransform["resize"]> } : {})
  } : undefined;
  return { file, ...(transform ? { transform } : {}) };
}

/** Absolute output paths name the current run directory, whereas capture's
 * output root is already scoped to that directory. Never double-prefix it. */
export function workspaceImageInputForRun(value: unknown, outputDirectory: string) {
  const parsed = workspaceImageInput(value);
  if (parsed.file.root !== "output") return parsed;
  const path = (value as { path: string }).path;
  const relativeDirectory = outputDirectory.replace(/^\/workspace\/output\//u, "");
  if (!outputDirectory.startsWith("/workspace/output/") || !relativeDirectory || relativeDirectory.includes("/")) throw new WorkspaceImageError("workspace_image_invalid");
  if (path.startsWith("/") && !path.startsWith(`${outputDirectory}/`)) throw new WorkspaceImageError("workspace_image_invalid");
  const prefix = `${relativeDirectory}/`;
  const relativePath = parsed.file.relativePath.startsWith(prefix) ? parsed.file.relativePath.slice(prefix.length) : parsed.file.relativePath;
  const file = parseWorkspaceFileSelection({ files: [{ root: "output", relativePath }],
    producerOperation: { generation: 1, owner: "image-input-validation" } }).files[0]!;
  return { ...parsed, file };
}

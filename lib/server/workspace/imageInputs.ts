import { parseWorkspaceFileSelection, type WorkspaceSelectedFile } from "./outputManifest";
import { WorkspaceImageError, type WorkspaceImageTransform } from "./imageCapture";

/** A run's id names its output folder (`workspaceRunOutputDirectory`), which tells it from a folder a run made in its own. */
const RUN_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What to do with a file in another run's output folder: the capture's output root is the run's own. */
export const OTHER_OUTPUT_FOLDER = "That output folder belongs to another run of this chat, an earlier answer or a background " +
  "sub-agent, and only your own can be read by path. Copy the file with `cp` into /workspace/project/ and use the copy's path. " +
  "If an earlier answer delivered it, the inbox index also lists its copy (source=export).";

/**
 * Whether a path names a file in another run's output folder: as an absolute path, or `/workspace`-relative as a
 * sub-agent's file list names it, where only a run's id tells that from a folder inside this run's own.
 */
export function outputFolderOfAnotherRun(path: unknown, outputDirectory: string): boolean {
  if (typeof path !== "string") return false;
  const absolute = path.startsWith("/workspace/output/");
  if (!absolute && !path.startsWith("output/")) return false;
  const [folder = "", ...file] = path.slice(absolute ? "/workspace/output/".length : "output/".length).split("/");
  if (file.length === 0 || `/workspace/output/${folder}` === outputDirectory) return false;
  return absolute || RUN_FOLDER.test(folder);
}

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
  if (outputFolderOfAnotherRun(path, outputDirectory)) throw new WorkspaceImageError("workspace_image_invalid");
  const prefix = `${relativeDirectory}/`;
  const relativePath = parsed.file.relativePath.startsWith(prefix) ? parsed.file.relativePath.slice(prefix.length) : parsed.file.relativePath;
  const file = parseWorkspaceFileSelection({ files: [{ root: "output", relativePath }],
    producerOperation: { generation: 1, owner: "image-input-validation" } }).files[0]!;
  return { ...parsed, file };
}

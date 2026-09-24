import { isSafeWorkspaceRelativePath, isWorkspaceOpaqueId, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { WorkspaceRuntimeError } from "./runtime";
import { parseWorkspaceOperation, type WorkspaceOperation } from "./operationFence";

export type WorkspaceSelectedFile = Readonly<{ root: "inbox" | "project" | "output"; relativePath: string }>;
export type WorkspaceFileSelection = Readonly<{
  files: readonly WorkspaceSelectedFile[];
  /** Frozen creation authority, independently of the current lookup authority. */
  producerOperation: WorkspaceOperation;
}>;

export function parseWorkspaceFileSelection(value: unknown, maximum = 100): WorkspaceFileSelection {
  const invalid = () => new WorkspaceRuntimeError("workspace_output_export_failed");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const selection = value as Record<string, unknown>;
  if (!Array.isArray(selection.files) || !selection.files.length || selection.files.length > maximum) {
    throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  }
  const keys = new Set<string>();
  const files = selection.files.map((item): WorkspaceSelectedFile => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const file = item as Record<string, unknown>;
    if (file.root !== "inbox" && file.root !== "project" && file.root !== "output") throw invalid();
    if (typeof file.relativePath !== "string" || !isSafeWorkspaceRelativePath(`${file.root}/${file.relativePath}`)) throw invalid();
    const parts = file.relativePath.split("/");
    // Only staged originals, never the inbox index or message manifests.
    if (file.root === "inbox" && (parts.length !== 3 || parts[0] !== "messages" ||
      !isWorkspaceOpaqueId(parts[1]!) || !isWorkspaceOpaqueId(parts[2]!.split("--")[0]!) || !parts[2]!.includes("--"))) throw invalid();
    const key = `${file.root}/${file.relativePath}`;
    if (keys.has(key)) throw invalid();
    keys.add(key);
    return { root: file.root, relativePath: file.relativePath };
  });
  files.sort((a, b) => `${a.root}/${a.relativePath}` < `${b.root}/${b.relativePath}` ? -1 : 1);
  return { files, producerOperation: parseWorkspaceOperation(selection.producerOperation) };
}

export function selectedCaptureRequest(input: {
  capture?: Readonly<{ create: boolean; id: string }>; selection?: WorkspaceFileSelection;
  operation?: WorkspaceOperation; modelRunId: string; outputDirectory: string;
}, maximum = 100): WorkspaceFileSelection | undefined {
  if (input.selection === undefined) return undefined;
  const capture = parseOutputCaptureRequest(input.capture);
  const selection = parseWorkspaceFileSelection(input.selection, maximum);
  const operation = parseWorkspaceOperation(input.operation);
  if (!isWorkspaceOpaqueId(input.modelRunId) || input.outputDirectory !== workspaceRunOutputDirectory(input.modelRunId)) {
    throw new WorkspaceRuntimeError("workspace_output_export_failed");
  }
  if (capture.create && (operation.generation !== selection.producerOperation.generation || operation.owner !== selection.producerOperation.owner)) {
    throw new WorkspaceRuntimeError("workspace_operation_stale");
  }
  return selection;
}

export type WorkspaceOutputIdentity = Readonly<{
  byteSize: number;
  checksum: string;
  mimeType: string;
  relativePath: string;
}>;

/** Private recovery authority, never a browser or model projection. */
export type WorkspaceOutputCapture = Readonly<{
  id: string;
  outputs: readonly WorkspaceOutputIdentity[] | null;
}>;

export function outputIdentities(value: unknown, limits?: Pick<WorkspaceConfig,
  "outputMaxFiles" | "outputFileMaxBytes" | "outputTotalMaxBytes">, allowEmptyFiles = false): readonly WorkspaceOutputIdentity[] {
  if (!Array.isArray(value) || value.length > (limits?.outputMaxFiles ?? 100)) {
    throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  }
  const paths = new Set<string>();
  let total = 0;
  const outputs = value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new WorkspaceRuntimeError("workspace_output_export_failed");
    const row = entry as Record<string, unknown>;
    if (typeof row.relativePath !== "string" || !isSafeWorkspaceRelativePath(row.relativePath) || paths.has(row.relativePath) ||
      !Number.isSafeInteger(row.byteSize) || (row.byteSize as number) < (allowEmptyFiles ? 0 : 1) ||
      (row.byteSize as number) > (limits?.outputFileMaxBytes ?? 1_073_741_824) ||
      typeof row.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(row.checksum) ||
      typeof row.mimeType !== "string" || row.mimeType.length < 1 || row.mimeType.length > 255 || /[\r\n\0]/u.test(row.mimeType)) {
      throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
    }
    paths.add(row.relativePath);
    total += row.byteSize as number;
    return { byteSize: row.byteSize as number, checksum: row.checksum, mimeType: row.mimeType, relativePath: row.relativePath };
  });
  if (total > (limits?.outputTotalMaxBytes ?? 2_147_483_647)) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  return outputs.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

export function parseOutputCaptureRequest(value: unknown): Readonly<{ create: boolean; id: string }> {
  if (typeof value !== "object" || value === null ||
    typeof (value as { create?: unknown }).create !== "boolean" ||
    typeof (value as { id?: unknown }).id !== "string" || !/^[a-f0-9]{32}$/u.test((value as { id: string }).id)) {
    throw new WorkspaceRuntimeError("workspace_output_export_failed");
  }
  return { create: (value as { create: boolean }).create, id: (value as { id: string }).id };
}

export function parseOutputCapture(value: unknown): WorkspaceOutputCapture {
  const { id } = parseOutputCaptureRequest({ ...(typeof value === "object" && value !== null ? value : {}), create: false });
  const outputs = (value as { outputs?: unknown }).outputs;
  return { id, outputs: outputs === null ? null : outputIdentities(outputs) };
}

export function sameOutputIdentities(left: readonly WorkspaceOutputIdentity[], right: readonly WorkspaceOutputIdentity[]): boolean {
  return JSON.stringify(outputIdentities(left)) === JSON.stringify(outputIdentities(right));
}

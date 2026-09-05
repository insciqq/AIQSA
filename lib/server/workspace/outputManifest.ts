import { isSafeWorkspaceRelativePath } from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { WorkspaceRuntimeError } from "./runtime";

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
  "outputMaxFiles" | "outputFileMaxBytes" | "outputTotalMaxBytes">): readonly WorkspaceOutputIdentity[] {
  if (!Array.isArray(value) || value.length > (limits?.outputMaxFiles ?? 100)) {
    throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  }
  const paths = new Set<string>();
  let total = 0;
  const outputs = value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new WorkspaceRuntimeError("workspace_output_export_failed");
    const row = entry as Record<string, unknown>;
    if (typeof row.relativePath !== "string" || !isSafeWorkspaceRelativePath(row.relativePath) || paths.has(row.relativePath) ||
      !Number.isSafeInteger(row.byteSize) || (row.byteSize as number) < 1 ||
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

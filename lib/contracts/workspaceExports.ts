import { decodeThreadGeneratedFile, type ThreadGeneratedFile } from "./workspace";

export const WORKSPACE_EXPORT_PAGE_SIZE = 30;
export type WorkspaceExportEntry = Readonly<{
  createdAt: string;
  files: readonly ThreadGeneratedFile[];
  messageId: string;
}>;
export type WorkspaceExportPage = Readonly<{
  exports: readonly WorkspaceExportEntry[];
  nextCursor: string | null;
}>;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);
}

export function decodeWorkspaceExportPage(value: unknown): WorkspaceExportPage | null {
  if (typeof value !== "object" || value === null || !("exports" in value) || !("nextCursor" in value) ||
    !Array.isArray(value.exports) || value.exports.length > WORKSPACE_EXPORT_PAGE_SIZE ||
    !(value.nextCursor === null || identifier(value.nextCursor))) return null;
  const entries: WorkspaceExportEntry[] = [];
  for (const item of value.exports) {
    if (typeof item !== "object" || item === null || !identifier(item.messageId) ||
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
      !Array.isArray(item.files) || item.files.length === 0 || item.files.length > 100) return null;
    const files = item.files.map(decodeThreadGeneratedFile);
    if (files.some((file: ThreadGeneratedFile | null) => file === null)) return null;
    entries.push({ createdAt: new Date(item.createdAt).toISOString(), files: files as ThreadGeneratedFile[], messageId: item.messageId });
  }
  return { exports: entries, nextCursor: value.nextCursor };
}

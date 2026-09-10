/** Acknowledges this request's successful write, independently of activation/checks. */
export type AdminProviderModelSaveReceipt = Readonly<{
  connectionId: string;
  modelId: string;
  displayName: string;
  draftVersion: number;
  saved: "name" | "configuration";
  publication: "not_requested" | "draft" | "active";
  checks: "not_requested" | "unknown" | "checked" | "failed" | "skipped";
}>;

export function decodeAdminProviderModelSaveReceipt(value: unknown): AdminProviderModelSaveReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (entry: unknown, max: number) => typeof entry === "string" && entry.trim().length > 0 &&
    entry.length <= max && !/[\u0000-\u001f\u007f]/u.test(entry);
  if (Object.keys(row).sort().join(",") !== "checks,connectionId,displayName,draftVersion,modelId,publication,saved" ||
    !text(row.connectionId, 256) || !text(row.modelId, 256) || !text(row.displayName, 160) ||
    !Number.isSafeInteger(row.draftVersion) || Number(row.draftVersion) < 1 || Number(row.draftVersion) > 2_147_483_647 ||
    typeof row.saved !== "string" || !["name", "configuration"].includes(row.saved) ||
    typeof row.publication !== "string" || !["not_requested", "draft", "active"].includes(row.publication) ||
    typeof row.checks !== "string" || !["not_requested", "unknown", "checked", "failed", "skipped"].includes(row.checks) ||
    (row.saved === "name" ? row.publication !== "not_requested" || row.checks !== "not_requested"
      : row.publication === "not_requested" || row.publication === "draft" && row.checks !== "not_requested")) return null;
  return row as AdminProviderModelSaveReceipt;
}

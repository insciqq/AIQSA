import { decodeAdminModelPricing, type AdminModelPricing } from "./adminProviderModelPrices";
import { decodeAdminProviderAssignedRoles, type AdminProviderAssignedRole } from "./adminProviderRoleRouting";

/** Acknowledges this request's successful write, independently of activation/checks. */
export type AdminProviderModelSaveReceipt = Readonly<{
  connectionId: string;
  modelId: string;
  displayName: string;
  draftVersion: number;
  saved: "name" | "metadata" | "configuration";
  pricing?: AdminModelPricing;
  publication: "not_requested" | "draft" | "active";
  checks: "not_requested" | "unknown" | "checked" | "failed" | "skipped";
  /** Installation roles paused until this live model passes a check. */
  affectedRoles?: readonly AdminProviderAssignedRole[];
}>;

export function decodeAdminProviderModelSaveReceipt(value: unknown): AdminProviderModelSaveReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (entry: unknown, max: number) => typeof entry === "string" && entry.trim().length > 0 &&
    entry.length <= max && !/[\u0000-\u001f\u007f]/u.test(entry);
  if (Object.keys(row).filter(key => key !== "pricing" && key !== "affectedRoles").sort().join(",") !== "checks,connectionId,displayName,draftVersion,modelId,publication,saved" ||
    (row.affectedRoles !== undefined && (row.checks !== "failed" || !decodeAdminProviderAssignedRoles(row.affectedRoles)?.length)) ||
    !text(row.connectionId, 256) || !text(row.modelId, 256) || !text(row.displayName, 160) ||
    !Number.isSafeInteger(row.draftVersion) || Number(row.draftVersion) < 1 || Number(row.draftVersion) > 2_147_483_647 ||
    typeof row.saved !== "string" || !["name", "metadata", "configuration"].includes(row.saved) ||
    (row.saved === "name" && row.pricing !== undefined) ||
    (row.pricing !== undefined && !decodeAdminModelPricing(row.pricing)) ||
    (row.saved === "metadata" && !decodeAdminModelPricing(row.pricing)) ||
    typeof row.publication !== "string" || !["not_requested", "draft", "active"].includes(row.publication) ||
    typeof row.checks !== "string" || !["not_requested", "unknown", "checked", "failed", "skipped"].includes(row.checks) ||
    (row.saved !== "configuration" ? row.publication !== "not_requested" || row.checks !== "not_requested"
      : row.publication === "not_requested" || row.publication === "draft" && row.checks !== "not_requested")) return null;
  return { ...row, ...(row.pricing === undefined ? {} : { pricing: decodeAdminModelPricing(row.pricing)! }) } as AdminProviderModelSaveReceipt;
}

import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";

/** Called only under the active-tuple CAS. A role probe cannot revoke the
 * ordinary answer check or another capability on that same exact tuple. */
export function mergeSystemRoleEvidence(
  previous: unknown, next: AdminProviderTestEvidence, role: SystemModelVerificationRole
): AdminProviderTestEvidence {
  if (role === "embedding" || role === "reranker") return next;
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
    throw new Error("system_role_evidence_missing");
  }
  const current = previous as AdminProviderTestEvidence;
  if (!current.compatibility || !next.compatibility || current.upstreamModelId !== next.upstreamModelId ||
    JSON.stringify(current.selectedProviders) !== JSON.stringify(next.selectedProviders)) {
    throw new Error("system_role_evidence_stale");
  }
  const result = { ...current, compatibility: { ...current.compatibility } };
  const pairs = role === "memory"
    ? [["structuredOutput", "structuredOutput"], ["forcedToolCall", "forcedToolCall"]] as const
    : role === "direct_pdf" ? [["pdfInput", "directPdf"]] as const : [["visionInput", "vision"]] as const;
  for (const [field, capability] of pairs) {
    delete result[field];
    if (next[field]) Object.assign(result, { [field]: next[field] });
    result.compatibility[capability] = next.compatibility[capability] ?? "not_supported";
  }
  return result;
}

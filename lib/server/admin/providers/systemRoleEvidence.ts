import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import { decodeForcedToolCallVerificationEvidence } from "../../providers/forcedToolCallEvidence";
import { decodePdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import { decodeStructuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { decodeVisionInputVerificationEvidence } from "../../providers/visionInputEvidence";
import { unsupportedAdminProviderCompatibilityEvidence } from "./compatibilityEvidence";

/** Called only under the active-tuple CAS. A role probe cannot revoke the
 * ordinary answer check or another capability on that same exact tuple. */
export function mergeSystemRoleEvidence(
  previous: unknown, next: AdminProviderTestEvidence, role: SystemModelVerificationRole
): AdminProviderTestEvidence {
  if (role === "embedding" || role === "reranker" || role === "image") return next;
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
    throw new Error("system_role_evidence_missing");
  }
  const current = previous as AdminProviderTestEvidence;
  if (!next.compatibility || current.upstreamModelId !== next.upstreamModelId ||
    JSON.stringify(current.selectedProviders) !== JSON.stringify(next.selectedProviders)) {
    throw new Error("system_role_evidence_stale");
  }
  // Quick setup can publish catalog access plus a PDF proof before a full
  // compatibility check. Preserve those proofs when the first role is checked.
  const verified = (proof: { upstreamModelId: string } | null) =>
    proof?.upstreamModelId === current.upstreamModelId ? "verified" as const : "not_supported" as const;
  const compatibility = current.compatibility ?? {
    ...unsupportedAdminProviderCompatibilityEvidence(),
    modelAccess: next.compatibility.modelAccess,
    usage: next.compatibility.usage,
    directPdf: verified(decodePdfInputVerificationEvidence(current.pdfInput)),
    structuredOutput: verified(decodeStructuredOutputVerificationEvidence(current.structuredOutput)),
    forcedToolCall: verified(decodeForcedToolCallVerificationEvidence(current.forcedToolCall)),
    vision: verified(decodeVisionInputVerificationEvidence(current.visionInput))
  };
  const result = { ...current, compatibility: { ...compatibility } };
  const pairs = role === "memory"
    ? [["structuredOutput", "structuredOutput"], ["forcedToolCall", "forcedToolCall"]] as const
    : role === "chat_titles" ? [["structuredOutput", "structuredOutput"]] as const
    : role === "direct_pdf" ? [["pdfInput", "directPdf"]] as const : [["visionInput", "vision"]] as const;
  for (const [field, capability] of pairs) {
    delete result[field];
    if (next[field]) Object.assign(result, { [field]: next[field] });
    result.compatibility[capability] = next.compatibility[capability] ?? "not_supported";
  }
  if (role === "direct_pdf" && result.capabilitySetup) {
    result.capabilitySetup = { ...result.capabilitySetup, checks: { ...result.capabilitySetup.checks,
      directPdf: result.compatibility.directPdf === "verified" ? "verified" : "unsupported" } };
  }
  if (role === "memory" || role === "chat_titles") result.compatibility.probeVersion = next.compatibility.probeVersion;
  return result;
}

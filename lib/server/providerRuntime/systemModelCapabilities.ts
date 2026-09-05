import type { ProviderAdmissionRole } from "./admission";

export type GenerativeSystemModelRole = "memory" | "direct_pdf" | "vision";

/** Admission has already authenticated the exact deployment and credential
 * versions. A role may consume only its independently verified capability. */
export function systemModelRoleEligible(
  role: ProviderAdmissionRole,
  purpose: GenerativeSystemModelRole
): boolean {
  if (purpose === "vision") return role.verifiedVisionInput === true;
  if (purpose === "direct_pdf") return role.snapshot.model.capabilities.nativePdfInput === true;
  return role.verifiedStructuredOutput === true && role.verifiedForcedToolCall === true;
}

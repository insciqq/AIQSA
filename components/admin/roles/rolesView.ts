import type {
  AdminRerankerRouteEntry,
  AdminSystemModelEligibilityRole,
  AdminSystemModelIneligibleCandidate,
  AdminSystemModelIneligibilityReason,
  AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";

export type AdminRolePickerGroup = "check" | "ineligible" | "ready";

export type AdminRolePickerItem = Readonly<{
  group: AdminRolePickerGroup;
  id: string;
  label: string;
  configurationHref?: string;
  /** The missing requirement, including checks that can run from the picker. */
  note?: string;
}>;

export type AdminRoleStatus = "not_assigned" | "unavailable" | "working";

export const ADMIN_ROLE_STATUS_LABEL: Record<AdminRoleStatus, string> = {
  not_assigned: "Not assigned",
  unavailable: "Unavailable",
  working: "Working"
};

export const ADMIN_ROLE_PICKER_FOOTER = "System roles always use the provider's default key";

type Deployment = Readonly<{
  connectionDisplayName: string;
  connectionId: string;
  displayName: string;
}>;

/** "Connection / Model", with duplicate connection names disambiguated. */
export function deploymentLabeller(
  catalog: AdminSystemModelPolicyCatalog | null
): (deployment: Deployment) => string {
  const sources = catalog
    ? [
        ...catalog.candidates,
        ...catalog.titleCandidates,
        ...catalog.documentCandidates,
        ...catalog.verificationCandidates,
        ...catalog.rerankerCandidates,
        ...(catalog.decisionCandidates ?? []),
        ...Object.values(catalog.ineligible).flat(),
        ...(catalog.policy.systemModel ? [catalog.policy.systemModel] : []),
        ...(catalog.memoryPolicy.model ? [catalog.memoryPolicy.model] : []),
        ...(catalog.policy.chatTitleModel ? [catalog.policy.chatTitleModel] : []),
        ...(catalog.policy.chatPdfNativeModel ? [catalog.policy.chatPdfNativeModel] : []),
        ...(catalog.policy.visionModel ? [catalog.policy.visionModel] : []),
        ...(catalog.policy.chatPdfModel ? [catalog.policy.chatPdfModel] : []),
        ...(catalog.policy.rerankerModel ? [catalog.policy.rerankerModel] : []),
        ...(catalog.policy.decisionModel ? [catalog.policy.decisionModel] : []),
        ...(catalog.policy.rerankerRoute?.entries ?? [])
      ].map((item) => ({ id: item.connectionId, name: item.connectionDisplayName }))
    : [];
  const labels = resolveProviderConnectionLabels(sources);
  return (deployment) =>
    `${labels.get(deployment.connectionId) ?? deployment.connectionDisplayName} / ${deployment.displayName}`;
}

export function roleStatus(assignment: Readonly<{ available: boolean }> | null): AdminRoleStatus {
  if (!assignment) return "not_assigned";
  return assignment.available ? "working" : "unavailable";
}

export function ineligibilityNote(
  reason: AdminSystemModelIneligibilityReason,
  role: AdminSystemModelEligibilityRole,
  requirement?: AdminSystemModelIneligibleCandidate["requirement"]
): string {
  const feature = requirement === "structured_output" ? "strict JSON"
    : requirement === "tool_calling" ? "tools"
    : requirement === "forced_tool_call" ? "forced tool calls"
    : requirement === "vision" || role === "vision" ? "image input"
    : requirement === "direct_pdf" || role === "direct_pdf" ? "direct PDF input"
    : "required capability";
  switch (reason) {
    case "adapter_unsupported":
      return `${feature} unsupported on this route`;
    case "capability_disabled":
      return `${feature} disabled in model settings`;
    case "probe_rejected":
      return `${feature} check was rejected`;
    case "model_disabled":
      return "model is disabled";
    case "no_default_credential":
      return "provider has no usable default key";
    case "not_checked":
      return `${feature} verification required`;
  }
}

function ineligibleItems(
  catalog: AdminSystemModelPolicyCatalog,
  role: AdminSystemModelEligibilityRole,
  readyIds: ReadonlySet<string>,
  label: (deployment: Deployment) => string
): AdminRolePickerItem[] {
  return catalog.ineligible[role]
    .filter((item) => !readyIds.has(item.id))
    .map((item): AdminRolePickerItem => ({
      configurationHref: `/admin?section=providers&resource=${encodeURIComponent(item.connectionId)}#provider-model-${encodeURIComponent(item.id)}`,
      group: item.reason === "not_checked" || item.reason === "probe_rejected" ? "check" : "ineligible",
      id: item.id,
      label: label(item),
      note: ineligibilityNote(item.reason, role, item.requirement)
    }));
}

/** Picker items for the independent generative roles. */
export function generativeRoleItems(
  catalog: AdminSystemModelPolicyCatalog,
  role: "chat_titles" | "memory" | "vision" | "direct_pdf"
): AdminRolePickerItem[] {
  const label = deploymentLabeller(catalog);
  const ready = role === "memory"
    ? catalog.candidates
    : role === "chat_titles" ? catalog.titleCandidates
    : catalog.documentCandidates.filter((item) => role === "direct_pdf" ? item.pdfInput === "verified" : item.visionInput === "verified");
  const readyIds = new Set(ready.map((item) => item.id));
  return [
    ...ready.map((item): AdminRolePickerItem => ({ group: "ready", id: item.id, label: label(item) })),
    ...ineligibleItems(catalog, role, readyIds, label)
  ];
}

export function rerankerItems(catalog: AdminSystemModelPolicyCatalog): AdminRolePickerItem[] {
  const label = deploymentLabeller(catalog);
  return catalog.rerankerCandidates.map((item) => ({ group: "ready", id: item.id, label: label(item) }));
}

/** Read-only route line under the Reranking picker. */
export function rerankerFallbacksLine(
  catalog: AdminSystemModelPolicyCatalog
): string | null {
  const entries: readonly AdminRerankerRouteEntry[] = catalog.policy.rerankerRoute?.entries ?? [];
  if (!catalog.policy.rerankerModel || entries.length === 0) return null;
  const label = deploymentLabeller(catalog);
  const fallbacks = entries
    .filter((entry) => entry.role === "fallback")
    .map((entry) => `${label(entry)}${entry.available ? "" : " (unavailable)"}`);
  if (fallbacks.length === 0) return "No fallbacks";
  return `Fallbacks: ${fallbacks.join(", then ")}`;
}

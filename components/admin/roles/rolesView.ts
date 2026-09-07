import type {
  AdminKnowledgePdfProcessingMode,
  AdminKnowledgeProfileDestination,
  AdminKnowledgeProfileSettings
} from "@/lib/contracts/adminKnowledge";
import type {
  AdminRerankerRouteEntry,
  AdminSystemModelEligibilityRole,
  AdminSystemModelIneligibilityReason,
  AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";

export type AdminRolePickerGroup = "check" | "ineligible" | "ready";

export type AdminRolePickerItem = Readonly<{
  group: AdminRolePickerGroup;
  id: string;
  label: string;
  /** Why the deployment is not eligible; only on `ineligible` items. */
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
        ...catalog.documentCandidates,
        ...catalog.verificationCandidates,
        ...catalog.rerankerCandidates,
        ...Object.values(catalog.ineligible).flat(),
        ...(catalog.policy.systemModel ? [catalog.policy.systemModel] : []),
        ...(catalog.policy.chatPdfModel ? [catalog.policy.chatPdfModel] : []),
        ...(catalog.policy.rerankerModel ? [catalog.policy.rerankerModel] : []),
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
  role: AdminSystemModelEligibilityRole
): string {
  switch (reason) {
    case "adapter_unsupported":
      return role === "memory"
        ? "no strict JSON on this route"
        : role === "vision"
          ? "no image input on this route"
          : "no direct PDF input on this route";
    case "model_disabled":
      return "model is disabled";
    case "no_default_credential":
      return "provider has no default key";
    case "not_checked":
      return "not checked yet";
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
    .map((item) => item.reason === "not_checked"
      ? { group: "check", id: item.id, label: label(item) }
      : { group: "ineligible", id: item.id, label: label(item), note: ineligibilityNote(item.reason, role) });
}

/** Picker items for the Memory & structured helpers or Chat PDF role. */
export function generativeRoleItems(
  catalog: AdminSystemModelPolicyCatalog,
  role: "memory" | "vision"
): AdminRolePickerItem[] {
  const label = deploymentLabeller(catalog);
  const ready = role === "memory"
    ? catalog.candidates
    : catalog.documentCandidates.filter((item) => item.visionInput === "verified");
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

export type KnowledgeModelMode = Exclude<AdminKnowledgePdfProcessingMode, "local">;

export const KNOWLEDGE_MODE_LABEL: Record<AdminKnowledgePdfProcessingMode, string> = {
  local: "Local · no model",
  system_model_direct_pdf: "A model reads the PDF directly",
  system_model_vision: "A model reads page images"
};

type PdfDestination = AdminKnowledgeProfileSettings["availablePdfDestinations"][number];

export function knowledgeDocumentDestinations(
  destinations: readonly PdfDestination[],
  mode: KnowledgeModelMode
): PdfDestination[] {
  return destinations.filter((item) => mode === "system_model_vision" ? item.vision : item.directPdf);
}

export function knowledgeDestinationLabel(
  destination: Readonly<{ connectionDisplayName: string; modelDisplayName: string }>
): string {
  return `${destination.connectionDisplayName} / ${destination.modelDisplayName}`;
}

export function embeddingDestinationLabel(destination: AdminKnowledgeProfileDestination): string {
  return `${knowledgeDestinationLabel(destination)} · ${destination.targetDimension}d`;
}

/**
 * Documents picker: ready destinations come from the Knowledge profile, the
 * `Check first` and `Not eligible` groups from the role catalog, which shares
 * the deployment id space.
 */
export function knowledgeDocumentItems(
  destinations: readonly PdfDestination[],
  mode: KnowledgeModelMode,
  catalog: AdminSystemModelPolicyCatalog | null
): AdminRolePickerItem[] {
  const ready = knowledgeDocumentDestinations(destinations, mode).map((item): AdminRolePickerItem => ({
    group: "ready",
    id: item.deploymentId,
    label: knowledgeDestinationLabel(item)
  }));
  if (!catalog) return ready;
  const readyIds = new Set(ready.map((item) => item.id));
  const role = mode === "system_model_vision" ? "vision" : "direct_pdf";
  return [...ready, ...ineligibleItems(catalog, role, readyIds, deploymentLabeller(catalog))];
}

export function embeddingItems(
  destinations: readonly AdminKnowledgeProfileDestination[]
): AdminRolePickerItem[] {
  return destinations.map((item) => ({
    group: "ready",
    id: item.deploymentId,
    label: embeddingDestinationLabel(item)
  }));
}

export type KnowledgeProcessingState = Readonly<{
  label: string;
  status: AdminRoleStatus | "reindexing";
}>;

/** The one-line state of the Knowledge processing group row. */
export function knowledgeProcessingState(
  profile: AdminKnowledgeProfileSettings
): KnowledgeProcessingState {
  const building = profile.migration.buildingProfileBases;
  if (profile.activeRevision && building > 0) {
    const total = profile.migration.totalBases;
    return { label: `Reindexing ${building} of ${total} ${total === 1 ? "base" : "bases"}`, status: "reindexing" };
  }
  if (!profile.activeRevision || profile.health.state === "not_configured") {
    return { label: "Not assigned", status: "not_assigned" };
  }
  if (profile.health.state === "unavailable") return { label: "Unavailable", status: "unavailable" };
  return { label: "Ready", status: "working" };
}

/** Summary for the Knowledge & Memory page and the group row subtitle. */
export function knowledgeProcessingSummary(profile: AdminKnowledgeProfileSettings): string {
  const active = profile.activeRevision;
  if (!active) return "Documents: not set · Embeddings: not set";
  const documents = active.pdfProcessing.destination
    ? `${KNOWLEDGE_MODE_LABEL[active.pdfProcessing.mode]} · ${knowledgeDestinationLabel(active.pdfProcessing.destination)}`
    : KNOWLEDGE_MODE_LABEL.local;
  return `Documents: ${documents} · Embeddings: ${embeddingDestinationLabel(active.destination)}`;
}

/** Disclosure carried by the Apply / Restore confirmation dialog. */
export function knowledgeReindexDisclosure(mode: AdminKnowledgePdfProcessingMode): string {
  const egress = mode === "system_model_vision"
    ? " Rendered page images and native page text leave this installation."
    : mode === "system_model_direct_pdf"
      ? " Original PDF page ranges leave this installation."
      : "";
  return "Changing document processing reprocesses every document; changing embeddings reindexes Knowledge. " +
    "Existing indexes stay online until their replacements are ready." + egress +
    " Applying authorizes the disclosed processing, external requests, and reindexing.";
}

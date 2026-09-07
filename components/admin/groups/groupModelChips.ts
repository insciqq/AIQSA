import type {
  AdminProviderActiveCheck,
  AdminProviderConnection,
  AdminProviderModelConfiguration,
  AdminProviderTestEvidence
} from "@/lib/contracts/adminProviders";

/**
 * The small capability chips beside a model on the Group page (PRD 3.3):
 * Tools · JSON · PDF · Images, shown only for what the provider catalog has
 * verified for that exact model, adapter and key. Nothing is shown for an
 * unchecked or unsupported capability; the provider page owns the details.
 */
export type AdminGroupModelChip = "Images" | "JSON" | "PDF" | "Tools";

const CHIP_ORDER: readonly AdminGroupModelChip[] = ["Tools", "JSON", "PDF", "Images"];

function matchesModel(
  evidence: { adapterKind: string; upstreamModelId: string; verified: true } | undefined,
  configuration: AdminProviderModelConfiguration
): boolean {
  return evidence?.verified === true &&
    evidence.adapterKind === configuration.adapterKind &&
    evidence.upstreamModelId === configuration.upstreamModelId;
}

function verifiedChips(
  evidence: AdminProviderTestEvidence,
  configuration: AdminProviderModelConfiguration
): Set<AdminGroupModelChip> {
  const chips = new Set<AdminGroupModelChip>();
  const compatibility = evidence.compatibility;
  if (configuration.capabilities.toolCalling === true &&
    (compatibility?.forcedToolCall === "verified" || matchesModel(evidence.forcedToolCall, configuration))) {
    chips.add("Tools");
  }
  if (compatibility?.structuredOutput === "verified" || matchesModel(evidence.structuredOutput, configuration)) {
    chips.add("JSON");
  }
  if (compatibility?.directPdf === "verified" || matchesModel(evidence.pdfInput, configuration)) {
    chips.add("PDF");
  }
  if (configuration.capabilities.vision &&
    (compatibility?.vision === "verified" || matchesModel(evidence.visionInput, configuration))) {
    chips.add("Images");
  }
  return chips;
}

/** The check that speaks for this model: the group's key first, then the provider default, then any with evidence. */
function relevantCheck(
  checks: readonly AdminProviderActiveCheck[],
  modelId: string,
  credentialIds: readonly (string | null)[]
): AdminProviderActiveCheck | null {
  const forModel = checks.filter((check) => check.providerModelId === modelId && check.evidence !== null);
  for (const credentialId of credentialIds) {
    if (!credentialId) continue;
    const match = forModel.find((check) => check.credentialId === credentialId);
    if (match) return match;
  }
  return forModel[0] ?? null;
}

export function groupModelChips(input: Readonly<{
  connection: Pick<AdminProviderConnection, "activeChecks" | "defaultCredentialId" | "models"> | null;
  /** The group's key override on this provider, when one is assigned. */
  credentialId: string | null;
  modelId: string;
}>): AdminGroupModelChip[] {
  const configuration = input.connection?.models.find((model) => model.id === input.modelId)?.activeConfig ?? null;
  if (!input.connection || !configuration) return [];
  const check = relevantCheck(
    input.connection.activeChecks,
    input.modelId,
    [input.credentialId, input.connection.defaultCredentialId]
  );
  if (!check?.evidence || check.status !== "available") return [];
  const chips = verifiedChips(check.evidence, configuration);
  return CHIP_ORDER.filter((chip) => chips.has(chip));
}

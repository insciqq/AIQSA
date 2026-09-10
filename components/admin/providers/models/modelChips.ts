import type {
  AdminProviderActiveCheck,
  AdminProviderCheckRun,
  AdminProviderCompatibilityStatus,
  AdminProviderConnection,
  AdminProviderModelClass,
  AdminProviderModelConfiguration,
  AdminProviderTestEvidence
} from "@/lib/contracts/adminProviders";

/**
 * `Works with` chips (PRD 5.4): what the last check of the active model with
 * the default key found. A chip exists only where there is a result; a
 * result of `not_supported` is a muted dashed chip (yellow `No PDF` for PDF),
 * and PDF, images, tools, JSON and streaming come only from answer models.
 */

export type ModelChipTone = "muted" | "ok" | "warn";

export type ModelChipKey =
  | "imageGeneration"
  | "imageEditing"
  | "embeddings"
  | "images"
  | "json"
  | "pdf"
  | "reranking"
  | "stream"
  | "tools"
  | "unavailable";

export type ModelChip = Readonly<{
  key: ModelChipKey;
  label: string;
  tone: ModelChipTone;
}>;

export type ModelWorksWith =
  | Readonly<{ chips: readonly ModelChip[]; kind: "checked"; usageMissing: boolean }>
  | Readonly<{ chips: readonly ModelChip[]; kind: "failed"; usageMissing: boolean }>
  | Readonly<{ kind: "checking"; label: string }>
  | Readonly<{ kind: "not_checked" }>;

function chip(key: ModelChipKey, label: string, status: AdminProviderCompatibilityStatus | null | undefined): ModelChip | null {
  if (status === "verified") return { key, label, tone: "ok" };
  if (status === "not_supported") {
    return key === "pdf" ? { key, label: "No PDF", tone: "warn" } : { key, label, tone: "muted" };
  }
  return null;
}

type ChipConfiguration = Pick<AdminProviderModelConfiguration, "adapterKind" | "modelClass" | "upstreamModelId">;

function legacyStatus(
  block: { adapterKind: string; upstreamModelId: string; verified: true } | undefined,
  configuration: ChipConfiguration
): AdminProviderCompatibilityStatus | null {
  return block?.verified && block.adapterKind === configuration.adapterKind &&
    block.upstreamModelId === configuration.upstreamModelId ? "verified" : null;
}

/** The evidence of a check only counts for the upstream id it was made for. */
export function matchingEvidence(
  check: AdminProviderActiveCheck | null,
  configuration: Pick<AdminProviderModelConfiguration, "upstreamModelId">
): AdminProviderTestEvidence | null {
  const evidence = check?.evidence ?? null;
  return evidence && evidence.upstreamModelId === configuration.upstreamModelId ? evidence : null;
}

export function modelChipsFromEvidence(
  configuration: ChipConfiguration,
  check: AdminProviderActiveCheck | null
): readonly ModelChip[] {
  const evidence = matchingEvidence(check, configuration);
  if (!evidence || !check) return [];
  if (check.status === "unavailable") {
    return [{ key: "unavailable", label: "Not available", tone: "warn" }];
  }
  if (configuration.modelClass === "embedding") {
    return evidence.embedding ? [{ key: "embeddings", label: "Embeddings", tone: "ok" }] : [];
  }
  if (configuration.modelClass === "reranker") {
    return evidence.reranking ? [{ key: "reranking", label: "Reranking", tone: "ok" }] : [];
  }
  if (configuration.modelClass === "image") {
    return (["imageGeneration", "imageEditing"] as const).map((key) => {
      const status = evidence.capabilitySetup?.checks[key];
      const label = key === "imageGeneration" ? "Generate images" : "Edit images";
      return { key, label: status === "incomplete" ? `${label}: check incomplete` : label,
        tone: legacyStatus(evidence[key], configuration) === "verified" ? "ok" as const : status === "incomplete" ? "warn" as const : "muted" as const };
    });
  }
  const compatibility = evidence.compatibility;
  // Earlier OpenRouter checks used a forced tool call for JSON. Neither a
  // pass nor a rejection of that transport proves native JSON Schema support.
  const nativeJsonChecked = configuration.adapterKind !== "openrouter_chat_completions" ||
    compatibility?.probeVersion === 2 || evidence.structuredOutput?.probeVersion === 5;
  const pdfCheck = evidence.capabilitySetup?.checks.directPdf;
  const pdfChip = pdfCheck === "incomplete" || pdfCheck === "not_checked"
    ? { key: "pdf" as const, label: "PDF check incomplete", tone: "warn" as const }
    : chip("pdf", "PDF", compatibility?.directPdf);
  const chips = compatibility
    ? [
        chip("tools", "Tools", compatibility.toolCalling),
        chip("json", "JSON", nativeJsonChecked ? compatibility.structuredOutput : null),
        pdfChip,
        chip("images", "Images", compatibility.vision),
        chip("stream", "Stream", compatibility.streaming)
      ]
    : [
        chip("json", "JSON", nativeJsonChecked ? legacyStatus(evidence.structuredOutput, configuration) : null),
        chip("pdf", "PDF", legacyStatus(evidence.pdfInput, configuration)),
        chip("images", "Images", legacyStatus(evidence.visionInput, configuration))
      ];
  return chips.filter((entry): entry is ModelChip => entry !== null);
}

/** Compact verified capabilities use the same evidence semantics on the group page. */
export function modelCapabilityLabels(input: Readonly<{
  connection: Pick<AdminProviderConnection, "activeChecks" | "activeVersion" | "credentials" | "defaultCredentialId" | "models"> | null;
  credentialId: string | null;
  modelId: string;
}>): string[] {
  const connection = input.connection;
  const model = connection?.models.find(({ id }) => id === input.modelId);
  const configuration = model?.activeConfig;
  const credentialId = input.credentialId ?? connection?.defaultCredentialId;
  const credential = connection?.credentials.find(({ id }) => id === credentialId);
  if (!connection || !model || !configuration || !credential?.enabled || !credential.activeVersion ||
    credential.activeVersion.revokedAt) return [];
  const check = connection.activeChecks.find((entry) => entry.providerModelId === input.modelId &&
    entry.credentialId === credentialId && entry.connectionVersion === connection.activeVersion &&
    entry.modelVersion === model.activeVersion && entry.credentialVersionId === credential.activeVersion?.id);
  if (!check || check.status !== "available") return [];
  return modelChipsFromEvidence(configuration, check).filter(({ tone }) => tone === "ok").map(({ label }) => label);
}

/** Whether the last check saw no provider usage report (a Details warning, not a chip). */
export function modelUsageMissing(
  configuration: Pick<AdminProviderModelConfiguration, "upstreamModelId">,
  check: AdminProviderActiveCheck | null
): boolean {
  const evidence = matchingEvidence(check, configuration);
  return evidence?.compatibility?.usage === "not_supported";
}

export function checkingLabel(modelClass: AdminProviderModelClass): string {
  if (modelClass === "image") return "Checking image generation and editing…";
  if (modelClass === "embedding") return "Checking embeddings…";
  if (modelClass === "reranker") return "Checking reranking…";
  return "Checking tools, JSON, PDF, images and streaming…";
}

/**
 * The row state: a check in progress wins, then a temporary failure (with
 * the chips it did not erase), then the chips themselves; a check without
 * capability results still reads as not checked.
 */
export function modelWorksWith(input: Readonly<{
  check: AdminProviderActiveCheck | null;
  checkRun: AdminProviderCheckRun | null | undefined;
  configuration: ChipConfiguration;
  defaultCredentialId: string | null;
  modelId: string;
}>): ModelWorksWith {
  const run = input.checkRun ?? null;
  if (run?.state === "running" && run.inFlight.includes(input.modelId)) {
    return { kind: "checking", label: checkingLabel(input.configuration.modelClass) };
  }
  const chips = modelChipsFromEvidence(input.configuration, input.check);
  const usageMissing = modelUsageMissing(input.configuration, input.check);
  const failed = input.check?.latestRefreshError !== null && input.check?.latestRefreshError !== undefined ||
    (run !== null && run.credentialId === input.defaultCredentialId && run.failed.includes(input.modelId));
  if (failed) return { chips, kind: "failed", usageMissing };
  if (chips.length === 0) return { kind: "not_checked" };
  return { chips, kind: "checked", usageMissing };
}

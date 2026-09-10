import { capabilityAttemptDescription } from "@/components/admin/providers/add/AdminProviderSetupResults";
import type {
  AdminProviderActiveCheck,
  AdminProviderCapabilityCheck,
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
 * unverified legacy evidence stays distinct from an explicit unsupported receipt,
 * and PDF, images, tools, JSON and streaming come only from answer models.
 */

export type ModelChipTone = "muted" | "ok" | "warn" | "critical";

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
  help?: string;
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
    return { key, label: `${label}: not verified`, tone: "muted" };
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
    return [{ key: "unavailable", label: "Not available", tone: "critical" }];
  }
  if (configuration.modelClass === "embedding") {
    return evidence.embedding ? [{ key: "embeddings", label: "Embeddings", tone: "ok" }] : [];
  }
  if (configuration.modelClass === "reranker") {
    return evidence.reranking ? [{ key: "reranking", label: "Reranking", tone: "ok" }] : [];
  }
  const capabilityChip = (key: ModelChipKey, label: string, capability: AdminProviderCapabilityCheck,
    status: AdminProviderCompatibilityStatus | null | undefined): ModelChip | null => {
    const receipt = evidence.capabilitySetup?.checks[capability];
    const attempt = evidence.capabilitySetup?.attempts?.[capability];
    const detail = capabilityAttemptDescription(attempt);
    if (status === "verified") return { key, label, tone: "ok",
      ...(attempt?.status === "incomplete" ? { help: `Previously verified. Latest check inconclusive: ${detail}.` } : {}) };
    if (receipt === "unsupported") return { key, label: `${label}: unsupported`, tone: "critical", help: detail || "Unsupported on this route." };
    if (receipt === "incomplete" || receipt === "rejected") return { key, label: `${label}: inconclusive`, tone: "critical", help: detail || "This check did not prove the capability." };
    if (receipt === "not_checked") return { key, label: `${label}: not checked`, tone: "muted" };
    return chip(key, label, status);
  };
  if (configuration.modelClass === "image") {
    return (["imageGeneration", "imageEditing"] as const).flatMap((key) => {
      const result = capabilityChip(key, key === "imageGeneration" ? "Generate images" : "Edit images", key, legacyStatus(evidence[key], configuration));
      return result ? [result] : [];
    });
  }
  const compatibility = evidence.compatibility;
  // Earlier OpenRouter checks used a forced tool call for JSON. Neither a
  // pass nor a rejection of that transport proves native JSON Schema support.
  const nativeJsonChecked = configuration.adapterKind !== "openrouter_chat_completions" ||
    compatibility?.probeVersion === 2 || evidence.structuredOutput?.probeVersion === 5;
  const chips = compatibility
    ? [
        capabilityChip("tools", "Tools", "toolCalling", compatibility.toolCalling),
        capabilityChip("json", "JSON", "structuredOutput", nativeJsonChecked ? compatibility.structuredOutput : null),
        capabilityChip("pdf", "PDF", "directPdf", compatibility.directPdf),
        capabilityChip("images", "Images", "vision", compatibility.vision),
        capabilityChip("stream", "Stream", "streaming", compatibility.streaming)
      ]
    : [
        capabilityChip("json", "JSON", "structuredOutput", nativeJsonChecked ? legacyStatus(evidence.structuredOutput, configuration) : null),
        capabilityChip("pdf", "PDF", "directPdf", legacyStatus(evidence.pdfInput, configuration)),
        capabilityChip("images", "Images", "vision", legacyStatus(evidence.visionInput, configuration))
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
  const failedAttempt = Object.values(matchingEvidence(input.check, input.configuration)?.capabilitySetup?.attempts ?? {}).some((attempt) => attempt.status === "incomplete");
  const failed = failedAttempt || input.check?.latestRefreshError !== null && input.check?.latestRefreshError !== undefined ||
    (run !== null && run.credentialId === input.defaultCredentialId && run.failed.includes(input.modelId));
  if (failed) return { chips, kind: "failed", usageMissing };
  if (chips.length === 0) return { kind: "not_checked" };
  return { chips, kind: "checked", usageMissing };
}

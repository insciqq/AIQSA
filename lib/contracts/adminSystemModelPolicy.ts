import type { AdminModelDefaultCandidate } from "./adminModelPolicy";
import { normalizeImageModelConfiguration, normalizeImageGenerationParameters, type ImageModelConfiguration, type ImageGenerationParameters } from "./imageGeneration";

export type SystemModelVerificationRole = "memory" | "direct_pdf" | "vision" | "embedding" | "reranker" | "image";

export type AdminImageModelCandidate = AdminModelDefaultCandidate & {
  upstreamModelId: string;
  image: ImageModelConfiguration;
  defaultParameters: ImageGenerationParameters;
  generation: boolean;
  editing: boolean;
};

export type AdminSystemModelCandidate = AdminModelDefaultCandidate & {
  pdfInput?: "not_requested" | "not_verified" | "unsupported" | "verified";
  visionInput?: "not_verified" | "verified";
  defaultReasoningEffort: string | null;
  forcedToolCall: "not_verified" | "unsupported" | "verified";
  reasoningEfforts: string[];
  structuredOutput: "not_verified" | "unsupported" | "verified";
};

export type AdminRerankerModelCandidate = AdminModelDefaultCandidate;

/** Configuration and missing/rejected proof are separate, actionable states. */
export type AdminSystemModelIneligibilityReason =
  | "adapter_unsupported"
  | "capability_disabled"
  | "probe_rejected"
  | "model_disabled"
  | "no_default_credential"
  | "not_checked";

export const ADMIN_SYSTEM_MODEL_INELIGIBILITY_REASONS: readonly AdminSystemModelIneligibilityReason[] = [
  "adapter_unsupported",
  "capability_disabled",
  "probe_rejected",
  "model_disabled",
  "no_default_credential",
  "not_checked"
];

export type AdminSystemModelEligibilityRole = "direct_pdf" | "memory" | "vision";

export const ADMIN_SYSTEM_MODEL_ELIGIBILITY_ROLES: readonly AdminSystemModelEligibilityRole[] = [
  "memory",
  "vision",
  "direct_pdf"
];

export type AdminSystemModelIneligibleCandidate = AdminSystemModelCandidate & {
  reason: AdminSystemModelIneligibilityReason;
  requirement?: "structured_output" | "tool_calling" | "forced_tool_call" | "vision" | "direct_pdf";
};

export type AdminRerankerRouteEntry = AdminRerankerModelCandidate & {
  available: boolean;
  position: number;
  relevanceScoreFloor: number | null;
  role: "fallback" | "primary";
};

export type AdminSystemModelPolicyCatalog = {
  candidates: AdminSystemModelCandidate[];
  documentCandidates: AdminSystemModelCandidate[];
  verificationCandidates: AdminSystemModelCandidate[];
  /** Every answer deployment that is not ready for the role, with the reason. */
  ineligible: Record<AdminSystemModelEligibilityRole, AdminSystemModelIneligibleCandidate[]>;
  rerankerCandidates: AdminRerankerModelCandidate[];
  imageCandidates?: AdminImageModelCandidate[];
  policy: {
    imageModel?: (AdminImageModelCandidate & { available: boolean }) | null;
    imageParameters?: ImageGenerationParameters;
    chatPdfModel: (AdminSystemModelCandidate & { available: boolean }) | null;
    chatPdfReasoningEffort: string | null;
    rerankerModel: (AdminRerankerModelCandidate & { available: boolean }) | null;
    rerankerRoute?: {
      entries: AdminRerankerRouteEntry[];
      policyVersion: "openrouter-reranker-route-v1";
    };
    reasoningEffort: string | null;
    systemModel: (AdminSystemModelCandidate & { available: boolean }) | null;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  };
};

export type AdminSystemModelPolicyResponse = {
  systemModelPolicy: AdminSystemModelPolicyCatalog;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function baseCandidate(value: unknown): boolean {
  return record(value) && boundedText(value.connectionDisplayName, 160) &&
    boundedText(value.connectionId, 256) && boundedText(value.displayName, 160) &&
    boundedText(value.id, 256);
}

function candidate(value: unknown): value is AdminSystemModelCandidate {
  if (!record(value) || !baseCandidate(value) ||
    (value.pdfInput !== undefined && !["not_requested", "not_verified", "unsupported", "verified"].includes(String(value.pdfInput))) ||
    (value.visionInput !== undefined && value.visionInput !== "verified" &&
      value.visionInput !== "not_verified") ||
    !Array.isArray(value.reasoningEfforts) ||
    value.reasoningEfforts.length > 16 ||
    !value.reasoningEfforts.every((effort) => boundedText(effort, 32)) ||
    new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length ||
    (value.forcedToolCall !== "verified" &&
      value.forcedToolCall !== "not_verified" &&
      value.forcedToolCall !== "unsupported") ||
    (value.structuredOutput !== "verified" &&
      value.structuredOutput !== "not_verified" &&
      value.structuredOutput !== "unsupported")) return false;
  return value.defaultReasoningEffort === null ||
    boundedText(value.defaultReasoningEffort, 32) &&
    value.reasoningEfforts.includes(value.defaultReasoningEffort);
}

function imageCandidate(value: unknown): value is AdminImageModelCandidate {
  if (!record(value) || !baseCandidate(value) || !boundedText(value.upstreamModelId, 256) ||
    typeof value.generation !== "boolean" || typeof value.editing !== "boolean") return false;
  try {
    const image = normalizeImageModelConfiguration(value.image);
    normalizeImageGenerationParameters(value.defaultParameters, image, value.upstreamModelId);
    return true;
  } catch { return false; }
}

function ineligibleCandidate(value: unknown): value is AdminSystemModelIneligibleCandidate {
  return candidate(value) &&
    ((value as Record<string, unknown>).requirement === undefined ||
      ["structured_output", "tool_calling", "forced_tool_call", "vision", "direct_pdf"].includes(String((value as Record<string, unknown>).requirement))) &&
    ADMIN_SYSTEM_MODEL_INELIGIBILITY_REASONS.includes(
      (value as Record<string, unknown>).reason as AdminSystemModelIneligibilityReason
    );
}

function decodeIneligible(
  value: unknown
): AdminSystemModelPolicyCatalog["ineligible"] | null {
  const empty: AdminSystemModelPolicyCatalog["ineligible"] = { direct_pdf: [], memory: [], vision: [] };
  if (value === undefined) return empty;
  if (!record(value)) return null;
  for (const role of ADMIN_SYSTEM_MODEL_ELIGIBILITY_ROLES) {
    const entries = value[role];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || !entries.every(ineligibleCandidate)) return null;
    empty[role] = entries;
  }
  return empty;
}

export function decodeAdminSystemModelPolicyResponse(
  value: unknown
): AdminSystemModelPolicyResponse | null {
  if (!record(value) || !record(value.systemModelPolicy)) return null;
  const catalog = value.systemModelPolicy;
  const ineligible = decodeIneligible(catalog.ineligible);
  if (!ineligible) return null;
  if (!Array.isArray(catalog.candidates) || !catalog.candidates.every((value) =>
      candidate(value) && value.structuredOutput === "verified" && value.forcedToolCall === "verified") ||
    !Array.isArray(catalog.documentCandidates) || !catalog.documentCandidates.every((value) =>
      candidate(value) && (value.pdfInput === "verified" || value.visionInput === "verified")) ||
    !Array.isArray(catalog.verificationCandidates) || !catalog.verificationCandidates.every(candidate) ||
    !Array.isArray(catalog.rerankerCandidates) ||
    !catalog.rerankerCandidates.every(baseCandidate) ||
    !record(catalog.policy)) return null;
  const policy = catalog.policy;
  if (catalog.imageCandidates !== undefined && (!Array.isArray(catalog.imageCandidates) || !catalog.imageCandidates.every(imageCandidate)) ||
    policy.imageModel !== undefined && policy.imageModel !== null && (!imageCandidate(policy.imageModel) || typeof (policy.imageModel as Record<string, unknown>).available !== "boolean")) return null;
  if (policy.imageParameters !== undefined) {
    if (!record(policy.imageParameters)) return null;
    if (policy.imageModel && imageCandidate(policy.imageModel)) {
      try { normalizeImageGenerationParameters(policy.imageParameters, policy.imageModel.image, policy.imageModel.upstreamModelId); } catch { return null; }
    } else if (Object.keys(policy.imageParameters).length) return null;
  }
  const reasoningEffort = policy.reasoningEffort;
  const systemModel = policy.systemModel;
  const rerankerModel = policy.rerankerModel;
  const rerankerRoute = policy.rerankerRoute;
  const updatedBy = policy.updatedBy;
  if ((policy.chatPdfModel !== null && (!record(policy.chatPdfModel) ||
      typeof policy.chatPdfModel.available !== "boolean" || !candidate(policy.chatPdfModel))) ||
    !(policy.chatPdfReasoningEffort === null || boundedText(policy.chatPdfReasoningEffort, 32)) ||
    (policy.chatPdfModel === null && policy.chatPdfReasoningEffort !== null) ||
    (systemModel !== null && (!record(systemModel) || !candidate(systemModel) ||
      typeof (systemModel as Record<string, unknown>).available !== "boolean")) ||
    (rerankerModel !== null && (!record(rerankerModel) || !baseCandidate(rerankerModel) ||
      typeof (rerankerModel as Record<string, unknown>).available !== "boolean")) ||
    (rerankerRoute !== undefined && (!record(rerankerRoute) ||
      rerankerRoute.policyVersion !== "openrouter-reranker-route-v1" ||
      !Array.isArray(rerankerRoute.entries) ||
      rerankerRoute.entries.length > 3 ||
      !rerankerRoute.entries.every((entry, index) =>
        record(entry) && baseCandidate(entry) &&
        typeof entry.available === "boolean" &&
        entry.position === index &&
        entry.role === (index === 0 ? "primary" : "fallback") &&
        (entry.relevanceScoreFloor === null ||
          typeof entry.relevanceScoreFloor === "number" &&
          Number.isFinite(entry.relevanceScoreFloor) &&
          entry.relevanceScoreFloor >= 0 && entry.relevanceScoreFloor <= 1)))) ||
    (systemModel === null && reasoningEffort !== null) ||
    (updatedBy !== null && (!record(updatedBy) || !boundedText(updatedBy.displayName, 160) ||
      !boundedText(updatedBy.id, 256))) ||
    !(reasoningEffort === null || boundedText(reasoningEffort, 32)) ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !Number.isSafeInteger(policy.version) || Number(policy.version) < 1) return null;

  return {
    systemModelPolicy: {
      candidates: catalog.candidates,
      documentCandidates: catalog.documentCandidates,
      verificationCandidates: catalog.verificationCandidates,
      ineligible,
      rerankerCandidates: catalog.rerankerCandidates,
      imageCandidates: (catalog.imageCandidates ?? []) as AdminImageModelCandidate[],
      policy: {
        imageModel: (policy.imageModel ?? null) as AdminSystemModelPolicyCatalog["policy"]["imageModel"],
        imageParameters: (policy.imageParameters ?? {}) as ImageGenerationParameters,
        chatPdfModel: policy.chatPdfModel as AdminSystemModelPolicyCatalog["policy"]["chatPdfModel"],
        chatPdfReasoningEffort: policy.chatPdfReasoningEffort as string | null,
        reasoningEffort: reasoningEffort as string | null,
        rerankerModel: rerankerModel as
          (AdminRerankerModelCandidate & { available: boolean }) | null,
        ...(rerankerRoute === undefined ? {} : {
          rerankerRoute: rerankerRoute as NonNullable<
            AdminSystemModelPolicyCatalog["policy"]["rerankerRoute"]
          >
        }),
        systemModel: systemModel as
          (AdminSystemModelCandidate & { available: boolean }) | null,
        updatedAt: policy.updatedAt,
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      }
    }
  };
}

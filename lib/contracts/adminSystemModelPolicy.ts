import type { AdminModelDefaultCandidate } from "./adminModelPolicy";

export type SystemModelVerificationRole = "memory" | "direct_pdf" | "vision" | "embedding" | "reranker";

export type AdminSystemModelCandidate = AdminModelDefaultCandidate & {
  pdfInput?: "not_requested" | "not_verified" | "unsupported" | "verified";
  visionInput?: "not_verified" | "verified";
  defaultReasoningEffort: string | null;
  forcedToolCall: "not_verified" | "unsupported" | "verified";
  reasoningEfforts: string[];
  structuredOutput: "not_verified" | "unsupported" | "verified";
};

export type AdminRerankerModelCandidate = AdminModelDefaultCandidate;

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
  rerankerCandidates: AdminRerankerModelCandidate[];
  policy: {
    chatPdfPreparationAllowed: boolean;
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

export function decodeAdminSystemModelPolicyResponse(
  value: unknown
): AdminSystemModelPolicyResponse | null {
  if (!record(value) || !record(value.systemModelPolicy)) return null;
  const catalog = value.systemModelPolicy;
  if (!Array.isArray(catalog.candidates) || !catalog.candidates.every((value) =>
      candidate(value) && value.structuredOutput === "verified" && value.forcedToolCall === "verified") ||
    !Array.isArray(catalog.documentCandidates) || !catalog.documentCandidates.every((value) =>
      candidate(value) && (value.pdfInput === "verified" || value.visionInput === "verified")) ||
    !Array.isArray(catalog.verificationCandidates) || !catalog.verificationCandidates.every(candidate) ||
    !Array.isArray(catalog.rerankerCandidates) ||
    !catalog.rerankerCandidates.every(baseCandidate) ||
    !record(catalog.policy)) return null;
  const policy = catalog.policy;
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
    typeof policy.chatPdfPreparationAllowed !== "boolean" ||
    !(reasoningEffort === null || boundedText(reasoningEffort, 32)) ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !Number.isSafeInteger(policy.version) || Number(policy.version) < 1) return null;

  return {
    systemModelPolicy: {
      candidates: catalog.candidates,
      documentCandidates: catalog.documentCandidates,
      verificationCandidates: catalog.verificationCandidates,
      rerankerCandidates: catalog.rerankerCandidates,
      policy: {
        chatPdfPreparationAllowed: policy.chatPdfPreparationAllowed,
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

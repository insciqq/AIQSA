export type AdminKnowledgeSettings = {
  ingestionLimits: {
    maxChunksPerDocument: number;
    maxFileBytes: number;
    maxNormalizedChars: number;
    maxPages: number;
  };
  policy: {
    candidateLimit: number;
    resultLimit: number;
    scoreThreshold: number;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  };
  retrievalBounds: {
    candidateLimit: { max: number; min: number };
    resultLimit: { max: number; min: number };
    scoreThreshold: { max: number; min: number };
  };
};

export type AdminKnowledgeResponse = {
  knowledge: AdminKnowledgeSettings;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function bounds(value: unknown, integer: boolean): value is { max: number; min: number } {
  return record(value) && typeof value.min === "number" && Number.isFinite(value.min) &&
    typeof value.max === "number" && Number.isFinite(value.max) && value.min <= value.max &&
    (!integer || Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max));
}

export function decodeAdminKnowledgeResponse(value: unknown): AdminKnowledgeResponse | null {
  if (!record(value) || !record(value.knowledge)) return null;
  const knowledge = value.knowledge;
  if (!record(knowledge.ingestionLimits) || !record(knowledge.policy) ||
    !record(knowledge.retrievalBounds)) return null;
  const ingestion = knowledge.ingestionLimits;
  const policy = knowledge.policy;
  const retrieval = knowledge.retrievalBounds;
  const updatedBy = policy.updatedBy;
  if (!positiveInteger(ingestion.maxChunksPerDocument) ||
    !positiveInteger(ingestion.maxFileBytes) ||
    !positiveInteger(ingestion.maxNormalizedChars) ||
    !positiveInteger(ingestion.maxPages) ||
    !positiveInteger(policy.candidateLimit) ||
    !positiveInteger(policy.resultLimit) ||
    typeof policy.scoreThreshold !== "number" || !Number.isFinite(policy.scoreThreshold) ||
    typeof policy.updatedAt !== "string" || !Number.isFinite(Date.parse(policy.updatedAt)) ||
    !positiveInteger(policy.version) ||
    (updatedBy !== null && (!record(updatedBy) || typeof updatedBy.id !== "string" ||
      updatedBy.id.length < 1 || updatedBy.id.length > 256 ||
      typeof updatedBy.displayName !== "string" || updatedBy.displayName.trim().length < 1 ||
      updatedBy.displayName.length > 160)) ||
    !bounds(retrieval.candidateLimit, true) ||
    !bounds(retrieval.resultLimit, true) ||
    !bounds(retrieval.scoreThreshold, false) ||
    policy.candidateLimit < retrieval.candidateLimit.min ||
    policy.candidateLimit > retrieval.candidateLimit.max ||
    policy.resultLimit < retrieval.resultLimit.min ||
    policy.resultLimit > retrieval.resultLimit.max ||
    policy.resultLimit > policy.candidateLimit ||
    policy.scoreThreshold < retrieval.scoreThreshold.min ||
    policy.scoreThreshold > retrieval.scoreThreshold.max) return null;

  return {
    knowledge: {
      ingestionLimits: {
        maxChunksPerDocument: Number(ingestion.maxChunksPerDocument),
        maxFileBytes: Number(ingestion.maxFileBytes),
        maxNormalizedChars: Number(ingestion.maxNormalizedChars),
        maxPages: Number(ingestion.maxPages)
      },
      policy: {
        candidateLimit: Number(policy.candidateLimit),
        resultLimit: Number(policy.resultLimit),
        scoreThreshold: Number(policy.scoreThreshold),
        updatedAt: String(policy.updatedAt),
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      },
      retrievalBounds: {
        candidateLimit: retrieval.candidateLimit as { max: number; min: number },
        resultLimit: retrieval.resultLimit as { max: number; min: number },
        scoreThreshold: retrieval.scoreThreshold as { max: number; min: number }
      }
    }
  };
}

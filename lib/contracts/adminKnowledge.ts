export type AdminKnowledgeProfileDestination = Readonly<{
  connectionDisplayName: string;
  deploymentId: string;
  modelDisplayName: string;
  provider: string;
  targetDimension: number;
}>;

export type AdminKnowledgeVisionDestination = Readonly<{
  connectionDisplayName: string;
  deploymentId: string;
  modelDisplayName: string;
  provider: string;
  supportsNativePdf: boolean;
}>;

export type AdminKnowledgeProfileRevision = Readonly<{
  activatedAt: string;
  destination: AdminKnowledgeProfileDestination;
  executionAuthority: "installation" | "legacy_user";
  id: string;
  revisionNumber: number;
  visionDestination: AdminKnowledgeVisionDestination | null;
}>;

export type AdminKnowledgeProfileSettings = Readonly<{
  activeRevision: AdminKnowledgeProfileRevision | null;
  availableDestinations: AdminKnowledgeProfileDestination[];
  availableVisionDestinations: AdminKnowledgeVisionDestination[];
  egress: Readonly<{
    destination: string | null;
    policyVersion: "knowledge-profile-egress-v1" | "knowledge-profile-egress-v2";
    representations: readonly ["document_text_chunks", "search_queries"];
    visualAnalysis: Readonly<{
      destination: string;
      representations: readonly ["visual_source_bytes", "visual_queries"];
    }> | null;
  }>;
  health: Readonly<{
    checkedAt: string | null;
    code: "knowledge_profile_legacy_authority" | "knowledge_profile_not_configured" |
      "knowledge_profile_unavailable" | "knowledge_profile_visual_unavailable" | null;
    state: "not_configured" | "ready" | "ready_with_warnings" | "unavailable";
  }>;
  migration: Readonly<{
    activeProfileBases: number;
    buildingProfileBases: number;
    legacyGenerations: number;
    profiledGenerations: number;
    totalBases: number;
  }>;
  recentRevisions: AdminKnowledgeProfileRevision[];
  updatedAt: string;
  updatedBy: { displayName: string; id: string } | null;
  version: number;
}>;

export type AdminKnowledgeOperationsAlert = Readonly<{
  code:
    | "knowledge_deletion_backlog"
    | "knowledge_deletion_blocked"
    | "knowledge_ingestion_failures"
    | "knowledge_ingestion_queue_stalled"
    | "knowledge_retrieval_degraded"
    | "knowledge_upload_sessions_expired"
    | "knowledge_v1_reconciliation_incomplete";
  severity: "critical" | "warning";
}>;

export type AdminKnowledgeOperations = Readonly<{
  alerts: AdminKnowledgeOperationsAlert[];
  checkedAt: string;
  deletion: Readonly<{
    blockedJobs: number;
    oldestPendingSeconds: number | null;
    pendingJobs: number;
    pendingObjects: number;
  }>;
  ingestion: Readonly<{
    activeUploads: number;
    expiredUploads: number;
    failedArtifacts: number;
    items24h: number;
    needsAttentionUploads: number;
    oldestQueuedSeconds: number | null;
    p50ReadyLatencyMs24h: number | null;
    p95ReadyLatencyMs24h: number | null;
    pendingArtifacts: number;
    processingArtifacts: number;
    readyArtifacts: number;
    settledUploads24h: number;
    uploadedBytes24h: number;
    warningArtifacts: number;
  }>;
  migration: Readonly<{
    discrepancies: number;
    mappedArtifacts: number;
    mappedDocuments: number;
    mappedVersions: number;
    v1Artifacts: number;
    v1Documents: number;
    v1Versions: number;
  }>;
  retrieval: Readonly<{
    degradedOperations24h: number;
    noAnswerOperations24h: number;
    operations24h: number;
    p50DurationMs24h: number | null;
    p95DurationMs24h: number | null;
    repairedAnswers24h: number;
  }>;
}>;

export type AdminKnowledgeSettings = Readonly<{
  ingestionLimits: {
    maxChunksPerDocument: number;
    maxFileBytes: number;
    maxNormalizedChars: number;
    maxPages: number;
  };
  operations: AdminKnowledgeOperations;
  policy: {
    candidateLimit: number;
    resultLimit: number;
    scoreThreshold: number;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  };
  profile: AdminKnowledgeProfileSettings;
  retrievalBounds: {
    candidateLimit: { max: number; min: number };
    resultLimit: { max: number; min: number };
    scoreThreshold: { max: number; min: number };
  };
}>;

export type AdminKnowledgeResponse = {
  knowledge: AdminKnowledgeSettings;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function bounds(value: unknown, integer: boolean): value is { max: number; min: number } {
  return record(value) && typeof value.min === "number" && Number.isFinite(value.min) &&
    typeof value.max === "number" && Number.isFinite(value.max) && value.min <= value.max &&
    (!integer || Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max));
}

function safeString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeDestination(value: unknown): AdminKnowledgeProfileDestination | null {
  if (!record(value) || !safeString(value.connectionDisplayName) ||
    !safeString(value.deploymentId) || !safeString(value.modelDisplayName) ||
    !safeString(value.provider) || !positiveInteger(value.targetDimension)) return null;
  return {
    connectionDisplayName: value.connectionDisplayName,
    deploymentId: value.deploymentId,
    modelDisplayName: value.modelDisplayName,
    provider: value.provider,
    targetDimension: value.targetDimension
  };
}

function decodeVisionDestination(value: unknown): AdminKnowledgeVisionDestination | null {
  if (!record(value) || !safeString(value.connectionDisplayName) ||
    !safeString(value.deploymentId) || !safeString(value.modelDisplayName) ||
    !safeString(value.provider) || typeof value.supportsNativePdf !== "boolean") return null;
  return {
    connectionDisplayName: value.connectionDisplayName,
    deploymentId: value.deploymentId,
    modelDisplayName: value.modelDisplayName,
    provider: value.provider,
    supportsNativePdf: value.supportsNativePdf
  };
}

function decodeRevision(value: unknown): AdminKnowledgeProfileRevision | null {
  if (!record(value) || !isoDate(value.activatedAt) || !safeString(value.id) ||
    !positiveInteger(value.revisionNumber) ||
    value.executionAuthority !== "installation" && value.executionAuthority !== "legacy_user") {
    return null;
  }
  const destination = decodeDestination(value.destination);
  const visionDestination = value.visionDestination === null
    ? null
    : decodeVisionDestination(value.visionDestination);
  if (value.visionDestination !== null && !visionDestination) return null;
  return destination ? {
    activatedAt: value.activatedAt,
    destination,
    executionAuthority: value.executionAuthority,
    id: value.id,
    revisionNumber: value.revisionNumber,
    visionDestination
  } : null;
}

function decodeProfile(value: unknown): AdminKnowledgeProfileSettings | null {
  if (!record(value) || !Array.isArray(value.availableDestinations) ||
    !Array.isArray(value.availableVisionDestinations) ||
    !record(value.egress) || !record(value.health) || !record(value.migration) ||
    !Array.isArray(value.recentRevisions) || !isoDate(value.updatedAt) ||
    !positiveInteger(value.version)) return null;
  const activeRevision = value.activeRevision === null ? null : decodeRevision(value.activeRevision);
  const availableDestinations = value.availableDestinations.map(decodeDestination);
  const availableVisionDestinations = value.availableVisionDestinations.map(decodeVisionDestination);
  const recentRevisions = value.recentRevisions.map(decodeRevision);
  const updatedBy = value.updatedBy;
  const healthStates = new Set(["not_configured", "ready", "ready_with_warnings", "unavailable"]);
  const healthCodes = new Set([
    "knowledge_profile_legacy_authority",
    "knowledge_profile_not_configured",
    "knowledge_profile_unavailable",
    "knowledge_profile_visual_unavailable"
  ]);
  if ((value.activeRevision !== null && activeRevision === null) ||
    availableDestinations.some((destination) => destination === null) ||
    availableVisionDestinations.some((destination) => destination === null) ||
    recentRevisions.some((revision) => revision === null) ||
    new Set(availableDestinations.map((destination) => destination?.deploymentId)).size !==
      availableDestinations.length ||
    new Set(availableVisionDestinations.map((destination) => destination?.deploymentId)).size !==
      availableVisionDestinations.length ||
    value.egress.policyVersion !== "knowledge-profile-egress-v1" &&
      value.egress.policyVersion !== "knowledge-profile-egress-v2" ||
    value.egress.destination !== null && !safeString(value.egress.destination, 512) ||
    !Array.isArray(value.egress.representations) ||
    value.egress.representations.length !== 2 ||
    value.egress.representations[0] !== "document_text_chunks" ||
    value.egress.representations[1] !== "search_queries" ||
    value.egress.visualAnalysis !== null && (!record(value.egress.visualAnalysis) ||
      !safeString(value.egress.visualAnalysis.destination, 512) ||
      !Array.isArray(value.egress.visualAnalysis.representations) ||
      value.egress.visualAnalysis.representations.length !== 2 ||
      value.egress.visualAnalysis.representations[0] !== "visual_source_bytes" ||
      value.egress.visualAnalysis.representations[1] !== "visual_queries") ||
    value.egress.policyVersion === "knowledge-profile-egress-v1" &&
      value.egress.visualAnalysis !== null ||
    !healthStates.has(String(value.health.state)) ||
    value.health.code !== null && !healthCodes.has(String(value.health.code)) ||
    value.health.checkedAt !== null && !isoDate(value.health.checkedAt) ||
    (value.health.state === "not_configured" && (
      activeRevision !== null || value.health.code !== "knowledge_profile_not_configured" ||
      value.health.checkedAt !== null
    )) ||
    (value.health.state === "ready" && (
      activeRevision === null || value.health.code !== null || value.health.checkedAt === null
    )) ||
    (value.health.state === "ready_with_warnings" && (
      activeRevision === null || value.health.code !== "knowledge_profile_legacy_authority" &&
        value.health.code !== "knowledge_profile_visual_unavailable" ||
      value.health.checkedAt === null
    )) ||
    (value.health.state === "unavailable" && (
      activeRevision === null || value.health.code !== "knowledge_profile_unavailable" ||
      value.health.checkedAt === null
    )) ||
    !nonNegativeInteger(value.migration.activeProfileBases) ||
    !nonNegativeInteger(value.migration.buildingProfileBases) ||
    !nonNegativeInteger(value.migration.legacyGenerations) ||
    !nonNegativeInteger(value.migration.profiledGenerations) ||
    !nonNegativeInteger(value.migration.totalBases) ||
    Number(value.migration.activeProfileBases) > Number(value.migration.totalBases) ||
    Number(value.migration.buildingProfileBases) > Number(value.migration.totalBases) ||
    Number(value.migration.legacyGenerations) > Number(value.migration.profiledGenerations) ||
    (updatedBy !== null && (!record(updatedBy) || !safeString(updatedBy.id) ||
      !safeString(updatedBy.displayName, 160)))) return null;
  return {
    activeRevision,
    availableDestinations: availableDestinations as AdminKnowledgeProfileDestination[],
    availableVisionDestinations: availableVisionDestinations as AdminKnowledgeVisionDestination[],
    egress: {
      destination: value.egress.destination as string | null,
      policyVersion: value.egress.policyVersion as AdminKnowledgeProfileSettings["egress"]["policyVersion"],
      representations: ["document_text_chunks", "search_queries"],
      visualAnalysis: value.egress.visualAnalysis === null ? null : {
        destination: String((value.egress.visualAnalysis as Record<string, unknown>).destination),
        representations: ["visual_source_bytes", "visual_queries"]
      }
    },
    health: {
      checkedAt: value.health.checkedAt as string | null,
      code: value.health.code as AdminKnowledgeProfileSettings["health"]["code"],
      state: value.health.state as AdminKnowledgeProfileSettings["health"]["state"]
    },
    migration: {
      activeProfileBases: Number(value.migration.activeProfileBases),
      buildingProfileBases: Number(value.migration.buildingProfileBases),
      legacyGenerations: Number(value.migration.legacyGenerations),
      profiledGenerations: Number(value.migration.profiledGenerations),
      totalBases: Number(value.migration.totalBases)
    },
    recentRevisions: recentRevisions as AdminKnowledgeProfileRevision[],
    updatedAt: value.updatedAt,
    updatedBy: updatedBy as { displayName: string; id: string } | null,
    version: Number(value.version)
  };
}

function decodeOperations(value: unknown): AdminKnowledgeOperations | null {
  if (!record(value) || !Array.isArray(value.alerts) || !isoDate(value.checkedAt) ||
    !record(value.deletion) || !record(value.ingestion) || !record(value.migration) ||
    !record(value.retrieval)) return null;
  const deletion = value.deletion;
  const ingestion = value.ingestion;
  const migration = value.migration;
  const retrieval = value.retrieval;
  const alertCodes = new Set<AdminKnowledgeOperationsAlert["code"]>([
    "knowledge_deletion_backlog",
    "knowledge_deletion_blocked",
    "knowledge_ingestion_failures",
    "knowledge_ingestion_queue_stalled",
    "knowledge_retrieval_degraded",
    "knowledge_upload_sessions_expired",
    "knowledge_v1_reconciliation_incomplete"
  ]);
  const alerts = value.alerts.map((entry): AdminKnowledgeOperationsAlert | null =>
    record(entry) && alertCodes.has(entry.code as AdminKnowledgeOperationsAlert["code"]) &&
      (entry.severity === "critical" || entry.severity === "warning")
      ? {
          code: entry.code as AdminKnowledgeOperationsAlert["code"],
          severity: entry.severity
        }
      : null);
  const nullableInteger = (entry: unknown): entry is number | null =>
    entry === null || nonNegativeInteger(entry);
  const deletionKeys = ["blockedJobs", "pendingJobs", "pendingObjects"] as const;
  const ingestionKeys = [
    "activeUploads",
    "expiredUploads",
    "failedArtifacts",
    "items24h",
    "needsAttentionUploads",
    "pendingArtifacts",
    "processingArtifacts",
    "readyArtifacts",
    "settledUploads24h",
    "uploadedBytes24h",
    "warningArtifacts"
  ] as const;
  const migrationKeys = [
    "discrepancies",
    "mappedArtifacts",
    "mappedDocuments",
    "mappedVersions",
    "v1Artifacts",
    "v1Documents",
    "v1Versions"
  ] as const;
  const retrievalKeys = [
    "degradedOperations24h",
    "noAnswerOperations24h",
    "operations24h",
    "repairedAnswers24h"
  ] as const;
  if (alerts.some((entry) => entry === null) ||
    new Set(alerts.map((entry) => entry?.code)).size !== alerts.length ||
    deletionKeys.some((key) => !nonNegativeInteger(deletion[key])) ||
    !nullableInteger(deletion.oldestPendingSeconds) ||
    ingestionKeys.some((key) => !nonNegativeInteger(ingestion[key])) ||
    !nullableInteger(ingestion.oldestQueuedSeconds) ||
    !nullableInteger(ingestion.p50ReadyLatencyMs24h) ||
    !nullableInteger(ingestion.p95ReadyLatencyMs24h) ||
    migrationKeys.some((key) => !nonNegativeInteger(migration[key])) ||
    retrievalKeys.some((key) => !nonNegativeInteger(retrieval[key])) ||
    !nullableInteger(retrieval.p50DurationMs24h) ||
    !nullableInteger(retrieval.p95DurationMs24h) ||
    Number(retrieval.degradedOperations24h) > Number(retrieval.operations24h) ||
    ingestion.p50ReadyLatencyMs24h !== null &&
      ingestion.p95ReadyLatencyMs24h !== null &&
      Number(ingestion.p50ReadyLatencyMs24h) > Number(ingestion.p95ReadyLatencyMs24h) ||
    retrieval.p50DurationMs24h !== null &&
      retrieval.p95DurationMs24h !== null &&
      Number(retrieval.p50DurationMs24h) > Number(retrieval.p95DurationMs24h)) return null;
  return value as AdminKnowledgeOperations;
}

export function decodeAdminKnowledgeResponse(value: unknown): AdminKnowledgeResponse | null {
  if (!record(value) || !record(value.knowledge)) return null;
  const knowledge = value.knowledge;
  if (!record(knowledge.ingestionLimits) || !record(knowledge.policy) ||
    !record(knowledge.retrievalBounds)) return null;
  const ingestion = knowledge.ingestionLimits;
  const policy = knowledge.policy;
  const retrieval = knowledge.retrievalBounds;
  const profile = decodeProfile(knowledge.profile);
  const operations = decodeOperations(knowledge.operations);
  const updatedBy = policy.updatedBy;
  if (!profile || !operations || !positiveInteger(ingestion.maxChunksPerDocument) ||
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
      operations,
      policy: {
        candidateLimit: Number(policy.candidateLimit),
        resultLimit: Number(policy.resultLimit),
        scoreThreshold: Number(policy.scoreThreshold),
        updatedAt: String(policy.updatedAt),
        updatedBy: updatedBy as { displayName: string; id: string } | null,
        version: Number(policy.version)
      },
      profile,
      retrievalBounds: {
        candidateLimit: retrieval.candidateLimit as { max: number; min: number },
        resultLimit: retrieval.resultLimit as { max: number; min: number },
        scoreThreshold: retrieval.scoreThreshold as { max: number; min: number }
      }
    }
  };
}

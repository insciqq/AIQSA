export type AdminKnowledgeProfileDestination = Readonly<{
  connectionDisplayName: string;
  deploymentId: string;
  modelDisplayName: string;
  provider: string;
  targetDimension: number;
}>;

export type AdminKnowledgePdfProcessingMode =
  | "local"
  | "system_model_direct_pdf"
  | "system_model_vision";

export type AdminKnowledgePdfProcessingDestination = Readonly<{
  connectionDisplayName: string;
  deploymentId: string;
  modelDisplayName: string;
  provider: string;
  upstreamModelId: string;
}>;

export type AdminKnowledgePdfProcessingOption = Readonly<{
  available: boolean;
  mode: AdminKnowledgePdfProcessingMode;
  representation: "local_only" | "original_pdf_page_ranges" | "rendered_pdf_page_images";
}>;

export type AdminKnowledgeProfileRevision = Readonly<{
  activatedAt: string;
  destination: AdminKnowledgeProfileDestination;
  executionAuthority: "installation" | "legacy_user";
  id: string;
  pdfProcessing: Readonly<{
    destination: AdminKnowledgePdfProcessingDestination | null;
    mode: AdminKnowledgePdfProcessingMode;
    parserProfileVersion: number;
  }>;
  revisionNumber: number;
}>;

export type AdminKnowledgeProfileSettings = Readonly<{
  activeRevision: AdminKnowledgeProfileRevision | null;
  availableDestinations: AdminKnowledgeProfileDestination[];
  egress: Readonly<{
    embeddingDestination: string | null;
    pdfDestination: string | null;
    representations: readonly (
      | "document_text_chunks"
      | "original_pdf_page_ranges"
      | "rendered_pdf_page_images"
      | "search_queries"
    )[];
  }>;
  health: Readonly<{
    checkedAt: string | null;
    code: "knowledge_profile_legacy_authority" | "knowledge_profile_not_configured" |
      "knowledge_profile_unavailable" | null;
    state: "not_configured" | "ready" | "ready_with_warnings" | "unavailable";
  }>;
  migration: Readonly<{
    activeProfileBases: number;
    buildingProfileBases: number;
    legacyGenerations: number;
    profiledGenerations: number;
    totalBases: number;
  }>;
  pdfProcessingOptions: readonly AdminKnowledgePdfProcessingOption[];
  recentRevisions: AdminKnowledgeProfileRevision[];
  systemModelDestination: AdminKnowledgePdfProcessingDestination | null;
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
  }>;
}>;

export type AdminKnowledgeSettings = Readonly<{
  answerPolicy: Readonly<{
    fullContextThresholdPercent: 70;
    maximum: 32;
    maximumKnowledgeSearches: number;
    minimum: 1;
    updatedAt: string;
    updatedBy: { displayName: string; id: string } | null;
    version: number;
  }>;
  ingestionLimits: {
    maxChunksPerDocument: number;
    maxFileBytes: number;
    maxNormalizedChars: number;
    maxPages: number;
  };
  operations: AdminKnowledgeOperations;
  profile: AdminKnowledgeProfileSettings;
  retrieval: {
    candidateLimit: 40;
    resultLimit: 16;
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

function pdfProcessingMode(value: unknown): AdminKnowledgePdfProcessingMode | null {
  return value === "local" || value === "system_model_direct_pdf" ||
    value === "system_model_vision" ? value : null;
}

function decodePdfDestination(value: unknown): AdminKnowledgePdfProcessingDestination | null {
  if (!record(value) || !safeString(value.connectionDisplayName) ||
    !safeString(value.deploymentId) || !safeString(value.modelDisplayName) ||
    !safeString(value.provider) || !safeString(value.upstreamModelId, 512)) return null;
  return {
    connectionDisplayName: value.connectionDisplayName,
    deploymentId: value.deploymentId,
    modelDisplayName: value.modelDisplayName,
    provider: value.provider,
    upstreamModelId: value.upstreamModelId
  };
}

function decodePdfOption(value: unknown): AdminKnowledgePdfProcessingOption | null {
  if (!record(value) || typeof value.available !== "boolean") return null;
  const mode = pdfProcessingMode(value.mode);
  const representations = new Set([
    "local_only",
    "original_pdf_page_ranges",
    "rendered_pdf_page_images"
  ]);
  if (!mode || !representations.has(String(value.representation))) return null;
  const expected = mode === "local"
    ? "local_only"
    : mode === "system_model_direct_pdf"
      ? "original_pdf_page_ranges"
      : "rendered_pdf_page_images";
  return value.representation === expected
    ? { available: value.available, mode, representation: expected }
    : null;
}

function decodeRevision(value: unknown): AdminKnowledgeProfileRevision | null {
  if (!record(value) || !isoDate(value.activatedAt) || !safeString(value.id) ||
    !positiveInteger(value.revisionNumber) ||
    value.executionAuthority !== "installation" && value.executionAuthority !== "legacy_user") {
    return null;
  }
  const destination = decodeDestination(value.destination);
  const processing = record(value.pdfProcessing) ? value.pdfProcessing : null;
  const mode = pdfProcessingMode(processing?.mode);
  const processingDestination = processing?.destination === null
    ? null
    : decodePdfDestination(processing?.destination);
  if (!destination || !processing || !mode ||
    !positiveInteger(processing.parserProfileVersion) ||
    (mode === "local" && processingDestination !== null) ||
    (mode !== "local" && processingDestination === null)) return null;
  return {
    activatedAt: value.activatedAt,
    destination,
    executionAuthority: value.executionAuthority,
    id: value.id,
    pdfProcessing: {
      destination: processingDestination,
      mode,
      parserProfileVersion: Number(processing.parserProfileVersion)
    },
    revisionNumber: value.revisionNumber
  };
}

function decodeProfile(value: unknown): AdminKnowledgeProfileSettings | null {
  if (!record(value) || !Array.isArray(value.availableDestinations) ||
    !record(value.egress) || !record(value.health) || !record(value.migration) ||
    !Array.isArray(value.pdfProcessingOptions) || !Array.isArray(value.recentRevisions) ||
    !isoDate(value.updatedAt) ||
    !positiveInteger(value.version)) return null;
  const activeRevision = value.activeRevision === null ? null : decodeRevision(value.activeRevision);
  const availableDestinations = value.availableDestinations.map(decodeDestination);
  const recentRevisions = value.recentRevisions.map(decodeRevision);
  const pdfProcessingOptions = value.pdfProcessingOptions.map(decodePdfOption);
  const systemModelDestination = value.systemModelDestination === null
    ? null
    : decodePdfDestination(value.systemModelDestination);
  const updatedBy = value.updatedBy;
  const healthStates = new Set(["not_configured", "ready", "ready_with_warnings", "unavailable"]);
  const healthCodes = new Set([
    "knowledge_profile_legacy_authority",
    "knowledge_profile_not_configured",
    "knowledge_profile_unavailable"
  ]);
  if ((value.activeRevision !== null && activeRevision === null) ||
    availableDestinations.some((destination) => destination === null) ||
    recentRevisions.some((revision) => revision === null) ||
    pdfProcessingOptions.some((option) => option === null) ||
    pdfProcessingOptions.length !== 3 ||
    pdfProcessingOptions[0]?.mode !== "local" ||
    pdfProcessingOptions[0]?.available !== true ||
    pdfProcessingOptions[1]?.mode !== "system_model_direct_pdf" ||
    pdfProcessingOptions[2]?.mode !== "system_model_vision" ||
    (value.systemModelDestination !== null && systemModelDestination === null) ||
    new Set(availableDestinations.map((destination) => destination?.deploymentId)).size !==
      availableDestinations.length ||
    value.egress.embeddingDestination !== null &&
      !safeString(value.egress.embeddingDestination, 512) ||
    value.egress.pdfDestination !== null && !safeString(value.egress.pdfDestination, 512) ||
    !Array.isArray(value.egress.representations) ||
    value.egress.representations.length < 2 || value.egress.representations.length > 3 ||
    value.egress.representations[0] !== "document_text_chunks" ||
    value.egress.representations[1] !== "search_queries" ||
    (value.egress.representations.length === 3 &&
      value.egress.representations[2] !== "original_pdf_page_ranges" &&
      value.egress.representations[2] !== "rendered_pdf_page_images") ||
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
      activeRevision === null || value.health.code !== "knowledge_profile_legacy_authority" ||
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
    egress: {
      embeddingDestination: value.egress.embeddingDestination as string | null,
      pdfDestination: value.egress.pdfDestination as string | null,
      representations: value.egress.representations as AdminKnowledgeProfileSettings["egress"]["representations"]
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
    pdfProcessingOptions: pdfProcessingOptions as AdminKnowledgePdfProcessingOption[],
    recentRevisions: recentRevisions as AdminKnowledgeProfileRevision[],
    systemModelDestination,
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
    "operations24h"
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
  if (!record(knowledge.answerPolicy) || !record(knowledge.ingestionLimits) ||
    !record(knowledge.retrieval)) return null;
  const answerPolicy = knowledge.answerPolicy;
  const ingestion = knowledge.ingestionLimits;
  const retrieval = knowledge.retrieval;
  const profile = decodeProfile(knowledge.profile);
  const operations = decodeOperations(knowledge.operations);
  const answerPolicyUpdatedBy = answerPolicy.updatedBy;
  if (!profile || !operations || !positiveInteger(ingestion.maxChunksPerDocument) ||
    !positiveInteger(ingestion.maxFileBytes) ||
    !positiveInteger(ingestion.maxNormalizedChars) ||
    !positiveInteger(ingestion.maxPages) ||
    answerPolicy.fullContextThresholdPercent !== 70 || answerPolicy.minimum !== 1 ||
    answerPolicy.maximum !== 32 || !positiveInteger(answerPolicy.maximumKnowledgeSearches) ||
    Number(answerPolicy.maximumKnowledgeSearches) > 32 ||
    !positiveInteger(answerPolicy.version) || !isoDate(answerPolicy.updatedAt) ||
    answerPolicyUpdatedBy !== null && (!record(answerPolicyUpdatedBy) ||
      !safeString(answerPolicyUpdatedBy.id) ||
      !safeString(answerPolicyUpdatedBy.displayName, 160)) ||
    retrieval.candidateLimit !== 40 || retrieval.resultLimit !== 16 ||
    Object.keys(retrieval).some((key) => key !== "candidateLimit" && key !== "resultLimit")) {
    return null;
  }

  return {
    knowledge: {
      answerPolicy: {
        fullContextThresholdPercent: 70,
        maximum: 32,
        maximumKnowledgeSearches: Number(answerPolicy.maximumKnowledgeSearches),
        minimum: 1,
        updatedAt: answerPolicy.updatedAt as string,
        updatedBy: answerPolicyUpdatedBy as { displayName: string; id: string } | null,
        version: Number(answerPolicy.version)
      },
      ingestionLimits: {
        maxChunksPerDocument: Number(ingestion.maxChunksPerDocument),
        maxFileBytes: Number(ingestion.maxFileBytes),
        maxNormalizedChars: Number(ingestion.maxNormalizedChars),
        maxPages: Number(ingestion.maxPages)
      },
      operations,
      profile,
      retrieval: {
        candidateLimit: 40,
        resultLimit: 16
      }
    }
  };
}

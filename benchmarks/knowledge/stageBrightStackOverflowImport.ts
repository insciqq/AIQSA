import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import {
  createPrismaKnowledgeBulkPreparationRepository,
  type KnowledgeBulkHierarchicalResult,
  type KnowledgeBulkPreparationResult,
  type KnowledgeBulkPreparedSource
} from "../../lib/server/knowledge/bulkPreparation";
import { getKnowledgeExtractionConfig } from
  "../../lib/server/knowledge/knowledgeExtractionConfig";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from
  "../../lib/server/knowledge/hierarchicalIndex";
import { KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE } from
  "../../lib/server/knowledge/hierarchicalIndexRepository";
import { resolveActiveKnowledgeProfile } from
  "../../lib/server/knowledge/knowledgeProfile";
import { knowledgeSourceNormalizedTextStorageKey } from
  "../../lib/server/knowledge/sourceArtifactKeys";
import { requireKnowledgeTokenCounter } from
  "../../lib/server/knowledge/tokenizer/knowledgeTokenCounter";
import { knowledgeTokenizerIdentityLabel } from
  "../../lib/server/knowledge/tokenizer/types";
import { createS3StorageAdapter, type StorageAdapter } from
  "../../lib/server/uploads/storage";
import {
  canonicalJson,
  KNOWLEDGE_BENCHMARK_MAX_CONCURRENCY,
  mapConcurrentOrdered
} from "./contract";
import {
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  BRIGHT_STACKOVERFLOW_FILE_NAME,
  BRIGHT_STACKOVERFLOW_MEDIA_TYPE,
  BRIGHT_STACKOVERFLOW_SOURCE_NAME,
  brightDeterministicUuid,
  decodeBrightPreparedDocumentRow,
  type BrightPreparedDocument
} from "./brightStackOverflowContract";
import { verifyBrightPreparedDataset } from "./brightStackOverflowPrepared";
import {
  buildBrightProductDocumentPlan,
  type BrightProductDocumentPlan
} from "./brightStackOverflowProduct";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
export const dataRoot = resolve(benchmarkRoot, ".data");
export const preparedRoot = resolve(dataRoot, "prepared/bright-stackoverflow-50m");
export const stateRoot = resolve(dataRoot, "state");
const retainedTargetAck = "RETAINED_BRIGHT_KB";
const cliTargetAck = "RETAINED";
const heldUntil = new Date("9999-12-31T23:59:59.000Z");
const benchmarkOwnerEmail = "bright-stackoverflow-50m@knowledge.benchmark.invalid";
const benchmarkBaseName = "BRIGHT Stack Overflow 50M";
const benchmarkBaseDescription =
  "Retained BRIGHT Stack Overflow corpus for the local AIQSA Knowledge benchmark.";

type CliOptions = Readonly<{
  batchSize: number;
  documentLimit: number;
  phase: "hierarchy" | "sources";
  resume: boolean;
  startOrdinal: number;
  storageConcurrency: number;
}>;

export type ActiveImportProfile = Readonly<{
  chunkingProfileVersion: number;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  profileRevisionId: string;
  profileRevisionNumber: number;
  targetDimension: number;
  tokenizerIdentity: string;
  upstreamModelId: string;
  vectorSpaceFingerprint: string;
}>;

export type PreparedStagePlan = Readonly<{
  body: Buffer;
  productPlan: BrightProductDocumentPlan;
  source: KnowledgeBulkPreparedSource;
}>;

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function parsePositiveInteger(value: string | undefined, maximum: number, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  let batchSize = 100;
  let documentLimit = 1;
  let phase: CliOptions["phase"] = "sources";
  let resume = false;
  let startOrdinal = 0;
  let storageConcurrency = 16;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--confirm-target") {
      if (next !== cliTargetAck) {
        throw new Error("bright_stackoverflow_import_confirmation_invalid");
      }
      confirmed = true;
      index += 1;
    } else if (argument === "--batch-size") {
      batchSize = parsePositiveInteger(
        next,
        500,
        "bright_stackoverflow_import_batch_size_invalid"
      );
      index += 1;
    } else if (argument === "--document-limit") {
      documentLimit = parsePositiveInteger(
        next,
        BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
        "bright_stackoverflow_import_document_limit_invalid"
      );
      index += 1;
    } else if (argument === "--phase") {
      if (next !== "sources" && next !== "hierarchy") {
        throw new Error("bright_stackoverflow_import_phase_invalid");
      }
      phase = next;
      index += 1;
    } else if (argument === "--start-ordinal") {
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed < 0 ||
        parsed >= BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
        throw new Error("bright_stackoverflow_import_start_ordinal_invalid");
      }
      startOrdinal = parsed;
      index += 1;
    } else if (argument === "--storage-concurrency") {
      storageConcurrency = parsePositiveInteger(
        next,
        KNOWLEDGE_BENCHMARK_MAX_CONCURRENCY,
        "bright_stackoverflow_import_storage_concurrency_invalid"
      );
      index += 1;
    } else if (argument === "--resume") {
      resume = true;
    } else {
      throw new Error("bright_stackoverflow_import_argument_unknown");
    }
  }
  if (!confirmed || process.env.AIQSA_BRIGHT_BENCHMARK_ACK !== retainedTargetAck) {
    throw new Error("bright_stackoverflow_import_confirmation_required");
  }
  if (startOrdinal + documentLimit > BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_import_range_invalid");
  }
  if (phase === "hierarchy" &&
    batchSize > KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE) {
    throw new Error("bright_stackoverflow_import_batch_size_invalid");
  }
  return Object.freeze({
    batchSize,
    documentLimit,
    phase,
    resume,
    startOrdinal,
    storageConcurrency
  });
}

function sha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function isMissingObject(error: unknown): boolean {
  const value = typeof error === "object" && error !== null
    ? error as { $metadata?: { httpStatusCode?: number }; name?: string }
    : null;
  return value?.$metadata?.httpStatusCode === 404 ||
    value?.name === "NoSuchKey" || value?.name === "NotFound";
}

async function ensureNormalizedObject(
  storage: StorageAdapter,
  plan: PreparedStagePlan
): Promise<"created" | "reused"> {
  if (!storage.inspectObject) {
    throw new Error("bright_stackoverflow_import_storage_inspection_unavailable");
  }
  try {
    const existing = await storage.inspectObject(plan.source.normalizedTextStorageKey, {
      maxBytes: plan.source.normalizedTextByteSize
    });
    if (existing.byteSize !== plan.source.normalizedTextByteSize ||
      existing.checksum !== plan.source.normalizedTextChecksum) {
      throw new Error("bright_stackoverflow_import_normalized_object_conflict");
    }
    return "reused";
  } catch (error) {
    if (!isMissingObject(error)) throw error;
  }
  await storage.putObject({
    body: plan.body,
    contentType: "application/json",
    storageKey: plan.source.normalizedTextStorageKey
  });
  const settled = await storage.inspectObject(plan.source.normalizedTextStorageKey, {
    maxBytes: plan.source.normalizedTextByteSize
  });
  if (settled.byteSize !== plan.source.normalizedTextByteSize ||
    settled.checksum !== plan.source.normalizedTextChecksum) {
    throw new Error("bright_stackoverflow_import_normalized_object_settlement_failed");
  }
  return "created";
}

export async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database: string; role: string }>>(
    Prisma.sql`SELECT current_database() AS database, current_user AS role`
  );
  if (rows.length !== 1 || rows[0]?.database !== "aiqsa_knowledge_benchmark" ||
    rows[0]?.role !== "aiqsa_benchmark") {
    throw new Error("bright_stackoverflow_import_database_identity_mismatch");
  }
}

export async function ensureBenchmarkOwner(prisma: PrismaClient): Promise<string> {
  const ownerUserId = brightDeterministicUuid("benchmark-owner");
  const existing = await prisma.user.findUnique({
    select: { email: true, role: true, status: true },
    where: { id: ownerUserId }
  });
  if (existing && (existing.email !== benchmarkOwnerEmail || existing.role !== "user" ||
    existing.status !== "active")) {
    throw new Error("bright_stackoverflow_import_owner_conflict");
  }
  const fullAccess = await prisma.group.findUnique({
    select: { id: true },
    where: { systemRole: "full_access" }
  });
  if (!fullAccess) throw new Error("bright_stackoverflow_import_full_access_missing");
  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      create: {
        displayName: "BRIGHT Knowledge benchmark",
        email: benchmarkOwnerEmail,
        id: ownerUserId,
        role: "user",
        status: "active"
      },
      update: {},
      where: { id: ownerUserId }
    });
    await provisionActiveUser(tx, {
      groups: [{ groupId: fullAccess.id, role: "member" }],
      userId: ownerUserId
    });
  });
  return ownerUserId;
}

function embeddingUpstreamModelId(configuration: Prisma.JsonValue): string {
  if (typeof configuration !== "object" || configuration === null ||
    Array.isArray(configuration)) {
    throw new Error("bright_stackoverflow_import_profile_invalid");
  }
  const upstreamModelId = (configuration as Record<string, Prisma.JsonValue>)
    .upstreamModelId;
  if (typeof upstreamModelId !== "string" || !upstreamModelId.trim()) {
    throw new Error("bright_stackoverflow_import_profile_invalid");
  }
  return upstreamModelId;
}

export async function activeImportProfile(
  prisma: PrismaClient,
  ownerUserId: string
): Promise<ActiveImportProfile> {
  const resolution = await resolveActiveKnowledgeProfile(prisma, ownerUserId);
  if (resolution.kind !== "ok") {
    throw new Error(`bright_stackoverflow_import_profile_${resolution.kind}`);
  }
  const profile = resolution.profile;
  const upstreamModelId = embeddingUpstreamModelId(profile.embeddingConfiguration);
  const tokenCounter = requireKnowledgeTokenCounter(upstreamModelId);
  return Object.freeze({
    chunkingProfileVersion: profile.chunkingProfileVersion,
    embeddingConfiguration: profile.embeddingConfiguration,
    embeddingProviderModelId: profile.embeddingProviderModelId,
    profileRevisionId: profile.revisionId,
    profileRevisionNumber: profile.revisionNumber,
    targetDimension: profile.pin.targetDimension,
    tokenizerIdentity: knowledgeTokenizerIdentityLabel(tokenCounter.identity),
    upstreamModelId,
    vectorSpaceFingerprint: profile.pin.fingerprint
  });
}

export function importIdentity(
  datasetManifestFingerprint: string,
  profile: ActiveImportProfile
): string {
  return sha256(canonicalJson({
    chunkingProfileVersion: profile.chunkingProfileVersion,
    datasetManifestFingerprint,
    embeddingProviderModelId: profile.embeddingProviderModelId,
    hierarchicalIndexVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
    profileRevisionId: profile.profileRevisionId,
    targetDimension: profile.targetDimension,
    tokenizerIdentity: profile.tokenizerIdentity,
    upstreamModelId: profile.upstreamModelId,
    vectorSpaceFingerprint: profile.vectorSpaceFingerprint
  }));
}

export async function ensureBenchmarkBase(input: Readonly<{
  importIdentity: string;
  ownerUserId: string;
  prisma: PrismaClient;
  profile: ActiveImportProfile;
}>): Promise<Readonly<{ baseId: string; generationId: string }>> {
  const baseId = brightDeterministicUuid("benchmark-base", input.importIdentity);
  const generationId = brightDeterministicUuid(
    "benchmark-generation",
    input.importIdentity
  );
  await input.prisma.$transaction(async (tx) => {
    const installationProfile = await tx.knowledgeIndexProfile.findUnique({
      select: { activeRevisionId: true },
      where: { id: "installation" }
    });
    if (installationProfile?.activeRevisionId !== input.profile.profileRevisionId) {
      throw new Error("bright_stackoverflow_import_profile_changed");
    }
    const existing = await tx.knowledgeBase.findUnique({
      include: { activeIndexGeneration: true },
      where: { id: baseId }
    });
    if (existing) {
      const generation = existing.activeIndexGeneration;
      if (existing.ownerUserId !== input.ownerUserId ||
        existing.name !== benchmarkBaseName ||
        existing.description !== benchmarkBaseDescription || existing.archivedAt ||
        existing.trashedAt || existing.deletionRequestedAt || generation?.id !== generationId ||
        generation.profileRevisionId !== input.profile.profileRevisionId ||
        generation.embeddingProviderModelId !== input.profile.embeddingProviderModelId ||
        generation.vectorSpaceFingerprint.trim() !== input.profile.vectorSpaceFingerprint ||
        generation.targetDimension !== input.profile.targetDimension ||
        generation.chunkingProfileVersion !== input.profile.chunkingProfileVersion ||
        generation.status !== "active" ||
        canonicalJson(generation.embeddingConfiguration) !==
          canonicalJson(input.profile.embeddingConfiguration)) {
        throw new Error("bright_stackoverflow_import_base_conflict");
      }
      return;
    }
    await tx.knowledgeBase.create({
      data: {
        description: benchmarkBaseDescription,
        id: baseId,
        name: benchmarkBaseName,
        ownerUserId: input.ownerUserId
      }
    });
    const now = new Date();
    await tx.knowledgeIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingProfileVersion: input.profile.chunkingProfileVersion,
        embeddingConfiguration: input.profile.embeddingConfiguration as Prisma.InputJsonValue,
        embeddingProviderModelId: input.profile.embeddingProviderModelId,
        id: generationId,
        indexedContentRevision: 0,
        knowledgeBaseId: baseId,
        profileRevisionId: input.profile.profileRevisionId,
        readyAt: now,
        status: "active",
        targetDimension: input.profile.targetDimension,
        vectorSpaceFingerprint: input.profile.vectorSpaceFingerprint
      }
    });
    await tx.knowledgeBase.update({
      data: { activeIndexGenerationId: generationId },
      where: { id: baseId }
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return Object.freeze({ baseId, generationId });
}

export async function* selectedDocuments(
  startOrdinal: number,
  documentLimit: number,
  shards: readonly Readonly<{ path: string }>[]
): AsyncGenerator<BrightPreparedDocument> {
  const endOrdinal = startOrdinal + documentLimit;
  let yielded = 0;
  for (const shard of shards) {
    const shardPath = resolve(preparedRoot, shard.path);
    if (!shardPath.startsWith(`${preparedRoot}${sep}`)) {
      throw new Error("bright_stackoverflow_prepared_shard_path_invalid");
    }
    const body = await readFile(shardPath, "utf8");
    const lines = body.split("\n");
    if (lines.at(-1) !== "") throw new Error("bright_stackoverflow_prepared_shard_invalid");
    lines.pop();
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error("bright_stackoverflow_prepared_shard_invalid");
      }
      const document = decodeBrightPreparedDocumentRow(value);
      if (document.ordinal < startOrdinal) continue;
      if (document.ordinal >= endOrdinal) {
        if (yielded !== documentLimit) {
          throw new Error("bright_stackoverflow_import_document_count_mismatch");
        }
        return;
      }
      if (document.ordinal !== startOrdinal + yielded) {
        throw new Error("bright_stackoverflow_prepared_ordinal_mismatch");
      }
      yielded += 1;
      yield document;
    }
  }
  if (yielded !== documentLimit) {
    throw new Error("bright_stackoverflow_import_document_count_mismatch");
  }
}

export function buildStagePlan(input: Readonly<{
  document: BrightPreparedDocument;
  importIdentity: string;
  ownerUserId: string;
  profile: ActiveImportProfile;
}>): PreparedStagePlan {
  const artifactId = brightDeterministicUuid(
    "artifact",
    input.document.sourceVersionId,
    input.importIdentity
  );
  const tokenCounter = requireKnowledgeTokenCounter(input.profile.upstreamModelId);
  const plan = buildBrightProductDocumentPlan({
    artifactId,
    chunkingProfileVersion: input.profile.chunkingProfileVersion,
    config: getKnowledgeExtractionConfig({}),
    document: input.document,
    tokenCounter
  });
  const sourceBytes = Buffer.from(input.document.preparedText, "utf8");
  return Object.freeze({
    body: plan.normalized.body,
    productPlan: plan,
    source: Object.freeze({
      artifactId,
      byteSize: sourceBytes.byteLength,
      checksum: sha256(sourceBytes),
      fileName: BRIGHT_STACKOVERFLOW_FILE_NAME,
      mimeType: BRIGHT_STACKOVERFLOW_MEDIA_TYPE,
      normalizedTextByteSize: plan.normalized.body.byteLength,
      normalizedTextChecksum: plan.normalized.checksum,
      normalizedTextStorageKey: knowledgeSourceNormalizedTextStorageKey({
        artifactId,
        ownerUserId: input.ownerUserId,
        sourceId: input.document.sourceId,
        sourceVersionId: input.document.sourceVersionId
      }),
      sourceId: input.document.sourceId,
      sourceName: BRIGHT_STACKOVERFLOW_SOURCE_NAME,
      sourceVersionId: input.document.sourceVersionId
    })
  });
}

type ImportCheckpointKind = "hierarchy" | "sources";

function statePath(
  checkpointKind: ImportCheckpointKind,
  importIdentityValue: string,
  rangeStartOrdinal: number,
  rangeEndOrdinal: number
): string {
  return resolve(
    stateRoot,
    `bright-${checkpointKind === "sources" ? "import" : "hierarchy"}-` +
      `${importIdentityValue}-${rangeStartOrdinal}-${rangeEndOrdinal}.json`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function serializedProfile(profile: ActiveImportProfile): Readonly<Record<string, unknown>> {
  return Object.freeze({
    chunkingProfileVersion: profile.chunkingProfileVersion,
    embeddingProviderModelId: profile.embeddingProviderModelId,
    profileRevisionId: profile.profileRevisionId,
    profileRevisionNumber: profile.profileRevisionNumber,
    targetDimension: profile.targetDimension,
    tokenizerIdentity: profile.tokenizerIdentity,
    upstreamModelId: profile.upstreamModelId,
    vectorSpaceFingerprint: profile.vectorSpaceFingerprint
  });
}

type ImportStateIdentity = Readonly<{
  baseId: string;
  checkpointKind: ImportCheckpointKind;
  datasetManifestFingerprint: string;
  generationId: string;
  importIdentity: string;
  ownerUserId: string;
  profile: ActiveImportProfile;
  rangeEndOrdinal: number;
  rangeStartOrdinal: number;
}>;

async function readResumeOrdinal(input: ImportStateIdentity): Promise<number> {
  const path = statePath(
    input.checkpointKind,
    input.importIdentity,
    input.rangeStartOrdinal,
    input.rangeEndOrdinal
  );
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("bright_stackoverflow_import_resume_state_missing");
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_import_resume_state_corrupt");
  }
  const expectedKeys = [
    "baseId",
    "datasetManifestFingerprint",
    "generationId",
    "importIdentity",
    "ownerUserId",
    "profile",
    "rangeEndOrdinal",
    "rangeStartOrdinal",
    "schemaVersion",
    "stagedThroughOrdinal",
    "updatedAt"
  ];
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys) ||
    value.schemaVersion !== 1 || value.baseId !== input.baseId ||
    value.datasetManifestFingerprint !== input.datasetManifestFingerprint ||
    value.generationId !== input.generationId ||
    value.importIdentity !== input.importIdentity || value.ownerUserId !== input.ownerUserId ||
    value.rangeStartOrdinal !== input.rangeStartOrdinal ||
    value.rangeEndOrdinal !== input.rangeEndOrdinal || !isRecord(value.profile) ||
    canonicalJson(value.profile) !== canonicalJson(serializedProfile(input.profile)) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.stagedThroughOrdinal !== "number" ||
    !Number.isSafeInteger(value.stagedThroughOrdinal) ||
    value.stagedThroughOrdinal < input.rangeStartOrdinal ||
    value.stagedThroughOrdinal >= input.rangeEndOrdinal) {
    throw new Error("bright_stackoverflow_import_resume_state_corrupt");
  }
  return value.stagedThroughOrdinal + 1;
}

async function writeState(input: ImportStateIdentity & Readonly<{
  stagedThroughOrdinal: number;
}>): Promise<void> {
  const path = statePath(
    input.checkpointKind,
    input.importIdentity,
    input.rangeStartOrdinal,
    input.rangeEndOrdinal
  );
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(stateRoot, { recursive: true });
  await writeFile(temporary, `${JSON.stringify({
    baseId: input.baseId,
    datasetManifestFingerprint: input.datasetManifestFingerprint,
    generationId: input.generationId,
    importIdentity: input.importIdentity,
    ownerUserId: input.ownerUserId,
    profile: serializedProfile(input.profile),
    rangeEndOrdinal: input.rangeEndOrdinal,
    rangeStartOrdinal: input.rangeStartOrdinal,
    schemaVersion: 1,
    stagedThroughOrdinal: input.stagedThroughOrdinal,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(?:bright_stackoverflow_|knowledge_bulk_)[a-z0-9_:.-]+$/u.test(message)
    ? message
    : "bright_stackoverflow_import_failed";
}

function stageFailure(error: unknown, fallback: string): Error {
  const code = safeFailureCode(error);
  if (code !== "bright_stackoverflow_import_failed") return new Error(code);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return new Error(`${fallback}_${error.code.toLowerCase()}`);
  }
  return new Error(fallback);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (!process.env.DATABASE_URL || !process.env.S3_ENDPOINT || !process.env.S3_BUCKET ||
    !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    throw new Error("bright_stackoverflow_import_target_environment_missing");
  }
  const manifest = await verifyBrightPreparedDataset(preparedRoot);
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    await assertDatabaseIdentity(prisma);
    const ownerUserId = await ensureBenchmarkOwner(prisma);
    const profile = await activeImportProfile(prisma, ownerUserId);
    const identity = importIdentity(manifest.manifestFingerprint, profile);
    const { baseId, generationId } = await ensureBenchmarkBase({
      importIdentity: identity,
      ownerUserId,
      prisma,
      profile
    });
    const repository = createPrismaKnowledgeBulkPreparationRepository(prisma);
    const storage = createS3StorageAdapter();
    const rangeEndOrdinal = options.startOrdinal + options.documentLimit;
    const stateIdentity = Object.freeze({
      baseId,
      checkpointKind: options.phase,
      datasetManifestFingerprint: manifest.manifestFingerprint,
      generationId,
      importIdentity: identity,
      ownerUserId,
      profile,
      rangeEndOrdinal,
      rangeStartOrdinal: options.startOrdinal
    });
    const effectiveStartOrdinal = options.resume
      ? await readResumeOrdinal(stateIdentity)
      : options.startOrdinal;
    let batch: BrightPreparedDocument[] = [];
    let createdArtifacts = 0;
    let createdHierarchies = 0;
    let createdMemberships = 0;
    let createdObjects = 0;
    let createdSources = 0;
    let createdVersions = 0;
    let reusedHierarchies = 0;
    let reusedObjects = 0;
    let stagedDocuments = 0;
    let truncatedHierarchies = 0;
    const startedAt = performance.now();

    const flush = async () => {
      if (batch.length === 0) return;
      let plans: PreparedStagePlan[];
      try {
        plans = batch.map((document) => buildStagePlan({
          document,
          importIdentity: identity,
          ownerUserId,
          profile
        }));
      } catch (error) {
        throw stageFailure(error, "bright_stackoverflow_import_plan_failed");
      }
      let objectResults: readonly ("created" | "reused")[];
      try {
        objectResults = await mapConcurrentOrdered(
          plans,
          options.storageConcurrency,
          (plan) => ensureNormalizedObject(storage, plan)
        );
      } catch (error) {
        throw stageFailure(error, "bright_stackoverflow_import_storage_failed");
      }
      createdObjects += objectResults.filter((result) => result === "created").length;
      reusedObjects += objectResults.filter((result) => result === "reused").length;
      if (options.phase === "sources") {
        let staged: KnowledgeBulkPreparationResult;
        try {
          staged = await repository.stageSources({
            heldUntil,
            knowledgeBaseId: baseId,
            now: new Date(),
            ownerUserId,
            profileRevisionId: profile.profileRevisionId,
            sources: plans.map(({ source }) => source)
          });
        } catch (error) {
          throw stageFailure(error, "bright_stackoverflow_import_database_failed");
        }
        createdArtifacts += staged.createdArtifacts;
        createdMemberships += staged.createdMemberships;
        createdSources += staged.createdSources;
        createdVersions += staged.createdVersions;
      } else {
        let staged: KnowledgeBulkHierarchicalResult;
        try {
          staged = await repository.stageHierarchicalIndexes({
            heldUntil,
            knowledgeBaseId: baseId,
            now: new Date(),
            ownerUserId,
            profileRevisionId: profile.profileRevisionId,
            sources: plans.map((plan) => ({
              chunks: plan.productPlan.chunks,
              document: plan.productPlan.normalized.document,
              prepared: plan.source
            }))
          });
        } catch (error) {
          throw stageFailure(error, "bright_stackoverflow_import_database_failed");
        }
        createdHierarchies += staged.createdHierarchies;
        reusedHierarchies += staged.reusedHierarchies;
        truncatedHierarchies += staged.truncatedHierarchies;
      }
      stagedDocuments += batch.length;
      const stagedThroughOrdinal = batch.at(-1)!.ordinal;
      try {
        await writeState({
          ...stateIdentity,
          stagedThroughOrdinal
        });
      } catch (error) {
        throw stageFailure(error, "bright_stackoverflow_import_checkpoint_failed");
      }
      emit(options.phase === "sources"
        ? "bright_stackoverflow_import_stage_progress"
        : "bright_stackoverflow_import_hierarchy_progress", {
        elapsedMs: Math.round(performance.now() - startedAt),
        stagedDocuments,
        stagedThroughOrdinal
      });
      batch = [];
    };

    if (effectiveStartOrdinal < rangeEndOrdinal) {
      for await (const document of selectedDocuments(
        effectiveStartOrdinal,
        rangeEndOrdinal - effectiveStartOrdinal,
        manifest.corpus.shards
      )) {
        batch.push(document);
        if (batch.length >= options.batchSize) await flush();
      }
      await flush();
    }
    emit(options.phase === "sources"
      ? "bright_stackoverflow_import_stage_complete"
      : "bright_stackoverflow_import_hierarchy_complete", {
      createdArtifacts,
      createdHierarchies,
      createdMemberships,
      createdObjects,
      createdSources,
      createdVersions,
      elapsedMs: Math.round(performance.now() - startedAt),
      heldForExplicitExecution: true,
      providerRequests: 0,
      phase: options.phase,
      reusedHierarchies,
      resumed: options.resume,
      reusedObjects,
      stagedDocuments,
      truncatedHierarchies
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: safeFailureCode(error),
      event: "bright_stackoverflow_import_stage_failed"
    })}\n`);
    process.exitCode = 1;
  });
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { Prisma, PrismaClient } from "@prisma/client";
import { Client } from "pg";
import {
  createPrismaKnowledgeBulkEmbeddingRepository,
  type KnowledgeBulkEmbeddingPassageIdentity,
  type KnowledgeBulkEmbeddingPassageWrite,
  type KnowledgeBulkEmbeddingTarget
} from "../../lib/server/knowledge/bulkEmbedding";
import { createKnowledgeEmbeddingBatchAccumulator } from
  "../../lib/server/knowledge/chunking";
import { createKnowledgeVectorSpacePin } from
  "../../lib/server/knowledge/indexProfile";
import { requireKnowledgeTokenCounter } from
  "../../lib/server/knowledge/tokenizer/knowledgeTokenCounter";
import type { KnowledgeTokenCounter } from
  "../../lib/server/knowledge/tokenizer/types";
import { createPrismaEmbeddingRuntime } from
  "../../lib/server/providerRuntime/embeddingRuntime";
import type { EmbeddingUsage } from "../../lib/server/providers/embeddings";
import { canonicalJson } from "./contract";
import {
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  brightDeterministicUuid
} from "./brightStackOverflowContract";
import { verifyBrightPreparedDataset } from "./brightStackOverflowPrepared";
import {
  activeImportProfile,
  assertDatabaseIdentity,
  buildStagePlan,
  ensureBenchmarkBase,
  ensureBenchmarkOwner,
  importIdentity,
  preparedRoot,
  selectedDocuments,
  stateRoot,
  type ActiveImportProfile
} from "./stageBrightStackOverflowImport";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const targetAck = "RETAINED";
const targetEnvironmentAck = "RETAINED_BRIGHT_KB";
const paidCanaryAck = "OPENROUTER_CANARY";
const paidFullAck = "OPENROUTER_FULL_50M_USD_0_75";
const canaryBatchLimit = 1;
const fullAuthorizedMaximumUsd = 0.75;
const fullInputPriceUsdPerMillion = 0.01;
const fullExpectedBatchCount = 5_067;
const fullExpectedInputCount = 256_387;
const fullExpectedCensusInputTokens = 58_045_371;
// OpenRouter's pinned Qwen route bills one model special token per input in
// addition to the locally tokenized embedding text.
const fullExpectedProviderInputTokens = 58_301_758;
const expectedProvider = "openrouter";
const expectedUpstreamModel = "qwen/qwen3-embedding-8b";
export const BRIGHT_EMBEDDING_MAX_CONCURRENCY = 16;

type RunMode = "canary" | "full" | "inspect";

type CliOptions = Readonly<{
  concurrency: number;
  mode: RunMode;
  resume: boolean;
}>;

type TaggedEmbeddingInput = KnowledgeBulkEmbeddingPassageIdentity & Readonly<{
  embeddingText: string;
}>;

type RuntimeResponse = Readonly<{
  batchFingerprint: string;
  modelId: string;
  provider: string;
  providerRequestCount: number;
  schemaVersion: 1;
  usage: EmbeddingUsage;
  vectors: readonly (readonly number[])[];
}>;

type CheckpointIdentity = Readonly<{
  datasetManifestFingerprint: string;
  executionSnapshotFingerprint: string;
  importIdentity: string;
  target: KnowledgeBulkEmbeddingTarget;
}>;

type BatchIdentity = CheckpointIdentity & Readonly<{
  batchFingerprint: string;
  batchIndex: number;
  inputCount: number;
  usageEventId: string;
}>;

type BatchJournal = BatchIdentity & Readonly<{
  responseByteSize?: number;
  responseChecksum?: string;
  schemaVersion: 1;
  state: "reserved" | "response_ready";
  updatedAt: string;
}>;

type BatchOutcome = Readonly<{
  batchIndex: number;
  embeddedInputs: number;
  inputCount: number;
  inputTokens: number | null;
  providerDispatched: boolean;
  providerRequestCount: number;
  reused: boolean;
}>;

export type BrightEmbeddingConcurrencyState = Readonly<{
  cleanProviderBatches: number;
  concurrency: number;
}>;

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

export function nextBrightEmbeddingConcurrency(input: Readonly<{
  providerRequestCount: number;
  state: BrightEmbeddingConcurrencyState;
  targetConcurrency: number;
}>): BrightEmbeddingConcurrencyState {
  if (!Number.isSafeInteger(input.providerRequestCount) ||
    input.providerRequestCount < 1 ||
    !Number.isSafeInteger(input.targetConcurrency) ||
    input.targetConcurrency < 1 ||
    input.targetConcurrency > BRIGHT_EMBEDDING_MAX_CONCURRENCY ||
    !Number.isSafeInteger(input.state.concurrency) ||
    input.state.concurrency < 1 ||
    input.state.concurrency > input.targetConcurrency ||
    !Number.isSafeInteger(input.state.cleanProviderBatches) ||
    input.state.cleanProviderBatches < 0) {
    throw new Error("bright_stackoverflow_embedding_concurrency_state_invalid");
  }
  if (input.providerRequestCount > 1) {
    return Object.freeze({
      cleanProviderBatches: 0,
      concurrency: input.state.concurrency <= 2
        ? 1
        : input.state.concurrency <= 4
          ? 2
          : input.state.concurrency <= 8
            ? 4
            : 8
    });
  }
  const cleanProviderBatches = input.state.cleanProviderBatches + 1;
  const threshold = input.state.concurrency <= 2
    ? 8
    : input.state.concurrency <= 4
      ? 24
      : 64;
  if (input.state.concurrency >= input.targetConcurrency ||
    cleanProviderBatches < threshold) {
    return Object.freeze({
      cleanProviderBatches,
      concurrency: input.state.concurrency
    });
  }
  return Object.freeze({
    cleanProviderBatches: 0,
    concurrency: Math.min(input.targetConcurrency, input.state.concurrency * 2)
  });
}

export function parseBrightEmbeddingCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): CliOptions {
  let paidMode: "canary" | "full" | null = null;
  let confirmedTarget = false;
  let inspectOnly = false;
  let resume = false;
  let concurrency: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--confirm-target") {
      if (next !== targetAck) {
        throw new Error("bright_stackoverflow_embedding_target_confirmation_invalid");
      }
      confirmedTarget = true;
      index += 1;
    } else if (argument === "--confirm-paid") {
      if (next !== "CANARY" && next !== "FULL_0_75_USD") {
        throw new Error("bright_stackoverflow_embedding_paid_confirmation_invalid");
      }
      if (paidMode !== null) {
        throw new Error("bright_stackoverflow_embedding_argument_duplicate");
      }
      paidMode = next === "CANARY" ? "canary" : "full";
      index += 1;
    } else if (argument === "--concurrency") {
      const parsed = Number(next);
      if (concurrency !== null || !Number.isSafeInteger(parsed) || parsed < 1 ||
        parsed > BRIGHT_EMBEDDING_MAX_CONCURRENCY) {
        throw new Error("bright_stackoverflow_embedding_concurrency_invalid");
      }
      concurrency = parsed;
      index += 1;
    } else if (argument === "--resume") {
      resume = true;
    } else if (argument === "--inspect-only") {
      inspectOnly = true;
    } else {
      throw new Error("bright_stackoverflow_embedding_argument_unknown");
    }
  }
  const mode: RunMode = inspectOnly ? "inspect" : paidMode ?? "inspect";
  const resolvedConcurrency = concurrency ?? (mode === "full" ? 4 : 1);
  const paidAck = mode === "canary" ? paidCanaryAck : paidFullAck;
  if (!confirmedTarget || environment.AIQSA_BRIGHT_BENCHMARK_ACK !==
    targetEnvironmentAck || inspectOnly && (paidMode !== null || resume) ||
    !inspectOnly && (paidMode === null ||
      environment.AIQSA_BRIGHT_EMBEDDING_ACK !== paidAck) ||
    mode !== "full" && resolvedConcurrency !== 1) {
    throw new Error("bright_stackoverflow_embedding_confirmation_required");
  }
  return Object.freeze({ concurrency: resolvedConcurrency, mode, resume });
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function checkpointPath(importIdentityValue: string): string {
  return resolve(stateRoot, `bright-embedding-${importIdentityValue}.json`);
}

function journalPath(identity: Pick<BatchIdentity, "importIdentity" | "batchIndex">): string {
  return resolve(
    stateRoot,
    `bright-embedding-${identity.importIdentity}-batch-${identity.batchIndex}.json`
  );
}

function responsePath(identity: Pick<BatchIdentity, "importIdentity" | "batchIndex">): string {
  return resolve(
    stateRoot,
    `bright-embedding-${identity.importIdentity}-batch-${identity.batchIndex}.response.json.gz`
  );
}

async function writeAtomic(path: string, body: Buffer | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(stateRoot, { recursive: true });
  await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeOptional(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function serializedTarget(target: KnowledgeBulkEmbeddingTarget): Record<string, unknown> {
  return {
    embeddingProviderModelId: target.embeddingProviderModelId,
    generationId: target.generationId,
    knowledgeBaseId: target.knowledgeBaseId,
    ownerUserId: target.ownerUserId,
    profileRevisionId: target.profileRevisionId,
    targetDimension: target.targetDimension,
    vectorSpaceFingerprint: target.vectorSpaceFingerprint
  };
}

async function readCheckpoint(
  identity: CheckpointIdentity,
  required: boolean
): Promise<number> {
  const body = await readOptional(checkpointPath(identity.importIdentity));
  if (!body) {
    if (required) throw new Error("bright_stackoverflow_embedding_resume_state_missing");
    return 0;
  }
  if (!required) throw new Error("bright_stackoverflow_embedding_resume_required");
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_embedding_resume_state_corrupt");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "datasetManifestFingerprint",
    "executionSnapshotFingerprint",
    "importIdentity",
    "nextBatchIndex",
    "schemaVersion",
    "target",
    "updatedAt"
  ]) || value.schemaVersion !== 1 ||
    value.datasetManifestFingerprint !== identity.datasetManifestFingerprint ||
    value.executionSnapshotFingerprint !== identity.executionSnapshotFingerprint ||
    value.importIdentity !== identity.importIdentity ||
    !isRecord(value.target) ||
    canonicalJson(value.target) !== canonicalJson(serializedTarget(identity.target)) ||
    !Number.isSafeInteger(value.nextBatchIndex) || Number(value.nextBatchIndex) < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("bright_stackoverflow_embedding_resume_state_corrupt");
  }
  return Number(value.nextBatchIndex);
}

async function writeCheckpoint(
  identity: CheckpointIdentity,
  nextBatchIndex: number
): Promise<void> {
  await writeAtomic(checkpointPath(identity.importIdentity), `${JSON.stringify({
    datasetManifestFingerprint: identity.datasetManifestFingerprint,
    executionSnapshotFingerprint: identity.executionSnapshotFingerprint,
    importIdentity: identity.importIdentity,
    nextBatchIndex,
    schemaVersion: 1,
    target: serializedTarget(identity.target),
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

function batchIdentityMatches(value: Record<string, unknown>, input: BatchIdentity): boolean {
  return value.batchFingerprint === input.batchFingerprint &&
    value.batchIndex === input.batchIndex &&
    value.datasetManifestFingerprint === input.datasetManifestFingerprint &&
    value.executionSnapshotFingerprint === input.executionSnapshotFingerprint &&
    value.importIdentity === input.importIdentity &&
    value.inputCount === input.inputCount && value.usageEventId === input.usageEventId &&
    isRecord(value.target) &&
    canonicalJson(value.target) === canonicalJson(serializedTarget(input.target));
}

async function readJournal(input: BatchIdentity): Promise<BatchJournal | null> {
  const body = await readOptional(journalPath(input));
  if (!body) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_embedding_journal_corrupt");
  }
  const commonKeys = [
    "batchFingerprint",
    "batchIndex",
    "datasetManifestFingerprint",
    "executionSnapshotFingerprint",
    "importIdentity",
    "inputCount",
    "schemaVersion",
    "state",
    "target",
    "updatedAt",
    "usageEventId"
  ];
  const expectedKeys = value && isRecord(value) && value.state === "response_ready"
    ? [...commonKeys, "responseByteSize", "responseChecksum"]
    : commonKeys;
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys) ||
    value.schemaVersion !== 1 ||
    (value.state !== "reserved" && value.state !== "response_ready") ||
    !batchIdentityMatches(value, input) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.state === "response_ready" && (
      !Number.isSafeInteger(value.responseByteSize) || Number(value.responseByteSize) < 1 ||
      typeof value.responseChecksum !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.responseChecksum)
    ))) {
    throw new Error("bright_stackoverflow_embedding_journal_corrupt");
  }
  return value as BatchJournal;
}

async function writeJournal(input: BatchJournal): Promise<void> {
  await writeAtomic(journalPath(input), `${JSON.stringify({
    batchFingerprint: input.batchFingerprint,
    batchIndex: input.batchIndex,
    datasetManifestFingerprint: input.datasetManifestFingerprint,
    executionSnapshotFingerprint: input.executionSnapshotFingerprint,
    importIdentity: input.importIdentity,
    inputCount: input.inputCount,
    ...(input.state === "response_ready" ? {
      responseByteSize: input.responseByteSize,
      responseChecksum: input.responseChecksum
    } : {}),
    schemaVersion: 1,
    state: input.state,
    target: serializedTarget(input.target),
    updatedAt: input.updatedAt,
    usageEventId: input.usageEventId
  }, null, 2)}\n`);
}

function validateResponse(
  value: unknown,
  input: BatchIdentity,
  modelId: string,
  provider: string
): RuntimeResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    "batchFingerprint",
    "modelId",
    "provider",
    "providerRequestCount",
    "schemaVersion",
    "usage",
    "vectors"
  ]) || value.schemaVersion !== 1 || value.batchFingerprint !== input.batchFingerprint ||
    value.modelId !== modelId || value.provider !== provider ||
    !Number.isSafeInteger(value.providerRequestCount) ||
    Number(value.providerRequestCount) < 1 || !isRecord(value.usage) ||
    !hasExactKeys(value.usage, ["inputTokens", "totalTokens"]) ||
    !(value.usage.inputTokens === null || Number.isSafeInteger(value.usage.inputTokens) &&
      Number(value.usage.inputTokens) >= 0) ||
    !(value.usage.totalTokens === null || Number.isSafeInteger(value.usage.totalTokens) &&
      Number(value.usage.totalTokens) >= 0) || !Array.isArray(value.vectors) ||
    value.vectors.length !== input.inputCount || value.vectors.some((vector) =>
      !Array.isArray(vector) || vector.length !== input.target.targetDimension ||
      vector.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)))) {
    throw new Error("bright_stackoverflow_embedding_response_corrupt");
  }
  return value as unknown as RuntimeResponse;
}

async function readResponse(
  input: BatchIdentity,
  modelId: string,
  provider: string,
  journal: BatchJournal
): Promise<RuntimeResponse | null> {
  const body = await readOptional(responsePath(input));
  if (!body) return null;
  if (journal.state === "response_ready" &&
    (body.byteLength !== journal.responseByteSize || sha256(body) !== journal.responseChecksum)) {
    throw new Error("bright_stackoverflow_embedding_response_corrupt");
  }
  let value: unknown;
  try {
    value = JSON.parse((await gunzip(body)).toString("utf8")) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_embedding_response_corrupt");
  }
  return validateResponse(value, input, modelId, provider);
}

async function persistResponse(
  input: BatchIdentity,
  response: RuntimeResponse
): Promise<Readonly<{ byteSize: number; checksum: string }>> {
  const body = await gzip(Buffer.from(JSON.stringify(response), "utf8"));
  await writeAtomic(responsePath(input), body);
  return Object.freeze({ byteSize: body.byteLength, checksum: sha256(body) });
}

async function assertFullCensusAuthority(input: Readonly<{
  datasetManifestFingerprint: string;
  profile: ActiveImportProfile;
  tokenCounter: KnowledgeTokenCounter;
}>): Promise<void> {
  const modelHash = sha256(input.profile.upstreamModelId).slice(0, 16);
  const path = resolve(preparedRoot, `product-census-${modelHash}.json`);
  let value: unknown;
  try {
    value = JSON.parse((await readFile(path)).toString("utf8")) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_embedding_census_invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "batching",
    "corpus",
    "datasetManifestFingerprint",
    "execution",
    "productFingerprint",
    "profile",
    "reportFingerprint",
    "schemaVersion"
  ]) || value.schemaVersion !== 1 || !isRecord(value.batching) ||
    !isRecord(value.corpus) || !isRecord(value.profile) ||
    typeof value.reportFingerprint !== "string") {
    throw new Error("bright_stackoverflow_embedding_census_invalid");
  }
  const { reportFingerprint, ...reportBody } = value;
  const profileIdentity = sha256(canonicalJson({
    chunkingProfileVersion: input.profile.chunkingProfileVersion,
    tokenizer: input.tokenCounter.identity
  }));
  const estimatedUsd = fullExpectedProviderInputTokens / 1_000_000 *
    fullInputPriceUsdPerMillion;
  if (!/^[0-9a-f]{64}$/u.test(reportFingerprint) ||
    sha256(canonicalJson(reportBody)) !== reportFingerprint ||
    value.datasetManifestFingerprint !== input.datasetManifestFingerprint ||
    value.batching.crossSourceProviderRequestCount !== fullExpectedBatchCount ||
    value.corpus.documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    value.corpus.passageCount !== fullExpectedInputCount ||
    value.corpus.embeddingInputTokens !== fullExpectedCensusInputTokens ||
    value.profile.embeddingModel !== input.profile.upstreamModelId ||
    value.profile.chunkingProfileVersion !== input.profile.chunkingProfileVersion ||
    value.profile.profileIdentity !== profileIdentity ||
    value.profile.tokenizerIdentity !== input.profile.tokenizerIdentity ||
    estimatedUsd > fullAuthorizedMaximumUsd) {
    throw new Error("bright_stackoverflow_embedding_census_mismatch");
  }
}

type EmbeddingRunLock = Readonly<{
  release(): Promise<void>;
}>;

async function acquireEmbeddingRunLock(
  databaseUrl: string,
  importIdentityValue: string
): Promise<EmbeddingRunLock> {
  const key = Buffer.from(sha256(`bright-embedding:${importIdentityValue}`), "hex");
  const first = key.readInt32BE(0);
  const second = key.readInt32BE(4);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [first, second]
    );
    acquired = result.rows.length === 1 && result.rows[0]?.acquired === true;
    if (!acquired) {
      throw new Error("bright_stackoverflow_embedding_already_running");
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  return Object.freeze({
    release: async () => {
      try {
        if (acquired) {
          await client.query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer)",
            [first, second]
          );
          acquired = false;
        }
      } finally {
        await client.end();
      }
    }
  });
}

async function assertFullSettlement(input: Readonly<{
  prisma: PrismaClient;
  target: KnowledgeBulkEmbeddingTarget;
  usageEventIds: readonly string[];
}>): Promise<Readonly<{
  artifactCount: number;
  embeddingCount: number;
  inputTokens: number;
  passageCount: number;
  usageEventCount: number;
}>> {
  if (input.usageEventIds.length !== fullExpectedBatchCount ||
    new Set(input.usageEventIds).size !== input.usageEventIds.length) {
    throw new Error("bright_stackoverflow_embedding_usage_plan_mismatch");
  }
  const [rows, usage] = await Promise.all([
    input.prisma.$queryRaw<Array<{
      artifactCount: number;
      chunkCount: number;
      embeddedArtifactCount: number;
      embeddingCount: number;
      passageCount: number;
    }>>(Prisma.sql`
      WITH scoped_artifacts AS (
        SELECT DISTINCT
          artifact."id",
          artifact."chunkCount",
          artifact."embeddedPassageCount"
        FROM "KnowledgeBaseSource" AS membership
        INNER JOIN "KnowledgeSource" AS source
          ON source."id" = membership."sourceId"
         AND source."ownerUserId" = membership."ownerUserId"
        INNER JOIN "KnowledgeSourceVersion" AS version
          ON version."sourceId" = source."id"
         AND version."ownerUserId" = source."ownerUserId"
         AND (source."pendingVersionId" = version."id" OR
              source."currentVersionId" = version."id")
        INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
          ON artifact."sourceVersionId" = version."id"
         AND artifact."profileRevisionId" = ${input.target.profileRevisionId}
        WHERE membership."knowledgeBaseId" = ${input.target.knowledgeBaseId}
          AND membership."ownerUserId" = ${input.target.ownerUserId}
          AND membership."removedAt" IS NULL
      ), scoped_passages AS (
        SELECT passage."id", passage."indexArtifactId", passage."embeddingTextHash"
        FROM scoped_artifacts AS artifact
        INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          ON hierarchy."sourceArtifactId" = artifact."id"
         AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."indexArtifactId" = hierarchy."id"
      )
      SELECT
        (SELECT count(*)::integer FROM scoped_artifacts) AS "artifactCount",
        (SELECT coalesce(sum("chunkCount"), 0)::integer
           FROM scoped_artifacts) AS "chunkCount",
        (SELECT coalesce(sum("embeddedPassageCount"), 0)::integer
           FROM scoped_artifacts) AS "embeddedArtifactCount",
        (SELECT count(*)::integer FROM scoped_passages) AS "passageCount",
        (SELECT count(*)::integer
           FROM scoped_passages AS passage
           INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
             ON embedding."indexArtifactId" = passage."indexArtifactId"
            AND embedding."passageId" = passage."id"
            AND embedding."embeddingDimension" = ${input.target.targetDimension}
            AND btrim(embedding."embeddingTextHash") =
                btrim(passage."embeddingTextHash")) AS "embeddingCount"
    `),
    input.prisma.usageEvent.aggregate({
      _count: { id: true },
      _sum: { inputTokens: true, totalTokens: true },
      where: {
        id: { in: [...input.usageEventIds] },
        modelId: expectedUpstreamModel,
        provider: expectedProvider,
        userId: input.target.ownerUserId
      }
    })
  ]);
  const row = rows[0];
  if (rows.length !== 1 || !row ||
    row.artifactCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    row.chunkCount !== fullExpectedInputCount ||
    row.embeddedArtifactCount !== fullExpectedInputCount ||
    row.passageCount !== fullExpectedInputCount ||
    row.embeddingCount !== fullExpectedInputCount ||
    usage._count.id !== fullExpectedBatchCount ||
    usage._sum.inputTokens !== fullExpectedProviderInputTokens ||
    usage._sum.totalTokens !== fullExpectedProviderInputTokens) {
    throw new Error("bright_stackoverflow_embedding_full_settlement_mismatch");
  }
  return Object.freeze({
    artifactCount: row.artifactCount,
    embeddingCount: row.embeddingCount,
    inputTokens: usage._sum.inputTokens,
    passageCount: row.passageCount,
    usageEventCount: usage._count.id
  });
}

function fingerprintBatch(
  checkpoint: CheckpointIdentity,
  batchIndex: number,
  inputs: readonly TaggedEmbeddingInput[]
): string {
  return sha256(canonicalJson({
    batchIndex,
    executionSnapshotFingerprint: checkpoint.executionSnapshotFingerprint,
    importIdentity: checkpoint.importIdentity,
    inputs: inputs.map((input) => ({
      contentHash: input.contentHash,
      embeddingTextHash: input.embeddingTextHash,
      passageId: input.passageId,
      passageOrdinal: input.passageOrdinal,
      sourceArtifactId: input.sourceArtifactId,
      sourceVersionId: input.sourceVersionId
    })),
    target: serializedTarget(checkpoint.target)
  }));
}

async function main(): Promise<void> {
  const options = parseBrightEmbeddingCli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("bright_stackoverflow_embedding_target_environment_missing");
  }
  const manifest = await verifyBrightPreparedDataset(preparedRoot);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  let runLock: EmbeddingRunLock | null = null;
  let stopRequested = false;
  let signalHandler: (() => void) | null = null;
  try {
    await assertDatabaseIdentity(prisma);
    const ownerUserId = await ensureBenchmarkOwner(prisma);
    const profile = await activeImportProfile(prisma, ownerUserId);
    if (profile.upstreamModelId !== expectedUpstreamModel) {
      throw new Error("bright_stackoverflow_embedding_model_mismatch");
    }
    const identity = importIdentity(manifest.manifestFingerprint, profile);
    runLock = await acquireEmbeddingRunLock(databaseUrl, identity);
    const { baseId, generationId } = await ensureBenchmarkBase({
      importIdentity: identity,
      ownerUserId,
      prisma,
      profile
    });
    const revision = await prisma.knowledgeIndexProfileRevision.findUnique({
      select: { executionAuthority: true },
      where: { id: profile.profileRevisionId }
    });
    if (revision?.executionAuthority !== "installation") {
      throw new Error("bright_stackoverflow_embedding_authority_mismatch");
    }
    const binding = await createPrismaEmbeddingRuntime(prisma)
      .resolveForInstallation({ providerModelId: profile.embeddingProviderModelId });
    const pin = createKnowledgeVectorSpacePin({
      configuration: binding.configuration,
      deploymentId: binding.providerModelId
    });
    if (binding.provider !== expectedProvider ||
      binding.providerModelId !== profile.embeddingProviderModelId ||
      binding.configuration.upstreamModelId !== profile.upstreamModelId || !pin ||
      !pin.indexSupported || pin.fingerprint !== profile.vectorSpaceFingerprint ||
      pin.targetDimension !== profile.targetDimension) {
      throw new Error("bright_stackoverflow_embedding_runtime_mismatch");
    }
    const target = Object.freeze({
      embeddingProviderModelId: profile.embeddingProviderModelId,
      generationId,
      knowledgeBaseId: baseId,
      ownerUserId,
      profileRevisionId: profile.profileRevisionId,
      targetDimension: profile.targetDimension,
      vectorSpaceFingerprint: profile.vectorSpaceFingerprint
    });
    const checkpointIdentity = Object.freeze({
      datasetManifestFingerprint: manifest.manifestFingerprint,
      executionSnapshotFingerprint: sha256(canonicalJson(binding.executionSnapshot)),
      importIdentity: identity,
      target
    });
    const tokenCounter = requireKnowledgeTokenCounter(profile.upstreamModelId);
    if (options.mode === "full") {
      await assertFullCensusAuthority({
        datasetManifestFingerprint: manifest.manifestFingerprint,
        profile,
        tokenCounter
      });
      emit("bright_stackoverflow_embedding_full_authorized", {
        expectedBatchCount: fullExpectedBatchCount,
        expectedInputCount: fullExpectedInputCount,
        expectedCensusInputTokens: fullExpectedCensusInputTokens,
        expectedProviderInputTokens: fullExpectedProviderInputTokens,
        maximumAuthorizedUsd: fullAuthorizedMaximumUsd,
        targetConcurrency: options.concurrency
      });
    }
    const nextBatchIndex = options.mode === "inspect"
      ? 0
      : await readCheckpoint(checkpointIdentity, options.resume);
    const batchLimit = options.mode === "full"
      ? fullExpectedBatchCount
      : canaryBatchLimit;
    if (nextBatchIndex > batchLimit) {
      throw new Error("bright_stackoverflow_embedding_resume_state_corrupt");
    }
    if (options.mode === "canary" && nextBatchIndex >= canaryBatchLimit) {
      emit("bright_stackoverflow_embedding_canary_complete", {
        embeddedInputs: 0,
        providerRequests: 0,
        resumed: options.resume,
        settledBatches: 0
      });
      return;
    }

    const repository = createPrismaKnowledgeBulkEmbeddingRepository(prisma);
    const accumulator = createKnowledgeEmbeddingBatchAccumulator<TaggedEmbeddingInput>(
      profile.chunkingProfileVersion,
      tokenCounter
    );
    let batchIndex = 0;
    let embeddedInputs = 0;
    let plannedInputs = 0;
    let providerRequests = 0;
    let providerInputTokens = 0;
    let reusedBatches = 0;
    let settledBatches = 0;
    const startedAt = performance.now();
    const expectedUsageEventIds: string[] = [];
    const settledIndexes = new Set<number>();
    let checkpointFrontier = nextBatchIndex;
    let checkpointTail = Promise.resolve();
    let concurrencyState: BrightEmbeddingConcurrencyState = Object.freeze({
      cleanProviderBatches: 0,
      concurrency: options.mode === "full"
        ? Math.min(2, options.concurrency)
        : 1
    });
    const inFlight = new Set<Promise<void>>();
    let fatalError: unknown = null;

    const recordSettled = (settledBatchIndex: number): Promise<void> => {
      const operation = checkpointTail.then(async () => {
        if (settledBatchIndex < checkpointFrontier) return;
        settledIndexes.add(settledBatchIndex);
        const previousFrontier = checkpointFrontier;
        while (settledIndexes.delete(checkpointFrontier)) {
          checkpointFrontier += 1;
        }
        if (checkpointFrontier > previousFrontier) {
          await writeCheckpoint(checkpointIdentity, checkpointFrontier);
        }
      });
      checkpointTail = operation;
      return operation;
    };

    const shouldEmitBatch = (currentBatchIndex: number): boolean =>
      currentBatchIndex < 10 || (currentBatchIndex + 1) % 25 === 0;

    const processBatch = async (
      batch: readonly TaggedEmbeddingInput[],
      currentBatchIndex: number,
      batchIdentity: BatchIdentity
    ): Promise<BatchOutcome> => {
      const status = await repository.inspectBatch({
        ...target,
        now: new Date(),
        passages: batch
      });
      if (options.mode === "inspect") {
        emit("bright_stackoverflow_embedding_canary_inspection", {
          completeInputs: status.completeIndexes.length,
          inputCount: batch.length,
          missingInputs: status.missingIndexes.length,
          providerRequests: 0
        });
        return Object.freeze({
          batchIndex: currentBatchIndex,
          embeddedInputs: 0,
          inputCount: batch.length,
          inputTokens: null,
          providerDispatched: false,
          providerRequestCount: 0,
          reused: status.missingIndexes.length === 0
        });
      }
      if (status.completeIndexes.length > 0 && status.missingIndexes.length > 0) {
        throw new Error("bright_stackoverflow_embedding_partial_settlement");
      }
      if (status.missingIndexes.length === 0) {
        await removeOptional(journalPath({ batchIndex: currentBatchIndex, importIdentity: identity }));
        await removeOptional(responsePath({ batchIndex: currentBatchIndex, importIdentity: identity }));
        await recordSettled(currentBatchIndex);
        return Object.freeze({
          batchIndex: currentBatchIndex,
          embeddedInputs: 0,
          inputCount: batch.length,
          inputTokens: null,
          providerDispatched: false,
          providerRequestCount: 0,
          reused: true
        });
      }
      let journal = await readJournal(batchIdentity);
      let response: RuntimeResponse | null = null;
      let providerDispatched = false;
      if (journal) {
        response = await readResponse(
          batchIdentity,
          profile.upstreamModelId,
          binding.provider,
          journal
        );
        if (!response) {
          throw new Error("bright_stackoverflow_embedding_outcome_ambiguous");
        }
      } else {
        if (await readOptional(responsePath(batchIdentity))) {
          throw new Error("bright_stackoverflow_embedding_response_orphaned");
        }
        journal = Object.freeze({
          ...batchIdentity,
          schemaVersion: 1 as const,
          state: "reserved" as const,
          updatedAt: new Date().toISOString()
        });
        await writeJournal(journal);
        if (shouldEmitBatch(currentBatchIndex)) {
          emit("bright_stackoverflow_embedding_dispatch", {
            batchIndex: currentBatchIndex,
            concurrency: concurrencyState.concurrency,
            inputCount: batch.length,
            maxBatchInputs: 64,
            maxBatchTokens: 16_000,
            mode: options.mode
          });
        }
        providerDispatched = true;
        const result = await binding.adapter.embed({
          latencyClass: "background",
          mode: "document",
          texts: batch.map(({ embeddingText }) => embeddingText)
        });
        response = validateResponse({
          batchFingerprint: batchIdentity.batchFingerprint,
          modelId: profile.upstreamModelId,
          provider: binding.provider,
          providerRequestCount: result.providerRequestCount ?? 1,
          schemaVersion: 1,
          usage: result.usage,
          vectors: result.vectors
        }, batchIdentity, profile.upstreamModelId, binding.provider);
        const stored = await persistResponse(batchIdentity, response);
        journal = Object.freeze({
          ...batchIdentity,
          responseByteSize: stored.byteSize,
          responseChecksum: stored.checksum,
          schemaVersion: 1 as const,
          state: "response_ready" as const,
          updatedAt: new Date().toISOString()
        });
        await writeJournal(journal);
      }
      if (options.mode === "full" && (response.usage.inputTokens === null ||
        response.usage.totalTokens === null)) {
        throw new Error("bright_stackoverflow_embedding_usage_missing");
      }
      const writes: KnowledgeBulkEmbeddingPassageWrite[] = batch.map((input, index) => ({
        ...input,
        vector: response!.vectors[index]!
      }));
      await repository.persistBatch({
        ...target,
        modelId: response.modelId,
        now: new Date(),
        passages: writes,
        provider: response.provider,
        usage: response.usage,
        usageEventId: batchIdentity.usageEventId
      });
      await removeOptional(responsePath(batchIdentity));
      await removeOptional(journalPath(batchIdentity));
      await recordSettled(currentBatchIndex);
      return Object.freeze({
        batchIndex: currentBatchIndex,
        embeddedInputs: batch.length,
        inputCount: batch.length,
        inputTokens: response.usage.inputTokens,
        providerDispatched,
        providerRequestCount: response.providerRequestCount,
        reused: false
      });
    };

    const observeOutcome = (outcome: BatchOutcome): void => {
      embeddedInputs += outcome.embeddedInputs;
      settledBatches += 1;
      if (outcome.reused) reusedBatches += 1;
      if (outcome.providerDispatched) {
        providerRequests += outcome.providerRequestCount;
        providerInputTokens += outcome.inputTokens ?? 0;
        const previous = concurrencyState;
        concurrencyState = nextBrightEmbeddingConcurrency({
          providerRequestCount: outcome.providerRequestCount,
          state: concurrencyState,
          targetConcurrency: options.concurrency
        });
        if (concurrencyState.concurrency !== previous.concurrency) {
          emit("bright_stackoverflow_embedding_concurrency_changed", {
            batchIndex: outcome.batchIndex,
            from: previous.concurrency,
            providerRequestCount: outcome.providerRequestCount,
            to: concurrencyState.concurrency
          });
        }
      }
      if (shouldEmitBatch(outcome.batchIndex) || outcome.providerRequestCount > 1) {
        emit("bright_stackoverflow_embedding_progress", {
          batchIndex: outcome.batchIndex,
          checkpointFrontier,
          concurrency: concurrencyState.concurrency,
          elapsedMs: Math.round(performance.now() - startedAt),
          embeddedInputs,
          inputCount: outcome.inputCount,
          inputTokens: outcome.inputTokens,
          providerRequests,
          reusedBatches,
          settledBatches
        });
      }
    };

    const scheduleBatch = (
      batch: readonly TaggedEmbeddingInput[],
      currentBatchIndex: number,
      batchIdentity: BatchIdentity
    ): void => {
      let task: Promise<void>;
      task = processBatch(batch, currentBatchIndex, batchIdentity)
        .then(observeOutcome)
        .catch((error: unknown) => {
          fatalError ??= error;
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    };

    const waitForCapacity = async (): Promise<boolean> => {
      while (inFlight.size >= concurrencyState.concurrency) {
        await Promise.race(inFlight);
        if (fatalError || stopRequested) return false;
      }
      return !fatalError && !stopRequested;
    };

    const acceptBatch = async (
      batch: readonly TaggedEmbeddingInput[] | null
    ): Promise<boolean> => {
      if (!batch) return true;
      const currentBatchIndex = batchIndex;
      if (currentBatchIndex >= batchLimit) {
        throw new Error("bright_stackoverflow_embedding_batch_count_mismatch");
      }
      batchIndex += 1;
      plannedInputs += batch.length;
      const batchFingerprint = fingerprintBatch(
        checkpointIdentity,
        currentBatchIndex,
        batch
      );
      const batchIdentity = Object.freeze({
        ...checkpointIdentity,
        batchFingerprint,
        batchIndex: currentBatchIndex,
        inputCount: batch.length,
        usageEventId: brightDeterministicUuid(
          "embedding-usage",
          identity,
          String(currentBatchIndex),
          batchFingerprint
        )
      });
      expectedUsageEventIds.push(batchIdentity.usageEventId);
      if (options.mode === "inspect") {
        observeOutcome(await processBatch(batch, currentBatchIndex, batchIdentity));
        return false;
      }
      if (currentBatchIndex < nextBatchIndex) {
        await removeOptional(journalPath(batchIdentity));
        await removeOptional(responsePath(batchIdentity));
        return true;
      }
      if (!await waitForCapacity()) return false;
      scheduleBatch(batch, currentBatchIndex, batchIdentity);
      return true;
    };

    if (options.mode === "full") {
      signalHandler = () => {
        if (stopRequested) return;
        stopRequested = true;
        emit("bright_stackoverflow_embedding_stop_requested", {
          checkpointFrontier,
          inFlight: inFlight.size
        });
      };
      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
      emit("bright_stackoverflow_embedding_concurrency_changed", {
        batchIndex: nextBatchIndex,
        from: 0,
        providerRequestCount: 0,
        to: concurrencyState.concurrency
      });
    }

    let traversalComplete = true;
    outer: for await (const document of selectedDocuments(
      0,
      BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
      manifest.corpus.shards
    )) {
      const plan = buildStagePlan({
        document,
        importIdentity: identity,
        ownerUserId,
        profile
      });
      for (const chunk of plan.productPlan.chunks) {
        const passage = plan.productPlan.hierarchicalIndex.passages[chunk.index];
        if (!passage || passage.ordinal !== chunk.index ||
          passage.contentHash !== chunk.contentHash ||
          passage.embeddingTextHash !== chunk.embeddingTextHash) {
          throw new Error("bright_stackoverflow_embedding_plan_mismatch");
        }
        const completed = accumulator.push(Object.freeze({
          contentHash: chunk.contentHash,
          embeddingText: chunk.embeddingText,
          embeddingTextHash: chunk.embeddingTextHash,
          passageId: passage.id,
          passageOrdinal: passage.ordinal,
          sourceArtifactId: plan.source.artifactId,
          sourceVersionId: plan.source.sourceVersionId
        }));
        if (completed && !await acceptBatch(completed)) {
          traversalComplete = false;
          break outer;
        }
        if (options.mode !== "full" && batchIndex >= canaryBatchLimit ||
          fatalError || stopRequested) {
          traversalComplete = false;
          break outer;
        }
      }
    }
    if (traversalComplete) {
      await acceptBatch(accumulator.finish());
    }
    await Promise.all(inFlight);
    await checkpointTail;
    if (fatalError) throw fatalError;
    if (stopRequested) {
      emit("bright_stackoverflow_embedding_full_paused", {
        checkpointFrontier,
        elapsedMs: Math.round(performance.now() - startedAt),
        embeddedInputs,
        providerInputTokens,
        providerRequests,
        settledBatches
      });
      return;
    }
    if (options.mode === "inspect") {
      emit("bright_stackoverflow_embedding_canary_inspection_complete", {
        embeddedInputs,
        elapsedMs: Math.round(performance.now() - startedAt),
        providerRequests,
        resumed: options.resume,
        settledBatches
      });
      return;
    }
    if (options.mode === "canary") {
      emit("bright_stackoverflow_embedding_canary_complete", {
        embeddedInputs,
        elapsedMs: Math.round(performance.now() - startedAt),
        providerRequests,
        resumed: options.resume,
        settledBatches
      });
      return;
    }
    if (!traversalComplete || batchIndex !== fullExpectedBatchCount ||
      plannedInputs !== fullExpectedInputCount ||
      checkpointFrontier !== fullExpectedBatchCount ||
      expectedUsageEventIds.length !== fullExpectedBatchCount) {
      throw new Error("bright_stackoverflow_embedding_full_plan_mismatch");
    }
    const settlement = await assertFullSettlement({
      prisma,
      target,
      usageEventIds: expectedUsageEventIds
    });
    emit("bright_stackoverflow_embedding_full_complete", {
      ...settlement,
      batchCount: fullExpectedBatchCount,
      elapsedMs: Math.round(performance.now() - startedAt),
      embeddedInputs,
      maximumConcurrency: options.concurrency,
      providerInputTokens,
      providerRequests,
      resumed: options.resume,
      reusedBatches,
      settledBatches
    });
  } finally {
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    try {
      if (runLock) await runLock.release();
    } finally {
      await prisma.$disconnect();
    }
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(?:bright_stackoverflow_embedding_|knowledge_bulk_embedding_)[a-z0-9_.:-]+$/u
    .test(message)
    ? message
    : "bright_stackoverflow_embedding_failed";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: safeFailure(error),
      event: "bright_stackoverflow_embedding_failed"
    })}\n`);
    process.exitCode = 1;
  });
}

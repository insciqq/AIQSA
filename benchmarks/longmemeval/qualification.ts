import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_ORACLE_SHA256,
  LONGMEMEVAL_QUESTION_TYPES,
  LONGMEMEVAL_REPOSITORY_COMMIT,
  LONGMEMEVAL_S_SHA256,
  type LongMemEvalCase
} from "./contract";

export const LONGMEMEVAL_QUALIFICATION_MANIFEST_IDS = [
  "fu09-blind-50-v1",
  "fu2-reader-first-blind-50-v1",
  "fu2-reader-first-blind-50-v2"
] as const;

export type LongMemEvalQualificationManifestId =
  (typeof LONGMEMEVAL_QUALIFICATION_MANIFEST_IDS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const categoryCountsSchema = z.object({
  "knowledge-update": z.number().int().nonnegative(),
  "multi-session": z.number().int().nonnegative(),
  "single-session-assistant": z.number().int().nonnegative(),
  "single-session-preference": z.number().int().nonnegative(),
  "single-session-user": z.number().int().nonnegative(),
  "temporal-reasoning": z.number().int().nonnegative()
}).strict();

const selectionSchema = z.object({
  algorithm: z.literal("sha256(seed\\0questionType\\0questionId)"),
  cases: z.array(z.object({
    questionId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/u),
    questionType: z.enum(LONGMEMEVAL_QUESTION_TYPES)
  }).strict()).length(50),
  categoryPopulation: categoryCountsSchema,
  priorRunExclusion: z.object({
    count: z.literal(11),
    questionIdDigest: sha256Schema
  }).strict(),
  questionIdDigest: sha256Schema,
  quotas: categoryCountsSchema,
  seed: z.literal("aiqsa-memory-followup-fu09-blind-50-v1")
}).strict();

const legacyManifestSchema = z.object({
  id: z.literal("fu09-blind-50-v1"),
  profile: z.literal("official"),
  runtime: z.object({
    caseConcurrency: z.literal(1),
    debugMemory: z.literal(false),
    embedding: z.object({
      provider: z.literal("OpenRouter"),
      upstreamModelId: z.literal("qwen/qwen3-embedding-8b")
    }).strict(),
    forceDreamDiagnostic: z.literal(false),
    indexTimeoutMinutes: z.literal(45),
    reranker: z.object({
      provider: z.literal("OpenRouter"),
      upstreamModelId: z.literal("qwen/qwen3-reranker-8b")
    }).strict(),
    runTimeoutMinutes: z.literal(15),
    sessionConcurrency: z.literal(8),
    systemModel: z.object({
      provider: z.literal("codex-lb"),
      reasoningEffort: z.literal("medium"),
      upstreamModelId: z.literal("gpt-5.6-luna")
    }).strict(),
    workerConcurrency: z.object({
      global: z.literal(8),
      perUser: z.literal(4)
    }).strict()
  }).strict(),
  selection: selectionSchema,
  source: z.object({
    appCommit: z.literal("85e5b9db9c2ee1835b8e9cc14246b9dbb1587256"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict(),
  version: z.literal(1)
}).strict();

const readerFirstManifestV1Schema = z.object({
  id: z.literal("fu2-reader-first-blind-50-v1"),
  profile: z.literal("official"),
  runtime: z.object({
    caseConcurrency: z.literal(2),
    debugMemory: z.literal(false),
    embedding: z.object({
      provider: z.literal("OpenRouter"),
      upstreamModelId: z.literal("qwen/qwen3-embedding-8b")
    }).strict(),
    forceDreamDiagnostic: z.literal(false),
    indexTimeoutMinutes: z.literal(45),
    reranker: z.object({
      policyVersion: z.literal("openrouter-reranker-route-v1"),
      provider: z.literal("OpenRouter"),
      route: z.tuple([
        z.object({
          relevanceScoreFloor: z.null(),
          upstreamModelId: z.literal("voyageai/rerank-2.5")
        }).strict(),
        z.object({
          relevanceScoreFloor: z.null(),
          upstreamModelId: z.literal("cohere/rerank-4-pro")
        }).strict(),
        z.object({
          relevanceScoreFloor: z.literal(0.01),
          upstreamModelId: z.literal("qwen/qwen3-reranker-8b")
        }).strict()
      ])
    }).strict(),
    runTimeoutMinutes: z.literal(15),
    sessionConcurrency: z.literal(16),
    systemModel: z.object({
      provider: z.literal("codex-lb"),
      reasoningEffort: z.literal("medium"),
      upstreamModelId: z.literal("gpt-5.6-luna")
    }).strict(),
    workerConcurrency: z.object({
      global: z.literal(8),
      perUser: z.literal(4)
    }).strict()
  }).strict(),
  selection: selectionSchema,
  source: z.object({
    appCommit: z.literal("b0a8f387962592fd70d8a23dd18b31b04a12f8be"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict(),
  version: z.literal(1)
}).strict();

const readerFirstManifestV2Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v2"),
  source: z.object({
    appCommit: z.literal("0f57ee307de10173b291984c58dc02b8b48580fe"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const manifestSchema = z.discriminatedUnion("id", [
  legacyManifestSchema,
  readerFirstManifestV1Schema,
  readerFirstManifestV2Schema
]);

export type LongMemEvalQualificationManifest = Readonly<
  z.infer<typeof manifestSchema>
>;

function questionIdDigest(seed: string, questionIds: readonly string[]): string {
  return createHash("sha256")
    .update(seed, "utf8")
    .update("\u0000", "utf8")
    .update(questionIds.join("\u0000"), "utf8")
    .digest("hex");
}

export function decodeLongMemEvalQualificationManifest(
  value: unknown
): LongMemEvalQualificationManifest {
  const manifest = manifestSchema.parse(value);
  const ids = manifest.selection.cases.map(({ questionId }) => questionId);
  if (new Set(ids).size !== ids.length ||
    questionIdDigest(manifest.selection.seed, ids) !==
      manifest.selection.questionIdDigest) {
    throw new Error("longmemeval_qualification_manifest_invalid");
  }
  for (const questionType of LONGMEMEVAL_QUESTION_TYPES) {
    const count = manifest.selection.cases.filter((entry) =>
      entry.questionType === questionType
    ).length;
    if (count !== manifest.selection.quotas[questionType]) {
      throw new Error("longmemeval_qualification_manifest_invalid");
    }
  }
  return Object.freeze(manifest);
}

export function decodeLongMemEvalQualificationManifestId(
  value: unknown
): LongMemEvalQualificationManifestId {
  if (typeof value === "string" &&
    (LONGMEMEVAL_QUALIFICATION_MANIFEST_IDS as readonly string[]).includes(value)) {
    return value as LongMemEvalQualificationManifestId;
  }
  throw new Error("longmemeval_qualification_manifest_id_invalid");
}

export async function loadLongMemEvalQualificationManifest(
  id: LongMemEvalQualificationManifestId
): Promise<LongMemEvalQualificationManifest> {
  const root = dirname(fileURLToPath(import.meta.url));
  const bytes = await readFile(resolve(root, "qualifications", `${id}.json`), "utf8");
  return decodeLongMemEvalQualificationManifest(JSON.parse(bytes) as unknown);
}

export function assertLongMemEvalQualificationDataset(
  manifest: LongMemEvalQualificationManifest,
  dataset: readonly Pick<LongMemEvalCase, "questionId" | "questionType">[]
): void {
  const byId = new Map(dataset.map((entry) => [entry.questionId, entry.questionType]));
  if (manifest.selection.cases.some(({ questionId, questionType }) =>
    byId.get(questionId) !== questionType)) {
    throw new Error("longmemeval_qualification_manifest_dataset_mismatch");
  }
}

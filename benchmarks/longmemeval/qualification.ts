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
  "fu2-reader-first-blind-50-v2",
  "fu2-reader-first-blind-50-v3",
  "fu2-reader-first-blind-50-v4",
  "fu2-reader-first-blind-50-v5",
  "fu2-reader-first-blind-50-v6",
  "fu2-reader-first-blind-50-v7",
  "fu2-reader-first-blind-50-v8",
  "fu2-reader-first-blind-50-v9",
  "fu2-reader-first-blind-50-v10",
  "fu2-reader-first-blind-50-v11",
  "fu2-reader-first-blind-50-v12",
  "fu2-reader-first-blind-50-v13",
  "fu2-reader-first-blind-50-v14",
  "fu2-reader-first-blind-50-v15",
  "fu2-reader-first-blind-50-v16",
  "fu2-reader-first-luna-25-v17",
  "fu2-reader-first-luna-25-v18",
  "fu2-reader-first-luna-25-v19"
] as const;

export type LongMemEvalQualificationManifestId =
  (typeof LONGMEMEVAL_QUALIFICATION_MANIFEST_IDS)[number];

export const LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_IDS = [
  "fu2-reader-first-luna-25-v19"
] as const satisfies readonly LongMemEvalQualificationManifestId[];

/** Compatibility alias for callers that display one active manifest. */
export const LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_ID =
  LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_IDS[0];

export function isLongMemEvalActiveQualificationManifest(
  id: string
): boolean {
  return (LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_IDS as readonly string[])
    .includes(id);
}

export function longMemEvalEvaluationRequiresStop(
  failFast: boolean,
  label: boolean
): boolean {
  return failFast && !label;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const categoryCountsSchema = z.object({
  "knowledge-update": z.number().int().nonnegative(),
  "multi-session": z.number().int().nonnegative(),
  "single-session-assistant": z.number().int().nonnegative(),
  "single-session-preference": z.number().int().nonnegative(),
  "single-session-user": z.number().int().nonnegative(),
  "temporal-reasoning": z.number().int().nonnegative()
}).strict();

const selectionCaseSchema = z.object({
  questionId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/u),
  questionType: z.enum(LONGMEMEVAL_QUESTION_TYPES)
}).strict();

const selectionSchema = z.object({
  algorithm: z.literal("sha256(seed\\0questionType\\0questionId)"),
  cases: z.array(selectionCaseSchema).length(50),
  categoryPopulation: categoryCountsSchema,
  priorRunExclusion: z.object({
    count: z.literal(11),
    questionIdDigest: sha256Schema
  }).strict(),
  questionIdDigest: sha256Schema,
  quotas: categoryCountsSchema,
  seed: z.literal("aiqsa-memory-followup-fu09-blind-50-v1")
}).strict();

const selection25Schema = selectionSchema.extend({
  cases: z.array(selectionCaseSchema).length(25)
}).strict();

const measuredMemoryAdmissionSchema = z.object({
  controlMaximumMs: z.literal(20_000),
  hardDeadlineMs: z.literal(26_000),
  queryResolverMaximumMs: z.literal(20_000),
  queryResolverSettlementReserveMs: z.literal(2_000),
  softDeadlineMs: z.literal(20_000),
  version: z.literal("memory-run-retrieval-admission-v54")
}).strict();

const deterministicReadMemoryAdmissionSchema = measuredMemoryAdmissionSchema.extend({
  readUtilityPolicy: z.literal("DETERMINISTIC_READ_V1")
}).strict();

const productionReadMemoryAdmissionSchema =
  deterministicReadMemoryAdmissionSchema.extend({
    version: z.literal("memory-run-retrieval-admission-v55")
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

const readerFirstManifestV3Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v3"),
  source: z.object({
    appCommit: z.literal("657656595d83959c78f0e7d17a682d5de495c748"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV4Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v4"),
  source: z.object({
    appCommit: z.literal("55dfa93dfb25502503c7b327c451799f28bb8ddd"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV5Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v5"),
  source: z.object({
    appCommit: z.literal("54051d7bb6e7b961a3882463bf0a47963fd20e5b"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV6Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v6"),
  source: z.object({
    appCommit: z.literal("04abc3d5aa730df861224c8f66a64307c4ed17ce"),
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV7Schema = readerFirstManifestV1Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v7"),
  runtime: readerFirstManifestV1Schema.shape.runtime.extend({
    embedding: z.object({
      provider: z.literal("OpenRouter"),
      providerOrder: z.tuple([
        z.literal("nebius"),
        z.literal("deepinfra")
      ]),
      upstreamModelId: z.literal("qwen/qwen3-embedding-8b")
    }).strict(),
    evaluation: z.object({
      failFast: z.literal(true),
      mode: z.literal("per_case"),
      model: z.literal("gpt-4o-2024-08-06"),
      oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
      provider: z.literal("OpenAI"),
      scriptSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256)
    }).strict(),
    lexical: z.object({
      backend: z.literal("OPENSEARCH"),
      indexBuildId: z.literal("20260831-lme-v7-r2")
    }).strict()
  }).strict(),
  source: z.object({
    appCommit: z.literal("6683814244b442bc23c57928b80785151caa853b"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV8Schema = readerFirstManifestV7Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v8"),
  source: z.object({
    appCommit: z.literal("29c4c39b58f212570ef119dcfafa801df19f9969"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV9Schema = readerFirstManifestV8Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v9"),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV10Schema = readerFirstManifestV9Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v10"),
  runtime: readerFirstManifestV9Schema.shape.runtime.extend({
    systemModel: z.object({
      dataCollection: z.literal("allow"),
      provider: z.literal("OpenRouter"),
      providerOrder: z.tuple([z.literal("deepseek")]),
      reasoningEffort: z.literal("medium"),
      structuredOutputToolChoice: z.literal("auto"),
      upstreamModelId: z.literal("deepseek/deepseek-v4-flash-0731")
    }).strict()
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV11Schema = readerFirstManifestV9Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v11"),
  runtime: readerFirstManifestV9Schema.shape.runtime.extend({
    systemModel: z.object({
      dataCollection: z.literal("deny"),
      provider: z.literal("OpenRouter"),
      providerOrder: z.tuple([z.literal("z-ai/fp8")]),
      reasoningEffort: z.literal("medium"),
      structuredOutputToolChoice: z.literal("auto"),
      upstreamModelId: z.literal("z-ai/glm-5.3-flash")
    }).strict()
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV12Schema = readerFirstManifestV9Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v12"),
  runtime: readerFirstManifestV9Schema.shape.runtime.extend({
    systemModel: z.object({
      dataCollection: z.literal("deny"),
      provider: z.literal("OpenRouter"),
      providerOrder: z.tuple([z.literal("google-vertex/global")]),
      reasoningEffort: z.literal("medium"),
      structuredOutputToolChoice: z.literal("required"),
      upstreamModelId: z.literal("google/gemini-3.7-flash")
    }).strict(),
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const measuredEvaluationSchema =
  readerFirstManifestV9Schema.shape.runtime.shape.evaluation.extend({
    failFast: z.literal(false)
  }).strict();

const readerFirstManifestV13Schema = readerFirstManifestV10Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v13"),
  runtime: readerFirstManifestV10Schema.shape.runtime.extend({
    evaluation: measuredEvaluationSchema,
    memoryAdmission: measuredMemoryAdmissionSchema
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV14Schema = readerFirstManifestV11Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v14"),
  runtime: readerFirstManifestV11Schema.shape.runtime.extend({
    evaluation: measuredEvaluationSchema,
    memoryAdmission: measuredMemoryAdmissionSchema
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV15Schema = readerFirstManifestV12Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v15"),
  runtime: readerFirstManifestV12Schema.shape.runtime.extend({
    evaluation: measuredEvaluationSchema,
    memoryAdmission: measuredMemoryAdmissionSchema
  }).strict(),
  source: z.object({
    appCommit: z.literal("3e4c098975130e2829c67973632d8eb51d4ca732"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV16Schema = readerFirstManifestV15Schema.extend({
  id: z.literal("fu2-reader-first-blind-50-v16"),
  runtime: readerFirstManifestV15Schema.shape.runtime.extend({
    caseConcurrency: z.literal(1),
    memoryAdmission: deterministicReadMemoryAdmissionSchema
  }).strict(),
  source: z.object({
    appCommit: z.literal("6e1715d31e8710c53dd13f3d2c808b4c0d8d091c"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV17Schema = readerFirstManifestV16Schema.extend({
  id: z.literal("fu2-reader-first-luna-25-v17"),
  runtime: readerFirstManifestV16Schema.shape.runtime.extend({
    systemModel: z.object({
      dataCollection: z.null(),
      provider: z.literal("codex-lb"),
      providerOrder: z.tuple([]),
      reasoningEffort: z.literal("medium"),
      structuredOutputToolChoice: z.literal("required"),
      upstreamModelId: z.literal("gpt-5.6-luna")
    }).strict()
  }).strict(),
  selection: selection25Schema,
  source: z.object({
    appCommit: z.literal("6e1715d31e8710c53dd13f3d2c808b4c0d8d091c"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV18Schema = readerFirstManifestV17Schema.extend({
  id: z.literal("fu2-reader-first-luna-25-v18"),
  runtime: readerFirstManifestV17Schema.shape.runtime.extend({
    memoryAdmission: productionReadMemoryAdmissionSchema
  }).strict(),
  source: z.object({
    appCommit: z.literal("6e1715d31e8710c53dd13f3d2c808b4c0d8d091c"),
    appWorktreeSha256: sha256Schema,
    datasetSha256: z.literal(LONGMEMEVAL_S_SHA256),
    evaluatorSha256: z.literal(LONGMEMEVAL_EVALUATOR_SHA256),
    oracleSha256: z.literal(LONGMEMEVAL_ORACLE_SHA256),
    upstreamCommit: z.literal(LONGMEMEVAL_REPOSITORY_COMMIT)
  }).strict()
}).strict();

const readerFirstManifestV19Schema = readerFirstManifestV18Schema.extend({
  id: z.literal("fu2-reader-first-luna-25-v19")
}).strict();

const manifestSchema = z.discriminatedUnion("id", [
  legacyManifestSchema,
  readerFirstManifestV1Schema,
  readerFirstManifestV2Schema,
  readerFirstManifestV3Schema,
  readerFirstManifestV4Schema,
  readerFirstManifestV5Schema,
  readerFirstManifestV6Schema,
  readerFirstManifestV7Schema,
  readerFirstManifestV8Schema,
  readerFirstManifestV9Schema,
  readerFirstManifestV10Schema,
  readerFirstManifestV11Schema,
  readerFirstManifestV12Schema,
  readerFirstManifestV13Schema,
  readerFirstManifestV14Schema,
  readerFirstManifestV15Schema,
  readerFirstManifestV16Schema,
  readerFirstManifestV17Schema,
  readerFirstManifestV18Schema,
  readerFirstManifestV19Schema
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

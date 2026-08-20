import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createKnowledgeVectorSpacePin } from "../../lib/server/knowledge/indexProfile";
import { KNOWLEDGE_INDEX_PROFILE_ID } from "../../lib/server/knowledge/knowledgeProfile";
import { prisma } from "../../lib/server/prisma";
import { createPrismaEmbeddingRuntime } from "../../lib/server/providerRuntime/embeddingRuntime";
import { createAcceptedStructuredOutputExecutor } from "../../lib/server/providerRuntime/structuredOutputExecutor";
import { createSystemModelRoleResolver } from "../../lib/server/providerRuntime/systemModelRole";
import type { KnowledgeRerankerEmbeddingExecutor } from "./rerankerCandidates";
import { buildKnowledgeRerankerCandidatePool } from "./rerankerCandidates";
import {
  runKnowledgeProfileBenchmark,
  type KnowledgeProfileBenchmarkReport
} from "./profileBenchmark";
import {
  createLocalCrossEncoderRerankerExecutor,
  resolveSystemModelRerankerExecutor
} from "./rerankerRunners";
import { createKnowledgeRerankerCorpusManifest } from "./rerankerCorpus";
import {
  KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE,
  KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE,
  readKnowledgeRerankerReviewEvidenceDirectory,
  writeKnowledgeRerankerReviewArtifacts
} from "./rerankerReview";

export type KnowledgeRerankerReviewPreparationReport = Readonly<{
  aggregateOnly: true;
  candidateCount: number;
  candidatePoolQualityGateEligible: true;
  candidatePoolSha256: string;
  corpusSha256: string;
  filesCreated: readonly [
    typeof KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE,
    typeof KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE
  ];
  humanReviewPending: true;
  queryCount: number;
  selectionEligible: false;
  version: "knowledge-reranker-review-preparation-v1";
}>;

export type KnowledgeProfileBenchmarkCliOptions = Readonly<{
  executePaidRealEmbedding: boolean;
  executePaidSystemModel: boolean;
  help: boolean;
  localRunnerConfigPath: string | null;
  prepareReviewDirectory: string | null;
  reviewDirectory: string | null;
}>;

export const KNOWLEDGE_PROFILE_BENCHMARK_CLI_USAGE = [
  "Usage: npm run eval:knowledge:profiles -- [options]",
  "",
  "  --local-runner-config <absolute-json-path>",
  "      Execute the loopback-only local cross-encoder runner protocol.",
  "      Config keys: version, endpoint, hardware, modelId, resources, revision, timeoutMs.",
  "      The endpoint speaks knowledge-reranker-runner-v1 JSON POST requests/responses.",
  "  --execute-paid-real-embedding",
  "      Use the active installation Knowledge Profile embedding destination.",
  "  --execute-paid-system-model",
  "      Use the admitted installation System Model structured-output role.",
  "  --review-directory <absolute-/tmp-path>",
  "      Import two external-human submissions and adjudication from the private packet directory.",
  "      Required 0600 files: reviewer-a-submission.json, reviewer-b-submission.json, adjudication.json.",
  "  --prepare-review-directory <absolute-empty-/tmp-path>",
  "      Create a blind packet from one approved real-embedding pool, then stop before review.",
  "  --help",
  "",
  "Paid/external flags require current operator authorization under agent_docs/TESTING.md."
].join("\n");

export function parseKnowledgeProfileBenchmarkCliArgs(
  args: readonly string[]
): KnowledgeProfileBenchmarkCliOptions {
  let executePaidRealEmbedding = false;
  let executePaidSystemModel = false;
  let help = false;
  let localRunnerConfigPath: string | null = null;
  let prepareReviewDirectory: string | null = null;
  let reviewDirectory: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute-paid-real-embedding") {
      executePaidRealEmbedding = true;
    } else if (argument === "--execute-paid-system-model") {
      executePaidSystemModel = true;
    } else if (argument === "--help") {
      help = true;
    } else if (argument === "--local-runner-config" || argument === "--review-directory" ||
      argument === "--prepare-review-directory") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("knowledge_profile_benchmark_cli_argument_missing");
      }
      if (!isAbsolute(value) || resolve(value) !== value) {
        throw new Error("knowledge_profile_benchmark_cli_path_invalid");
      }
      if (argument === "--local-runner-config") {
        if (localRunnerConfigPath !== null) {
          throw new Error("knowledge_profile_benchmark_cli_argument_duplicate");
        }
        localRunnerConfigPath = value;
      } else if (argument === "--review-directory") {
        if (reviewDirectory !== null) {
          throw new Error("knowledge_profile_benchmark_cli_argument_duplicate");
        }
        reviewDirectory = value;
      } else {
        if (prepareReviewDirectory !== null) {
          throw new Error("knowledge_profile_benchmark_cli_argument_duplicate");
        }
        prepareReviewDirectory = value;
      }
      index += 1;
    } else {
      throw new Error("knowledge_profile_benchmark_cli_argument_invalid");
    }
  }
  if (prepareReviewDirectory !== null && reviewDirectory !== null) {
    throw new Error("knowledge_profile_benchmark_cli_argument_conflict");
  }
  if ((prepareReviewDirectory !== null || reviewDirectory !== null) &&
    !executePaidRealEmbedding) {
    throw new Error("knowledge_profile_benchmark_real_embedding_required");
  }
  return Object.freeze({
    executePaidRealEmbedding,
    executePaidSystemModel,
    help,
    localRunnerConfigPath,
    prepareReviewDirectory,
    reviewDirectory
  });
}

export function knowledgeProfileBenchmarkCliErrorCode(error: unknown): string {
  return error instanceof Error &&
    /^knowledge_[a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "knowledge_profile_benchmark_failed";
}

async function readLocalRunnerConfig(path: string): Promise<unknown> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > 16 * 1024) {
    throw new Error("knowledge_profile_benchmark_local_config_invalid");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_profile_benchmark_local_config_invalid");
  }
}

async function activeProfileEmbeddingExecutor(): Promise<KnowledgeRerankerEmbeddingExecutor> {
  const profile = await prisma.knowledgeIndexProfile.findUnique({
    select: {
      activeRevision: {
        select: {
          embeddingProviderModelId: true,
          executionAuthority: true,
          preflightErrorCode: true,
          preflightStatus: true,
          revisionNumber: true,
          targetDimension: true,
          vectorSpaceFingerprint: true
        }
      }
    },
    where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
  });
  const revision = profile?.activeRevision;
  if (!revision || revision.executionAuthority !== "installation" ||
    revision.preflightStatus !== "ready" || revision.preflightErrorCode !== null) {
    throw new Error("knowledge_profile_benchmark_active_embedding_unavailable");
  }
  const [binding, pricing] = await Promise.all([
    createPrismaEmbeddingRuntime(prisma).resolveForInstallation({
      providerModelId: revision.embeddingProviderModelId
    }),
    prisma.providerModel.findUnique({
      select: { inputTokenPriceMicros: true },
      where: { id: revision.embeddingProviderModelId }
    })
  ]);
  const pin = createKnowledgeVectorSpacePin({
    configuration: binding.configuration,
    deploymentId: revision.embeddingProviderModelId
  });
  if (!pin || pin.fingerprint !== revision.vectorSpaceFingerprint.trim() ||
    pin.targetDimension !== revision.targetDimension || !pricing) {
    throw new Error("knowledge_profile_benchmark_active_embedding_unavailable");
  }
  return Object.freeze({
    async embed(input) {
      const result = await binding.adapter.embed({
        mode: input.kind,
        texts: input.texts
      });
      return Object.freeze({
        costMicros: result.usage.inputTokens === null
          ? null
          : result.usage.inputTokens * pricing.inputTokenPriceMicros,
        inputTokens: result.usage.inputTokens,
        vectors: result.vectors
      });
    },
    identity: Object.freeze({
      approval: "approved_candidate" as const,
      authorization: "profile_authorized" as const,
      dimensions: revision.targetDimension,
      egress: "external" as const,
      executionClass: "real_embedding" as const,
      modelId: binding.configuration.upstreamModelId,
      provider: binding.provider,
      revision: `knowledge-profile-r${revision.revisionNumber}-${pin.fingerprint.slice(0, 16)}`,
      vectorSpaceId: `kr-${pin.fingerprint.slice(0, 32)}`
    })
  });
}

export async function runKnowledgeProfileBenchmarkCli(
  args: readonly string[]
): Promise<KnowledgeProfileBenchmarkReport | KnowledgeRerankerReviewPreparationReport | null> {
  const options = parseKnowledgeProfileBenchmarkCliArgs(args);
  if (options.help) return null;
  const localCrossEncoder = options.localRunnerConfigPath
    ? createLocalCrossEncoderRerankerExecutor(
        await readLocalRunnerConfig(options.localRunnerConfigPath)
      )
    : undefined;
  const labels = options.reviewDirectory
    ? await readKnowledgeRerankerReviewEvidenceDirectory(options.reviewDirectory)
    : undefined;
  const embedding = options.executePaidRealEmbedding
    ? await activeProfileEmbeddingExecutor()
    : undefined;
  if (options.prepareReviewDirectory) {
    if (!embedding) throw new Error("knowledge_profile_benchmark_real_embedding_required");
    const corpus = createKnowledgeRerankerCorpusManifest();
    const poolResult = await buildKnowledgeRerankerCandidatePool({
      candidateLimit: 12,
      corpus,
      embedding
    });
    if (!poolResult.pool.qualityGateEligible) {
      throw new Error("knowledge_profile_benchmark_real_embedding_required");
    }
    await writeKnowledgeRerankerReviewArtifacts({
      corpus,
      pool: poolResult.pool,
      reviewDirectory: options.prepareReviewDirectory
    });
    return Object.freeze({
      aggregateOnly: true,
      candidateCount: poolResult.pool.queries.reduce((sum, query) =>
        sum + query.candidates.length, 0),
      candidatePoolQualityGateEligible: true,
      candidatePoolSha256: poolResult.pool.poolSha256,
      corpusSha256: corpus.corpusSha256,
      filesCreated: Object.freeze([
        KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE,
        KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE
      ] as const),
      humanReviewPending: true,
      queryCount: poolResult.pool.queries.length,
      selectionEligible: false,
      version: "knowledge-reranker-review-preparation-v1"
    });
  }
  let systemModel;
  let systemUnavailableReason;
  if (options.executePaidSystemModel) {
    const systemResolver = createSystemModelRoleResolver(prisma);
    const resolution = await systemResolver.resolve();
    const pricing = resolution.ok
      ? await prisma.providerModel.findUnique({
          select: { inputTokenPriceMicros: true, outputTokenPriceMicros: true },
          where: { id: resolution.providerModelId }
        })
      : null;
    const runner = await resolveSystemModelRerankerExecutor({
      executeStructuredOutput: createAcceptedStructuredOutputExecutor(prisma),
      ...(pricing ? {
        pricing: {
          inputTokenPriceMicros: pricing.inputTokenPriceMicros,
          outputTokenPriceMicros: pricing.outputTokenPriceMicros
        }
      } : {}),
      resolveSystemModel: async () => resolution
    });
    if (runner.status === "available") systemModel = runner.executor;
    else systemUnavailableReason = runner.reason;
  }
  const report = await runKnowledgeProfileBenchmark({
    ...(embedding ? { embedding } : {}),
    ...(labels ? { labels } : {}),
    ...(localCrossEncoder ? { localCrossEncoder } : {}),
    ...(systemModel ? { systemModel } : {}),
    ...(systemUnavailableReason ? { systemUnavailableReason } : {})
  });
  if (!report.contractValid) {
    throw new Error("knowledge_profile_benchmark_contract_gate_failed");
  }
  return report;
}

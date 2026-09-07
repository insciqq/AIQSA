import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKnowledgeEmbeddingBatchAccumulator,
  knowledgeEmbeddingBatches,
  type KnowledgeEmbeddingInput
} from "../../lib/server/knowledge/chunking";
import { getKnowledgeExtractionConfig } from
  "../../lib/server/knowledge/knowledgeExtractionConfig";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/indexProfile";
import { requireKnowledgeTokenCounter } from
  "../../lib/server/knowledge/tokenizer/knowledgeTokenCounter";
import { knowledgeTokenizerIdentityLabel } from
  "../../lib/server/knowledge/tokenizer/types";
import { canonicalJson } from "./contract";
import {
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  brightDeterministicUuid,
  decodeBrightPreparedDocumentRow
} from "./brightStackOverflowContract";
import { verifyBrightPreparedDataset } from "./brightStackOverflowPrepared";
import { buildBrightProductDocumentPlan } from "./brightStackOverflowProduct";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(benchmarkRoot, ".data");
const defaultPreparedRoot = resolve(dataRoot, "prepared/bright-stackoverflow-50m");

type CliOptions = Readonly<{
  embeddingModel: string;
  output: string;
  preparedRoot: string;
}>;

type TaggedEmbeddingInput = KnowledgeEmbeddingInput & Readonly<{
  chunkIndex: number;
  sourceId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCli(argv: readonly string[]): CliOptions {
  let embeddingModel = "";
  let preparedRoot = defaultPreparedRoot;
  let output: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--embedding-model") {
      if (!next?.trim() || next.length > 512 || /[\u0000-\u001f\u007f]/u.test(next)) {
        throw new Error("bright_stackoverflow_embedding_model_invalid");
      }
      embeddingModel = next;
      index += 1;
    } else if (argument === "--prepared-root") {
      if (!next) throw new Error("bright_stackoverflow_prepared_root_required");
      preparedRoot = resolve(benchmarkRoot, next);
      index += 1;
    } else if (argument === "--output") {
      if (!next) throw new Error("bright_stackoverflow_census_output_required");
      output = resolve(benchmarkRoot, next);
      index += 1;
    } else {
      throw new Error("bright_stackoverflow_census_argument_unknown");
    }
  }
  if (!embeddingModel) {
    throw new Error("bright_stackoverflow_embedding_model_required");
  }
  output ??= resolve(
    preparedRoot,
    `product-census-${createHash("sha256").update(embeddingModel, "utf8")
      .digest("hex").slice(0, 16)}.json`
  );
  for (const path of [preparedRoot, output]) {
    if (path === dataRoot || !path.startsWith(`${dataRoot}${sep}`)) {
      throw new Error("bright_stackoverflow_census_path_not_ignored");
    }
  }
  return Object.freeze({ embeddingModel, output, preparedRoot });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporary, path);
}

async function existingCensus(input: Readonly<{
  datasetManifestFingerprint: string;
  embeddingModel: string;
  output: string;
  profileIdentity: string;
}>): Promise<Readonly<{
  crossSourceProviderRequestCount: number;
  documentCount: number;
  modelNativeCorpusTokens: number;
  passageCount: number;
  reportFingerprint: string;
  singleSourceProviderRequestCount: number;
}> | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(input.output, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("bright_stackoverflow_census_output_invalid");
  }
  if (!isRecord(value) || !isRecord(value.batching) || !isRecord(value.corpus) ||
    !isRecord(value.profile) || value.schemaVersion !== 1 ||
    value.datasetManifestFingerprint !== input.datasetManifestFingerprint ||
    value.profile.embeddingModel !== input.embeddingModel ||
    value.profile.profileIdentity !== input.profileIdentity ||
    typeof value.reportFingerprint !== "string") {
    throw new Error("bright_stackoverflow_census_output_invalid");
  }
  const { reportFingerprint, ...body } = value;
  if (!/^[0-9a-f]{64}$/u.test(reportFingerprint) ||
    createHash("sha256").update(canonicalJson(body), "utf8").digest("hex") !==
      reportFingerprint) {
    throw new Error("bright_stackoverflow_census_output_mismatch");
  }
  const numbers = [
    value.batching.crossSourceProviderRequestCount,
    value.batching.singleSourceProviderRequestCount,
    value.corpus.documentCount,
    value.corpus.modelNativeCorpusTokens,
    value.corpus.passageCount
  ];
  if (numbers.some((number) => !Number.isSafeInteger(number) || Number(number) < 1) ||
    value.corpus.documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_census_output_invalid");
  }
  return Object.freeze({
    crossSourceProviderRequestCount: Number(
      value.batching.crossSourceProviderRequestCount
    ),
    documentCount: Number(value.corpus.documentCount),
    modelNativeCorpusTokens: Number(value.corpus.modelNativeCorpusTokens),
    passageCount: Number(value.corpus.passageCount),
    reportFingerprint,
    singleSourceProviderRequestCount: Number(
      value.batching.singleSourceProviderRequestCount
    )
  });
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(?:bright_stackoverflow_|knowledge_)[a-z0-9_:.-]+$/u.test(message) ||
    message === "chunking_failed"
    ? message
    : "bright_stackoverflow_product_census_failed";
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const manifest = await verifyBrightPreparedDataset(options.preparedRoot);
  const config = getKnowledgeExtractionConfig({});
  const tokenCounter = requireKnowledgeTokenCounter(options.embeddingModel);
  const tokenizerIdentity = knowledgeTokenizerIdentityLabel(tokenCounter.identity);
  const profileIdentity = createHash("sha256").update(canonicalJson({
    chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
    tokenizer: tokenCounter.identity
  }), "utf8").digest("hex");
  const existing = await existingCensus({
    datasetManifestFingerprint: manifest.manifestFingerprint,
    embeddingModel: options.embeddingModel,
    output: options.output,
    profileIdentity
  });
  if (existing) {
    process.stdout.write(`${JSON.stringify({
      ...existing,
      event: "bright_stackoverflow_product_census_already_complete"
    })}\n`);
    return;
  }
  const batchAccumulator = createKnowledgeEmbeddingBatchAccumulator<
    TaggedEmbeddingInput
  >(KNOWLEDGE_CHUNKING_PROFILE_VERSION, tokenCounter);
  const aggregateHash = createHash("sha256");
  const startedAt = performance.now();
  let crossSourceBatchCount = 0;
  let crossSourceBatchInputs = 0;
  let documentCount = 0;
  let embeddingInputTokens = 0;
  let embeddingInputUtf8Bytes = 0;
  let exactEntryCount = 0;
  let maxChunksPerDocument = 0;
  let minChunksPerDocument = Number.MAX_SAFE_INTEGER;
  let modelNativeCorpusTokens = 0;
  let normalizedObjectBytes = 0;
  let passageCount = 0;
  let sectionCount = 0;
  let singleSourceBatchCount = 0;

  const acceptBatch = (batch: readonly TaggedEmbeddingInput[] | null) => {
    if (!batch) return;
    crossSourceBatchCount += 1;
    crossSourceBatchInputs += batch.length;
  };

  for (const [shardIndex, shard] of manifest.corpus.shards.entries()) {
    const shardPath = resolve(options.preparedRoot, shard.path);
    if (!shardPath.startsWith(`${options.preparedRoot}${sep}`)) {
      throw new Error("bright_stackoverflow_prepared_shard_path_invalid");
    }
    const body = await readFile(shardPath, "utf8");
    const lines = body.split("\n");
    if (lines.at(-1) !== "") {
      throw new Error("bright_stackoverflow_prepared_shard_invalid");
    }
    lines.pop();
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error("bright_stackoverflow_prepared_shard_invalid");
      }
      const document = decodeBrightPreparedDocumentRow(parsed);
      if (document.ordinal !== documentCount) {
        throw new Error("bright_stackoverflow_prepared_ordinal_mismatch");
      }
      const artifactId = brightDeterministicUuid(
        "artifact",
        document.sourceVersionId,
        profileIdentity
      );
      const plan = buildBrightProductDocumentPlan({
        artifactId,
        chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
        config,
        document,
        tokenCounter
      });
      modelNativeCorpusTokens += tokenCounter.countTokens(document.preparedText);
      normalizedObjectBytes += plan.normalized.body.byteLength;
      passageCount += plan.chunks.length;
      sectionCount += plan.hierarchicalIndex.sections.length;
      exactEntryCount += plan.hierarchicalIndex.exactEntries.length;
      minChunksPerDocument = Math.min(minChunksPerDocument, plan.chunks.length);
      maxChunksPerDocument = Math.max(maxChunksPerDocument, plan.chunks.length);
      singleSourceBatchCount += knowledgeEmbeddingBatches(
        plan.chunks,
        KNOWLEDGE_CHUNKING_PROFILE_VERSION,
        tokenCounter
      ).length;
      for (const chunk of plan.chunks) {
        embeddingInputTokens += tokenCounter.countTokens(chunk.embeddingText);
        embeddingInputUtf8Bytes += Buffer.byteLength(chunk.embeddingText, "utf8");
        acceptBatch(batchAccumulator.push(Object.freeze({
          chunkIndex: chunk.index,
          embeddingText: chunk.embeddingText,
          sourceId: document.sourceId
        })));
        aggregateHash.update(document.sourceId, "utf8").update("\0", "utf8")
          .update(String(chunk.index), "utf8").update("\0", "utf8")
          .update(chunk.contentHash, "utf8").update("\0", "utf8")
          .update(chunk.embeddingTextHash, "utf8").update("\0", "utf8")
          .update(plan.hierarchicalIndex.checksum, "utf8").update("\0", "utf8");
      }
      documentCount += 1;
    }
    if ((shardIndex + 1) % 10 === 0 || shardIndex + 1 === manifest.corpus.shards.length) {
      process.stdout.write(`${JSON.stringify({
        documentCount,
        event: "bright_stackoverflow_product_census_progress",
        passageCount,
        shardCount: shardIndex + 1
      })}\n`);
    }
  }
  acceptBatch(batchAccumulator.finish());
  if (documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    passageCount !== crossSourceBatchInputs) {
    throw new Error("bright_stackoverflow_product_census_count_mismatch");
  }
  const completedAt = performance.now();
  const reportWithoutFingerprint = {
    batching: {
      crossSourceProviderRequestCount: crossSourceBatchCount,
      requestReductionRatio: singleSourceBatchCount / crossSourceBatchCount,
      singleSourceProviderRequestCount: singleSourceBatchCount
    },
    corpus: {
      documentCount,
      embeddingInputTokens,
      embeddingInputUtf8Bytes,
      exactEntryCount,
      maxChunksPerDocument,
      minChunksPerDocument,
      modelNativeCorpusTokens,
      normalizedObjectBytes,
      passageCount,
      sectionCount
    },
    datasetManifestFingerprint: manifest.manifestFingerprint,
    execution: {
      elapsedMs: Math.round(completedAt - startedAt),
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
      parserRequests: 0,
      providerRequests: 0
    },
    profile: {
      chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      embeddingModel: options.embeddingModel,
      profileIdentity,
      tokenizer: tokenCounter.identity,
      tokenizerIdentity
    },
    productFingerprint: aggregateHash.digest("hex"),
    schemaVersion: 1
  };
  const reportFingerprint = createHash("sha256")
    .update(canonicalJson(reportWithoutFingerprint), "utf8")
    .digest("hex");
  await writeJsonAtomic(options.output, {
    ...reportWithoutFingerprint,
    reportFingerprint
  });
  process.stdout.write(`${JSON.stringify({
    crossSourceProviderRequestCount: crossSourceBatchCount,
    documentCount,
    elapsedMs: Math.round(completedAt - startedAt),
    event: "bright_stackoverflow_product_census_complete",
    modelNativeCorpusTokens,
    passageCount,
    reportFingerprint,
    singleSourceProviderRequestCount: singleSourceBatchCount
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: safeFailureCode(error),
      event: "bright_stackoverflow_product_census_failed"
    })}\n`);
    process.exitCode = 1;
  });
}

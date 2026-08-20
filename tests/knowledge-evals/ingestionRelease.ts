import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { UPLOAD_FORMAT_REGISTRY, uploadFormatFor } from "../../lib/domain/uploadFormats";
import { createPrismaKnowledgeDeletionProcessor } from "../../lib/server/knowledge/deletionProcessor";
import { KnowledgeIngestionCoordinator } from "../../lib/server/knowledge/ingestionCoordinator";
import { createKnowledgeIngestionProcessor } from "../../lib/server/knowledge/ingestionProcessor";
import { KnowledgeIngestionError, type KnowledgeSourceWorkClaim } from "../../lib/server/knowledge/ingestionTypes";
import { createKnowledgeVectorSpacePin } from "../../lib/server/knowledge/indexProfile";
import { encodeKnowledgeNormalizedDocument } from "../../lib/server/knowledge/normalizedDocument";
import { createDocumentParserBoundary, DocumentParserError, type DocumentParserEngineAdapter } from "../../lib/server/parsing";
import { finalizeParsedDocument } from "../../lib/server/parsing/assessment";
import { normalizeDoclingResponse } from "../../lib/server/parsing/normalization";
import type { ProviderModelConfiguration } from "../../lib/server/providers/providerConfiguration";
import { createMemoryStorageAdapter } from "../support/storage";

export const KNOWLEDGE_INGESTION_RELEASE_REPORT_VERSION = "knowledge-ingestion-release-v1";

type Gate = Readonly<{
  denominator: number;
  name: string;
  numerator: number;
  passed: boolean;
  primitive: string;
  rate: number;
}>;

export type KnowledgeIngestionReleaseReport = Readonly<{
  aggregateOnly: true;
  generatedFor: "2026-08-19";
  gates: readonly Gate[];
  passed: boolean;
  unavailable: readonly Readonly<{ field: string; reason: string }>[];
  version: typeof KNOWLEDGE_INGESTION_RELEASE_REPORT_VERSION;
}>;

const extractionConfig = {
  maxChunksPerDocument: 200,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 200
};

const providerConfiguration: ProviderModelConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 8,
    providerFamily: "openai",
    queryInstructionTemplate: "Query: {text}",
    supportsMrl: false,
    targetDimension: 8
  },
  modelClass: "embedding",
  upstreamModelId: "hermetic-release-eval"
};

const pin = createKnowledgeVectorSpacePin({
  configuration: providerConfiguration,
  deploymentId: "hermetic-release-eval"
})!;

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function gate(name: string, numerator: number, denominator: number, primitive: string): Gate {
  return Object.freeze({
    denominator,
    name,
    numerator,
    passed: denominator > 0 && numerator === denominator,
    primitive,
    rate: rate(numerator, denominator)
  });
}

function parsedBlockDocument() {
  return finalizeParsedDocument({
    blocks: [0, 1].map((index) => ({
      assetIds: [],
      boundingBoxes: [],
      headingPath: [`Section ${index + 1}`],
      index,
      isTable: false,
      languageHints: ["en-Latn"],
      page: index + 1,
      pageEnd: index + 1,
      readingOrder: index,
      table: null,
      text: `release evaluation block ${index + 1}`,
      type: "paragraph" as const
    })),
    engine: "inline",
    mediaType: "text/plain",
    pageCount: 2,
    status: "complete",
    text: "release evaluation block 1\n\nrelease evaluation block 2"
  });
}

function parserAdapter(
  parse: DocumentParserEngineAdapter["parse"],
  engine: "docling" | "tika"
): DocumentParserEngineAdapter {
  return {
    parse,
    probe: async () => ({ available: true, configured: true, engine })
  };
}

function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function embeddingClaim(encoded: ReturnType<typeof encodeKnowledgeNormalizedDocument>): KnowledgeSourceWorkClaim {
  return {
    artifact: {
      chunkingProfileVersion: 1,
      embeddingConfiguration: pin.configuration,
      embeddingProviderModelId: "hermetic-release-eval",
      id: "artifact-release-eval",
      profileExecutionAuthority: "legacy_user",
      profileRevisionId: null,
      targetDimension: pin.targetDimension,
      vectorSpaceFingerprint: pin.fingerprint
    },
    attemptCount: 1,
    byteSize: 1,
    checksum: checksum(Buffer.from("x")),
    claimToken: "claim-release-eval",
    fileName: "release-eval.txt",
    ingestChunkCount: 2,
    knowledgeBaseId: "base-release-eval",
    mimeType: "text/plain",
    normalizedTextByteSize: encoded.body.byteLength,
    normalizedTextChecksum: encoded.checksum,
    normalizedTextStorageKey: "normalized-release-eval.json",
    originalStorageKey: null,
    ownerUserId: "owner-release-eval",
    sourceId: "source-release-eval",
    sourceVersionId: "version-release-eval",
    state: "embedding"
  };
}

async function evaluateReuse(): Promise<boolean> {
  const encoded = encodeKnowledgeNormalizedDocument(parsedBlockDocument(), extractionConfig);
  const storage = createMemoryStorageAdapter();
  await storage.putObject({
    body: encoded.body,
    contentType: "application/json",
    storageKey: "normalized-release-eval.json"
  });
  let activated = false;
  let providerResolutionCount = 0;
  let reuseCount = 0;
  const processor = createKnowledgeIngestionProcessor({
    config: extractionConfig,
    embeddingRuntime: {
      resolveForInstallation: async () => {
        providerResolutionCount += 1;
        throw new Error("provider_must_not_be_used_for_full_reuse");
      },
      resolveForUser: async () => {
        providerResolutionCount += 1;
        throw new Error("provider_must_not_be_used_for_full_reuse");
      }
    },
    repository: {
      activateSourceVersion: async () => {
        activated = true;
        return "activated" as const;
      },
      advanceSourceToParsing: async () => true,
      completedBatchIndexes: async () => [],
      completeChunking: async () => true,
      completeParsing: async () => true,
      persistEmbeddingBatch: async () => true,
      persistHierarchicalIndex: async () => true,
      reuseEmbeddingChunks: async () => {
        reuseCount += 1;
        return [0, 1];
      }
    },
    storage
  });
  await processor(embeddingClaim(encoded));
  return activated && reuseCount === 1 && providerResolutionCount === 0;
}

async function evaluateRetryIsolation(): Promise<boolean> {
  const baseClaim = embeddingClaim(encodeKnowledgeNormalizedDocument(parsedBlockDocument(), extractionConfig));
  const claims: KnowledgeSourceWorkClaim[] = [
    { ...baseClaim, claimToken: "retry-claim", sourceVersionId: "retry-version" },
    { ...baseClaim, claimToken: "healthy-claim", sourceVersionId: "healthy-version" }
  ];
  const processed: string[] = [];
  const retried: string[] = [];
  const coordinator = new KnowledgeIngestionCoordinator({
    heartbeatMs: 60_000,
    maxParallel: 1,
    now: () => new Date("2026-08-19T00:00:00.000Z"),
    process: async (claim) => {
      processed.push(claim.sourceVersionId);
      if (claim.sourceVersionId === "retry-version") {
        throw new KnowledgeIngestionError("parser_unavailable", true);
      }
    },
    repository: {
      claim: async () => claims.shift() ?? null,
      heartbeat: async () => true,
      reconcile: async () => false,
      retryLater: async (input) => {
        retried.push(input.sourceVersionId);
        return true;
      },
      settleFailed: async () => true
    }
  });
  await coordinator.reconcileNow();
  return processed.length === 2 && processed.includes("healthy-version") &&
    retried.length === 1 && retried[0] === "retry-version";
}

async function deletionOutcome(manifestCount: number): Promise<Readonly<{
  blockedRelease: boolean;
  outcome: string;
  settled: boolean;
}>> {
  let countCall = 0;
  let settled = false;
  let blockedRelease = false;
  const transactionClient = {
    knowledgeDeletionJob: {
      findFirst: async () => ({ id: "deletion-release-eval" }),
      update: async (input: { data: { state?: string } }) => {
        if (input.data.state === "SUCCEEDED") settled = true;
        return {};
      }
    },
    knowledgeDeletionObject: {
      count: async () => {
        countCall += 1;
        return countCall === 1 ? manifestCount : 0;
      },
      deleteMany: async () => ({ count: manifestCount })
    },
    knowledgeSource: { count: async () => 0 }
  };
  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transactionClient),
    knowledgeDeletionJob: {
      updateMany: async (input: { data: { state?: string } }) => {
        if (input.data.state === "BLOCKED_REQUIRES_ADMIN") blockedRelease = true;
        return { count: 1 };
      }
    }
  } as unknown as PrismaClient;
  const processor = createPrismaKnowledgeDeletionProcessor(client);
  const outcome = await processor.process({
    claimToken: "deletion-claim-release-eval",
    id: "deletion-release-eval",
    ownerUserId: "owner-release-eval",
    targetId: "source-release-eval",
    targetType: "SOURCE"
  }, new Date("2026-08-19T00:00:00.000Z"));
  return { blockedRelease, outcome, settled };
}

export async function runKnowledgeIngestionReleaseEval(): Promise<KnowledgeIngestionReleaseReport> {
  const knowledgeFormats = UPLOAD_FORMAT_REGISTRY.filter((format) => format.scopes.includes("knowledge"));
  const admitted = knowledgeFormats.filter((format) =>
    uploadFormatFor(`fixture${format.extensions[0]}`, format.canonicalMimeType, "knowledge")?.id === format.id);
  const classified = knowledgeFormats.filter((format) => {
    const resolved = uploadFormatFor(`fixture${format.extensions[0]}`, format.canonicalMimeType, "knowledge");
    return resolved?.contentEvidence === format.contentEvidence && resolved.parser !== null;
  });

  const normalized = normalizeDoclingResponse({
    document: {
      json_content: {
        body: {
          children: [
            { $ref: "#/texts/0" },
            { $ref: "#/texts/1" },
            { $ref: "#/texts/2" },
            { $ref: "#/texts/3" },
            { $ref: "#/tables/0" }
          ]
        },
        groups: [],
        pages: { "1": { page_no: 1 }, "2": { page_no: 2 } },
        schema_name: "DoclingDocument",
        tables: [{
          content_layer: "body",
          data: { table_cells: [
            { end_col_offset_idx: 1, end_row_offset_idx: 1, start_col_offset_idx: 0, start_row_offset_idx: 0, text: "Name" },
            { end_col_offset_idx: 2, end_row_offset_idx: 1, start_col_offset_idx: 1, start_row_offset_idx: 0, text: "Value" },
            { end_col_offset_idx: 1, end_row_offset_idx: 2, start_col_offset_idx: 0, start_row_offset_idx: 1, text: "alpha" },
            { end_col_offset_idx: 2, end_row_offset_idx: 2, start_col_offset_idx: 1, start_row_offset_idx: 1, text: "1" }
          ] },
          prov: [{ page_no: 2 }]
        }],
        texts: [
          { content_layer: "body", label: "title", prov: [{ page_no: 1 }], text: "Release guide" },
          { content_layer: "body", label: "paragraph", prov: [{ page_no: 1 }], text: "First page" },
          { content_layer: "body", label: "section_header", level: 1, prov: [{ page_no: 2 }], text: "Details" },
          { content_layer: "body", label: "paragraph", prov: [{ page_no: 2 }], text: "Русский текст OCR 2026" }
        ]
      }
    },
    status: "success"
  }, "application/pdf");
  const encoded = encodeKnowledgeNormalizedDocument(normalized, extractionConfig);
  const pages = new Set(normalized.blocks.map((block) => block.page));
  const ocrPreserved = normalized.blocks.some((block) => block.text === "Русский текст OCR 2026");
  const table = normalized.blocks.find((block) => block.isTable)?.table;
  const headingPreserved = normalized.blocks.some((block) =>
    block.headingPath.join("/") === "Release guide/Details");
  const locatorsPreserved = encoded.document.blocks.every((block) =>
    block.locator.pageStart >= 1 && block.locator.pageEnd >= block.locator.pageStart);

  const fallbackBoundary = createDocumentParserBoundary({
    adapters: {
      docling: parserAdapter(async () => {
        throw new DocumentParserError("parser_rejected", "docling");
      }, "docling"),
      tika: parserAdapter(async () => finalizeParsedDocument({
        ...parsedBlockDocument(),
        engine: "tika"
      }), "tika")
    }
  });
  const fallback = await fallbackBoundary.parse({
    bytes: Buffer.from("%PDF-release-eval"),
    fileName: "release-eval.pdf",
    mimeType: "application/pdf"
  });
  const fallbackPreserved = fallback.engine === "tika" && fallback.attempts.length === 2 &&
    fallback.attempts[0]?.outcome === "rejected" && fallback.attempts[1]?.outcome === "complete";

  const truncated = await createDocumentParserBoundary({ inlineMaxChars: 24 }).parse({
    bytes: Buffer.from("0123456789".repeat(10)),
    fileName: "release-eval.txt",
    mimeType: "text/plain"
  });
  const truncationBounded = truncated.status === "partial" &&
    truncated.warnings.includes("truncated_oversized_section") && truncated.text.length <= 24;

  const reusePreserved = await evaluateReuse();
  const retryIsolated = await evaluateRetryIsolation();
  const completedDeletion = await deletionOutcome(1);
  const blockedDeletion = await deletionOutcome(0);
  const purgeManifestFence = completedDeletion.outcome === "completed" && completedDeletion.settled &&
    blockedDeletion.outcome === "blocked" && blockedDeletion.blockedRelease;

  const gates = Object.freeze([
    gate("admission_accuracy", admitted.length, knowledgeFormats.length, "uploadFormatFor + UPLOAD_FORMAT_REGISTRY"),
    gate("classification_accuracy", classified.length, knowledgeFormats.length, "uploadFormatFor parser/content-evidence classification"),
    gate("page_block_recall", pages.size, 2, "normalizeDoclingResponse page attribution"),
    gate("ocr_text_recall", Number(ocrPreserved), 1, "normalizeDoclingResponse Cyrillic OCR preservation"),
    gate("table_structure_accuracy", Number(table?.rowCount === 2 && table.columnCount === 2), 1, "normalizeDoclingResponse table grid"),
    gate("heading_path_accuracy", Number(headingPreserved), 1, "normalizeDoclingResponse heading hierarchy"),
    gate("fallback_success", Number(fallbackPreserved), 1, "DocumentParserBoundary ordered sidecar fallback"),
    gate("truncation_disclosure", Number(truncationBounded), 1, "DocumentParserBoundary inline hard bound and warning"),
    gate("locator_accuracy", Number(locatorsPreserved), 1, "encodeKnowledgeNormalizedDocument page locators"),
    gate("retry_isolation", Number(retryIsolated), 1, "KnowledgeIngestionCoordinator retryLater and healthy-item continuation"),
    gate("embedding_reuse", Number(reusePreserved), 1, "KnowledgeIngestionProcessor full chunk reuse without provider resolution"),
    gate("purge_manifest_fence", Number(purgeManifestFence), 1, "KnowledgeDeletionProcessor idempotent settlement and missing-manifest block")
  ]);
  return Object.freeze({
    aggregateOnly: true,
    generatedFor: "2026-08-19",
    gates,
    passed: gates.every((candidate) => candidate.passed),
    unavailable: Object.freeze([{
      field: "destructive_payload_purge_latency_and_bytes",
      reason: "Hermetic release evaluation exercises the real deletion settlement/manifest fence; destructive database and object-store payload purge requires the disposable Postgres/MinIO lane."
    }]),
    version: KNOWLEDGE_INGESTION_RELEASE_REPORT_VERSION
  });
}

export async function assertKnowledgeIngestionReleaseGates(): Promise<KnowledgeIngestionReleaseReport> {
  const report = await runKnowledgeIngestionReleaseEval();
  const failures = report.gates.filter((candidate) => !candidate.passed).map((candidate) => candidate.name);
  if (failures.length > 0) throw new Error(`knowledge_ingestion_release_gate_failed:${failures.join(",")}`);
  return report;
}

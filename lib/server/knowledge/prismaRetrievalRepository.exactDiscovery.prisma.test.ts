import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ParsedDocumentBlock } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { chunkKnowledgeDocument } from "./chunking";
import { loadKnowledgeEvidencePackage } from "./evidenceRepository";
import { groundKnowledgeAnswer } from "./grounding";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { createPrismaKnowledgeHierarchicalRetrievalRepository } from
  "./prismaHierarchicalRetrievalRepository";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME
} from "./retrievalTypes";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { knowledgeEvidenceFromToolResult } from "./toolResult";
import {
  cleanupKnowledgeHierarchicalEvaluationFixture,
  createKnowledgeHierarchicalEvaluationFixture,
  persistKnowledgeHierarchicalEvaluationFixture,
  type KnowledgeHierarchicalEvaluationEntry,
  type KnowledgeHierarchicalEvaluationFixture
} from "../../../tests/knowledge-evals/hierarchicalIndexes";

const now = new Date("2026-08-20T00:00:00.000Z");
const bodyOnlyMarker = "BODY_ONLY_SECRET_8F3Q";
const vectorSpaceFingerprint = "4".repeat(64);
const extractionConfig = Object.freeze({
  maxChunksPerDocument: 2_000,
  maxFileBytes: 8_000_000,
  maxNormalizedChars: 5_000_000,
  maxNormalizedObjectBytes: 8_000_000,
  maxPages: 2_000
});

function metadataEntry(input: Readonly<{
  blockCount: number;
  id: string;
  state: KnowledgeHierarchicalEvaluationFixture;
}>): KnowledgeHierarchicalEvaluationEntry {
  const blocks: ParsedDocumentBlock[] = Array.from(
    { length: input.blockCount },
    (_, index): ParsedDocumentBlock => input.id === "metadata-tail" && index === 0
      ? ({
          assetIds: [],
          boundingBoxes: [],
          headingPath: ["Quarterly report entry 000"],
          index,
          isTable: true,
          languageHints: ["en"],
          page: 1,
          pageEnd: 1,
          readingOrder: index,
          table: {
            cells: [
              "Metric", "Date", "Actual", "Reference", "Unit", "Identifier",
              "TailPressure", "2026-08-20", "42", "40", "kPa", "TAILVALUE42"
            ].map((text, cellIndex) => ({
              column: cellIndex % 6,
              columnSpan: 1,
              row: Math.floor(cellIndex / 6),
              rowSpan: 1,
              text
            })),
            columnCount: 6,
            rowCount: 2
          },
          text: [
            "Metric\tDate\tActual\tReference\tUnit\tIdentifier",
            "TailPressure\t2026-08-20\t42\t40\tkPa\tTAILVALUE42"
          ].join("\n"),
          type: "table"
        })
      : ({
      assetIds: [],
      boundingBoxes: [],
      headingPath: [`Quarterly report entry ${String(index).padStart(3, "0")}`],
      index,
      isTable: false,
      languageHints: ["en"],
      page: 1,
      pageEnd: 1,
      readingOrder: index,
      table: null,
      text: `${input.id} safe row ${index} FLOOD_TOKEN_${index}${
        index === 104 ? ` ${bodyOnlyMarker}` : ""
      }`,
      type: "paragraph"
    })
  );
  const displayName = input.id === "metadata-flood"
    ? "Quarterly metadata flood"
    : "Quarterly metadata tail";
  const fileName = `${input.id}.txt`;
  const encoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks,
    engine: "inline",
    languages: ["en"],
    mediaType: "text/plain",
    pageCount: 1,
    status: "complete"
  }), extractionConfig, {
    sourceDisplayName: displayName,
    sourceMediaType: "text/plain"
  });
  const sourceId = `${input.state.prefix}-source-${input.id}`;
  const versionId = `${input.state.prefix}-version-${input.id}`;
  return Object.freeze({
    artifactId: `${input.state.prefix}-artifact-${input.id}`,
    chunks: Object.freeze(chunkKnowledgeDocument({
      document: encoded.document,
      maxChunks: extractionConfig.maxChunksPerDocument,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    })),
    document: encoded.document,
    logicalSourceId: input.id,
    normalizedChecksum: encoded.checksum,
    ownerUserId: input.state.ownerUserId,
    source: Object.freeze({
      displayName,
      fileName,
      headingPath: Object.freeze(["Quarterly report"]),
      id: input.id,
      language: "en" as const,
      mediaType: "text/plain",
      page: 1,
      tags: Object.freeze(["quarterly"]),
      text: blocks.map((block) => block.text).join("\n")
    }),
    sourceId,
    versionId
  });
}

type RuntimeFixture = Readonly<{
  chatId: string;
  contextualExactToolCallId: string;
  credentialId: string;
  credentialVersionId: string;
  discoveryToolCallId: string;
  exactToolCallId: string;
  runId: string;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function persistRuntime(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  entries: readonly KnowledgeHierarchicalEvaluationEntry[]
): Promise<RuntimeFixture> {
  const prefix = `${state.prefix}-exact-discovery-${randomUUID()}`;
  return client.$transaction(async (tx) => {
    const credentialId = `${prefix}-credential`;
    const credentialVersionId = `${prefix}-credential-version`;
    await tx.providerCredential.create({
      data: {
        connectionId: state.connectionId,
        enabled: true,
        id: credentialId,
        label: "Exact/discovery stateful credential"
      }
    });
    await tx.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId,
        id: credentialVersionId,
        secretEnvelope: "test-only-envelope",
        testEvidence: { synthetic: true },
        testedAt: now,
        version: 1
      }
    });
    await tx.providerCredential.update({
      data: { activatedAt: now, activeVersionId: credentialVersionId },
      where: { id: credentialId }
    });
    const chat = await tx.chat.create({
      data: { title: "Exact/discovery stateful proof", userId: state.ownerUserId }
    });
    const message = await tx.message.create({
      data: {
        chatId: chat.id,
        content: textMessageContent("Find and discover admitted Sources"),
        role: "user"
      }
    });
    await tx.chat.update({ data: { activeLeafMessageId: message.id }, where: { id: chat.id } });
    const run = await tx.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "knowledge-exact-discovery-stateful",
        normalizedRequest: {},
        provider: "fake",
        status: "in_progress",
        userId: state.ownerUserId,
        userMessageId: message.id
      }
    });
    await tx.knowledgeRunScope.create({
      data: {
        budgetPolicy: json(DEFAULT_KNOWLEDGE_BUDGET_POLICY),
        exclusions: [],
        modelRunId: run.id,
        resolvedBaseCount: 0,
        resolvedSourceCount: entries.length,
        selection: json({
          baseIds: [],
          mode: "explicit",
          sourceIds: entries.map((entry) => entry.sourceId),
          version: 1
        })
      }
    });
    const profile = await tx.knowledgeRunProfileBinding.create({
      data: {
        embeddingConnectionId: state.connectionId,
        embeddingCredentialId: credentialId,
        embeddingCredentialSource: "default",
        embeddingCredentialVersionId: credentialVersionId,
        embeddingExecutionSnapshot: json({ synthetic: true }),
        embeddingProviderModelId: state.modelId,
        modelRunId: run.id,
        ordinal: 0,
        profileRevisionId: state.profileRevisionId,
        targetDimension: 1_024,
        vectorSpaceFingerprint
      }
    });
    await tx.knowledgeRunSourceBinding.createMany({
      data: entries.map((entry, ordinal) => ({
        accessProvenance: json({
          authority: { knowledgeBaseIds: [], owner: true, projectId: null },
          selectionProvenance: ["explicit_source"]
        }),
        baseProvenance: [],
        directSelected: true,
        fileNameSnapshot: entry.source.fileName,
        modelRunId: run.id,
        ordinal,
        profileBindingId: profile.id,
        readinessState: "ready",
        selectionKind: "direct",
        sourceAlias: `S${ordinal + 1}`,
        sourceArtifactId: entry.artifactId,
        sourceId: entry.sourceId,
        sourceNameSnapshot: entry.source.displayName,
        sourceVersionId: entry.versionId,
        sourceVersionNumber: 1
      }))
    });
    const exactArguments = {
      caseMode: "sensitive",
      cursor: null,
      field: "body",
      limit: 10,
      match: "token",
      sourceAliases: null,
      value: "FLOOD_TOKEN_104"
    };
    const discoveryArguments = {
      cursor: null,
      fields: ["heading"],
      limit: 1,
      query: "Quarterly"
    };
    const exactCall = await tx.modelRunToolCall.create({
      data: {
        arguments: json(exactArguments),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: `${prefix}-exact-call`,
        roundIndex: 0,
        startedAt: now,
        state: "running",
        toolName: KNOWLEDGE_EXACT_TOOL_NAME
      }
    });
    const discoveryCall = await tx.modelRunToolCall.create({
      data: {
        arguments: json(discoveryArguments),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: `${prefix}-discovery-call`,
        roundIndex: 1,
        startedAt: now,
        state: "running",
        toolName: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
      }
    });
    const contextualExactCall = await tx.modelRunToolCall.create({
      data: {
        arguments: json({
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "token",
          sourceAliases: null,
          value: "TAILVALUE42"
        }),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: `${prefix}-contextual-exact-call`,
        roundIndex: 2,
        startedAt: now,
        state: "running",
        toolName: KNOWLEDGE_EXACT_TOOL_NAME
      }
    });
    return Object.freeze({
      chatId: chat.id,
      contextualExactToolCallId: contextualExactCall.id,
      credentialId,
      credentialVersionId,
      discoveryToolCallId: discoveryCall.id,
      exactToolCallId: exactCall.id,
      runId: run.id
    });
  }, { timeout: 120_000 });
}

async function cleanupRuntime(client: PrismaClient, fixture: RuntimeFixture): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.modelRun.delete({ where: { id: fixture.runId } });
    await tx.chat.delete({ where: { id: fixture.chatId } });
    await tx.providerCredential.update({
      data: { activeVersionId: null },
      where: { id: fixture.credentialId }
    });
    await tx.providerCredentialVersion.delete({ where: { id: fixture.credentialVersionId } });
    await tx.providerCredential.delete({ where: { id: fixture.credentialId } });
  }, { timeout: 120_000 });
}

describe("Prisma exact/discovery admitted-run vertical slice", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists exact/discovery receipts and pages distinct Sources after metadata skew", async () => {
    const initial = createKnowledgeHierarchicalEvaluationFixture();
    const flood = metadataEntry({ blockCount: 105, id: "metadata-flood", state: initial });
    const tail = metadataEntry({ blockCount: 1, id: "metadata-tail", state: initial });
    const state: KnowledgeHierarchicalEvaluationFixture = Object.freeze({
      ...initial,
      entries: Object.freeze([...initial.entries, flood, tail])
    });
    let runtime: RuntimeFixture | null = null;
    try {
      await persistKnowledgeHierarchicalEvaluationFixture(prisma, state);
      runtime = await persistRuntime(prisma, state, [flood, tail]);
      const hierarchy = await prisma.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
        select: { id: true },
        where: { sourceArtifactId: flood.artifactId, state: "ready" }
      });
      await expect(prisma.knowledgeArtifactExactEntry.count({
        where: { indexArtifactId: hierarchy.id, kind: "heading" }
      })).resolves.toBeGreaterThan(100);
      const tailHierarchy = await prisma.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
        select: { id: true },
        where: { sourceArtifactId: tail.artifactId, state: "ready" }
      });
      await expect(prisma.knowledgeArtifactPassageIndex.count({
        where: { documentContext: { not: Prisma.DbNull }, indexArtifactId: tailHierarchy.id }
      })).resolves.toBe(2);

      const store = createPrismaKnowledgeRetrievalStore(prisma);
      const sourceArtifactIds = [flood.artifactId, tail.artifactId];
      const exactFilenamePage1 = await store.findExact!({
        request: {
          caseMode: "insensitive",
          cursor: null,
          field: "filename",
          limit: 1,
          match: "phrase",
          value: "metadata"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(exactFilenamePage1.passages).toHaveLength(1);
      expect(exactFilenamePage1.fields).toEqual(["filename"]);
      expect(exactFilenamePage1.nextCursor).not.toBeNull();
      const exactFilenamePage2 = await store.findExact!({
        request: {
          caseMode: "insensitive",
          cursor: exactFilenamePage1.nextCursor,
          field: "filename",
          limit: 1,
          match: "phrase",
          value: "metadata"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(new Set([
        exactFilenamePage1.passages[0]!.sourceArtifactId,
        exactFilenamePage2.passages[0]!.sourceArtifactId
      ])).toEqual(new Set(sourceArtifactIds));
      expect([
        ...exactFilenamePage1.passages,
        ...exactFilenamePage2.passages
      ].find((passage) => passage.sourceArtifactId === tail.artifactId)?.documentContext)
        .toBeUndefined();

      const contextualBodyHit = await store.findExact!({
        request: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "token",
          value: "TAILVALUE42"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(contextualBodyHit.passages).toEqual([
        expect.objectContaining({
          documentContext: expect.objectContaining({
            locator: expect.objectContaining({ kind: "table_row", rowIndex: 1 })
          }),
          sourceArtifactId: tail.artifactId,
          text: expect.stringContaining(
            "Metric\tDate\tActual\tReference\tUnit\tIdentifier\n" +
              "TailPressure\t2026-08-20\t42\t40\tkPa\tTAILVALUE42"
          )
        })
      ]);

      const sensitivePhraseMiss = await store.findExact!({
        request: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "phrase",
          value: "SAFE ROW 104"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(sensitivePhraseMiss.passages).toEqual([]);
      const insensitivePhraseHit = await store.findExact!({
        request: {
          caseMode: "insensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "phrase",
          value: "SAFE ROW 104"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(insensitivePhraseHit.passages).toEqual([
        expect.objectContaining({ sourceArtifactId: flood.artifactId })
      ]);
      const tokenHit = await store.findExact!({
        request: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "token",
          value: "FLOOD_TOKEN_104"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(tokenHit.passages).toEqual([
        expect.objectContaining({ sourceArtifactId: flood.artifactId })
      ]);
      const safePatternHit = await store.findExact!({
        request: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "pattern",
          value: "FLOOD_TOKEN_10[34]"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(safePatternHit.passages.length).toBeGreaterThan(0);
      expect(safePatternHit.fields).toEqual(
        Array.from({ length: safePatternHit.passages.length }, () => "body")
      );

      const discoveryPage1 = await store.discoverSources!({
        request: {
          cursor: null,
          fields: ["heading"],
          limit: 1,
          query: "Quarterly"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(discoveryPage1.sources).toHaveLength(1);
      expect(discoveryPage1.nextCursor).not.toBeNull();
      const discoveryPage2 = await store.discoverSources!({
        request: {
          cursor: discoveryPage1.nextCursor,
          fields: ["heading"],
          limit: 1,
          query: "Quarterly"
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(new Set([
        discoveryPage1.sources[0]!.sourceAlias,
        discoveryPage2.sources[0]!.sourceAlias
      ])).toEqual(new Set(["S1", "S2"]));
      expect(JSON.stringify([discoveryPage1, discoveryPage2])).not.toMatch(
        /safe row|FLOOD_TOKEN/u
      );
      const bodyOnlyDiscovery = await store.discoverSources!({
        request: {
          cursor: null,
          fields: ["filename", "heading", "source_name", "tag", "title"],
          limit: 10,
          query: bodyOnlyMarker
        },
        runId: runtime.runId,
        sourceArtifactIds,
        userId: state.ownerUserId
      });
      expect(bodyOnlyDiscovery).toMatchObject({
        candidateCount: 0,
        nextCursor: null,
        sources: []
      });

      const timeoutRepository = createPrismaKnowledgeHierarchicalRetrievalRepository({
        $queryRaw: prisma.$queryRaw.bind(prisma),
        $transaction: async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          prisma.$transaction(async (tx) => operation({
            $executeRaw: tx.$executeRaw.bind(tx),
            $queryRaw: async () => tx.$queryRaw`SELECT pg_sleep(0.05)`
          } as never))
      } as never, { statementTimeoutMs: 1 });
      await expect(timeoutRepository.findExact({
        runId: runtime.runId,
        scopeKind: "admitted_run",
        sourceArtifactIds,
        userId: state.ownerUserId,
        field: "body",
        limit: 1,
        operation: "phrase",
        query: "safe row"
      })).rejects.toMatchObject({ code: "knowledge_exact_query_timed_out" });

      const foreign = state.entries.find((entry) => entry.ownerUserId === state.foreignUserId)!;
      await expect(store.findExact!({
        request: {
          caseMode: "insensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "phrase",
          value: "classified evidence"
        },
        runId: runtime.runId,
        sourceArtifactIds: [flood.artifactId, foreign.artifactId],
        userId: state.ownerUserId
      })).rejects.toThrow("knowledge_exact_scope_invalid");

      const embeddingResolve = vi.fn(async () => {
        throw new Error("knowledge_embedding_must_not_run");
      });
      const executor = createKnowledgeToolExecutor({
        embeddingRuntime: { resolve: embeddingResolve },
        store
      });
      const exactResult = await executor.execute({
        arguments: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "token",
          sourceAliases: null,
          value: "FLOOD_TOKEN_104"
        },
        id: "stateful-exact-provider-call",
        name: KNOWLEDGE_EXACT_TOOL_NAME
      }, {
        persistedToolCallId: runtime.exactToolCallId,
        request: {} as never,
        runId: runtime.runId,
        userId: state.ownerUserId
      });
      expect(knowledgeEvidenceFromToolResult(exactResult)).toMatchObject({
        embeddingExecutions: [],
        exact: {
          caseMode: "sensitive",
          field: "body",
          match: "token",
          matches: [{ field: "body", resultOrdinal: 0 }],
          value: "FLOOD_TOKEN_104"
        },
        fusion: "none",
        operation: "find_exact"
      });
      const contextualExactResult = await executor.execute({
        arguments: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 10,
          match: "token",
          sourceAliases: null,
          value: "TAILVALUE42"
        },
        id: "stateful-contextual-exact-provider-call",
        name: KNOWLEDGE_EXACT_TOOL_NAME
      }, {
        persistedToolCallId: runtime.contextualExactToolCallId,
        request: {} as never,
        runId: runtime.runId,
        userId: state.ownerUserId
      });
      expect(knowledgeEvidenceFromToolResult(contextualExactResult)).toMatchObject({
        operation: "find_exact",
        results: [{
          documentContext: {
            locator: { kind: "table_row", rowIndex: 1 },
            observations: expect.arrayContaining([
              expect.objectContaining({
                date: "2026-08-20",
                metric: "TailPressure",
                normalizedValue: "42",
                role: "observation",
                unit: "kPa"
              })
            ])
          },
          sourceArtifactId: tail.artifactId
        }]
      });
      const discoveryResult = await executor.execute({
        arguments: {
          cursor: null,
          fields: ["heading"],
          limit: 1,
          query: "Quarterly"
        },
        id: "stateful-discovery-provider-call",
        name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
      }, {
        persistedToolCallId: runtime.discoveryToolCallId,
        request: {} as never,
        runId: runtime.runId,
        userId: state.ownerUserId
      });
      const discoveryEvidence = knowledgeEvidenceFromToolResult(discoveryResult);
      expect(discoveryEvidence).toMatchObject({
        discovery: {
          fields: ["heading"],
          limit: 1,
          sources: [{ matchedFields: ["heading"], readiness: "ready" }]
        },
        embeddingExecutions: [],
        fusion: "none",
        operation: "discover_sources",
        results: []
      });
      expect(discoveryEvidence?.providerText).not.toMatch(/safe row|FLOOD_TOKEN/u);
      expect(embeddingResolve).not.toHaveBeenCalled();

      const [storedExact, storedDiscovery] = await Promise.all([
        prisma.knowledgeRun.findUniqueOrThrow({
          select: { id: true, readReceipt: true },
          where: { modelRunToolCallId: runtime.exactToolCallId }
        }),
        prisma.knowledgeRun.findUniqueOrThrow({
          select: { id: true, readReceipt: true },
          where: { modelRunToolCallId: runtime.discoveryToolCallId }
        })
      ]);
      expect(storedExact.readReceipt).toMatchObject({ field: "body", match: "token", version: 1 });
      expect(storedDiscovery.readReceipt).toMatchObject({ fields: ["heading"], version: 1 });
      const evidencePackage = await loadKnowledgeEvidencePackage(prisma, {
        runId: runtime.runId,
        userId: state.ownerUserId
      });
      expect(evidencePackage).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({
          provenance: expect.arrayContaining([expect.objectContaining({
            fusion: "none",
            operation: "find_exact",
            resultOrdinal: 0
          })]),
          state: "available"
        })])
      });
      const exactItem = evidencePackage?.items.find((item) =>
        item.excerpt?.includes("FLOOD_TOKEN_104"));
      const exactHandle = exactItem?.handle;
      expect(exactHandle).toMatch(/^K[1-9]\d*$/u);
      expect(groundKnowledgeAnswer({
        answer: `The source contains FLOOD_TOKEN_104 [${exactHandle}].`,
        evidence: evidencePackage!
      })).toMatchObject({ outcome: "passed", repairCount: 0 });
      const contextualItem = evidencePackage?.items.find((item) =>
        item.excerpt?.includes("TAILVALUE42"));
      expect(contextualItem).toMatchObject({
        contextBoundaries: {
          documentContext: {
            locator: { kind: "table_row", rowIndex: 1 },
            observations: expect.arrayContaining([
              expect.objectContaining({ metric: "TailPressure", role: "observation" })
            ])
          }
        },
        sourceArtifactId: tail.artifactId,
        state: "available",
        textTruncated: false
      });
      expect(groundKnowledgeAnswer({
        answer: `TailPressure actual is 42 kPa on 2026-08-20 [${contextualItem?.handle}].`,
        evidence: evidencePackage!
      })).toMatchObject({ outcome: "passed", repairCount: 0 });

      const { caseMode: _caseMode, ...exactMissingCaseMode } =
        storedExact.readReceipt as Record<string, unknown>;
      await expect(prisma.knowledgeRun.update({
        data: { readReceipt: json(exactMissingCaseMode) },
        where: { id: storedExact.id }
      })).rejects.toThrow();
      await expect(prisma.knowledgeRun.update({
        data: { readReceipt: json({ ...(storedExact.readReceipt as object), field: "source_name" }) },
        where: { id: storedExact.id }
      })).rejects.toThrow();
      const { fields: _fields, ...discoveryMissingFields } =
        storedDiscovery.readReceipt as Record<string, unknown>;
      await expect(prisma.knowledgeRun.update({
        data: { readReceipt: json(discoveryMissingFields) },
        where: { id: storedDiscovery.id }
      })).rejects.toThrow();
      await expect(prisma.knowledgeRun.update({
        data: {
          readReceipt: json({
            ...(storedDiscovery.readReceipt as object),
            sources: [{
              ...((storedDiscovery.readReceipt as { sources: object[] }).sources[0]!),
              body: "must never be admitted"
            }]
          })
        },
        where: { id: storedDiscovery.id }
      })).rejects.toThrow();
    } finally {
      if (runtime) await cleanupRuntime(prisma, runtime);
      await cleanupKnowledgeHierarchicalEvaluationFixture(prisma, state);
    }
  }, 240_000);
});

import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import {
  buildKnowledgeHierarchicalIndex,
  KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
  type KnowledgeHierarchicalIndexPlan
} from "./hierarchicalIndex";
import type { StoredKnowledgeNormalizedDocument } from "./normalizedDocument";

type HierarchicalIndexWriteClient = Pick<
  Prisma.TransactionClient,
  | "$queryRaw"
  | "knowledgeArtifactDocumentIndex"
  | "knowledgeArtifactExactEntry"
  | "knowledgeArtifactPassageIndex"
  | "knowledgeArtifactSectionIndex"
  | "knowledgeHierarchicalIndexArtifact"
>;

type SourceArtifactRow = Readonly<{
  description: string;
  fileName: string;
  mimeType: string;
  sourceArtifactId: string;
  sourceArtifactState: "failed" | "pending" | "processing" | "ready";
  sourceName: string;
  sourceVersionId: string;
  tags: string[];
}>;

export type KnowledgeHierarchicalIndexPersistenceErrorCode =
  | "knowledge_hierarchical_index_conflict"
  | "knowledge_hierarchical_index_parent_unavailable"
  | "knowledge_hierarchical_index_settlement_failed";

export class KnowledgeHierarchicalIndexPersistenceError extends Error {
  constructor(readonly code: KnowledgeHierarchicalIndexPersistenceErrorCode) {
    super(code);
    this.name = "KnowledgeHierarchicalIndexPersistenceError";
  }
}

async function lockSourceArtifact(
  tx: HierarchicalIndexWriteClient,
  input: Readonly<{ sourceArtifactId: string; sourceVersionId: string }>
): Promise<SourceArtifactRow | null> {
  const rows = await tx.$queryRaw<SourceArtifactRow[]>(Prisma.sql`
    SELECT
      artifact."id" AS "sourceArtifactId",
      artifact."sourceVersionId",
      artifact."state"::text AS "sourceArtifactState",
      version."fileName",
      version."mimeType",
      source."name" AS "sourceName",
      source."description",
      source."tags"
    FROM "KnowledgeSourceIndexArtifact" AS artifact
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = artifact."sourceVersionId"
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = version."sourceId"
    WHERE artifact."id" = ${input.sourceArtifactId}
      AND artifact."sourceVersionId" = ${input.sourceVersionId}
    FOR UPDATE OF artifact
  `);
  return rows[0] ?? null;
}

function assertPlan(plan: KnowledgeHierarchicalIndexPlan): void {
  if (
    plan.schemaVersion !== KNOWLEDGE_HIERARCHICAL_INDEX_VERSION ||
    !/^[0-9a-f]{64}$/u.test(plan.checksum) ||
    plan.sections.length < 1 ||
    plan.passages.length < 1 ||
    plan.exactEntries.length < 1 ||
    plan.passages.some((passage, index) => passage.ordinal !== index) ||
    plan.sections.some((section, index) => section.ordinal !== index) ||
    plan.exactEntries.some((entry, index) => entry.ordinal !== index)
  ) throw new KnowledgeHierarchicalIndexPersistenceError(
    "knowledge_hierarchical_index_settlement_failed"
  );
}

async function persistPlan(
  tx: HierarchicalIndexWriteClient,
  input: Readonly<{
    now: Date;
    plan: KnowledgeHierarchicalIndexPlan;
    sourceVersionId: string;
  }>
): Promise<"created" | "reused"> {
  const { now, plan } = input;
  assertPlan(plan);
  const existing = await tx.knowledgeHierarchicalIndexArtifact.findUnique({
    select: {
      checksum: true,
      documentCount: true,
      exactEntryCount: true,
      passageCount: true,
      sectionCount: true,
      state: true
    },
    where: {
      sourceArtifactId_schemaVersion: {
        schemaVersion: plan.schemaVersion,
        sourceArtifactId: plan.sourceArtifactId
      }
    }
  });
  if (existing?.state === "ready") {
    if (
      existing.checksum?.trim() === plan.checksum &&
      existing.documentCount === 1 &&
      existing.sectionCount === plan.sections.length &&
      existing.passageCount === plan.passages.length &&
      existing.exactEntryCount === plan.exactEntries.length
    ) return "reused";
    throw new KnowledgeHierarchicalIndexPersistenceError(
      "knowledge_hierarchical_index_conflict"
    );
  }
  if (existing) {
    await tx.knowledgeHierarchicalIndexArtifact.delete({ where: { id: plan.id } });
  }

  await tx.knowledgeHierarchicalIndexArtifact.create({
    data: {
      createdAt: now,
      derivationMode: plan.derivationMode,
      id: plan.id,
      schemaVersion: plan.schemaVersion,
      sourceArtifactId: plan.sourceArtifactId,
      sourceVersionId: input.sourceVersionId,
      state: "building",
      updatedAt: now
    }
  });
  const document = plan.document;
  await tx.knowledgeArtifactDocumentIndex.create({
    data: {
      contentHash: document.contentHash,
      createdAt: now,
      description: document.description,
      documentType: document.documentType,
      entities: [...document.entities],
      entitiesText: document.entities.join(" "),
      fileName: document.fileName,
      indexArtifactId: plan.id,
      keywords: [...document.keywords],
      keywordsText: document.keywords.join(" "),
      languageConfig: document.languageConfig,
      languages: [...document.languages],
      metadataText: document.metadataText,
      outline: [...document.outline],
      outlineText: document.outline.join(" "),
      pageCount: document.pageCount,
      sourceName: document.sourceName,
      summary: document.summary,
      tags: [...document.tags],
      tagsText: document.tags.join(" "),
      title: document.title
    }
  });
  await tx.knowledgeArtifactSectionIndex.createMany({
    data: plan.sections.map((section) => ({
      contentHash: section.contentHash,
      createdAt: now,
      documentTitle: document.title ?? "",
      entities: [...section.entities],
      entitiesText: section.entities.join(" "),
      fileName: document.fileName,
      headingPath: [...section.headingPath],
      headingText: section.headingPath.join(" "),
      id: section.id,
      indexArtifactId: plan.id,
      keywords: [...section.keywords],
      keywordsText: section.keywords.join(" "),
      label: section.label,
      languageConfig: section.languageConfig,
      languages: [...section.languages],
      ordinal: section.ordinal,
      page: section.page,
      pageEnd: section.pageEnd,
      passageEnd: section.passageEnd,
      passageStart: section.passageStart,
      sourceDescription: document.description,
      summary: section.summary,
      tags: [...document.tags],
      tagsText: document.tags.join(" ")
    }))
  });
  await tx.knowledgeArtifactPassageIndex.createMany({
    data: plan.passages.map((passage) => ({
      contentHash: passage.contentHash,
      contextPrefix: passage.contextPrefix,
      createdAt: now,
      documentContext: passage.documentContext === null
        ? Prisma.DbNull
        : passage.documentContext as Prisma.InputJsonValue,
      documentTitle: document.title ?? "",
      embeddingTextHash: passage.embeddingTextHash,
      fileName: document.fileName,
      headingPath: [...passage.headingPath],
      headingText: passage.headingPath.join(" "),
      id: passage.id,
      indexArtifactId: plan.id,
      languageConfig: passage.languageConfig,
      languages: [...passage.languages],
      ordinal: passage.ordinal,
      page: passage.page,
      pageEnd: passage.pageEnd,
      sectionId: passage.sectionId,
      sourceBlockEnd: passage.sourceBlockEnd,
      sourceBlockIds: [...passage.sourceBlockIds],
      sourceBlockStart: passage.sourceBlockStart,
      sourceDescription: document.description,
      sourceName: document.sourceName,
      tags: [...document.tags],
      tagsText: document.tags.join(" "),
      text: passage.text,
      tokenCount: passage.tokenCount
    }))
  });
  await tx.knowledgeArtifactExactEntry.createMany({
    data: plan.exactEntries.map((entry) => ({
      createdAt: now,
      id: entry.id,
      indexArtifactId: plan.id,
      kind: entry.kind,
      normalizedValue: entry.normalizedValue,
      ordinal: entry.ordinal,
      page: entry.page,
      pageEnd: entry.pageEnd,
      passageId: entry.passageId,
      sectionId: entry.sectionId,
      value: entry.value,
      valueHash: entry.valueHash
    }))
  });
  const settled = await tx.knowledgeHierarchicalIndexArtifact.updateMany({
    data: {
      checksum: plan.checksum,
      documentCount: 1,
      exactEntryCount: plan.exactEntries.length,
      passageCount: plan.passages.length,
      readyAt: now,
      sectionCount: plan.sections.length,
      state: "ready",
      updatedAt: now
    },
    where: { id: plan.id, state: "building" }
  });
  if (settled.count !== 1) throw new KnowledgeHierarchicalIndexPersistenceError(
    "knowledge_hierarchical_index_settlement_failed"
  );
  return "created";
}

export async function buildAndPersistKnowledgeHierarchicalIndex(
  tx: HierarchicalIndexWriteClient,
  input: Readonly<{
    chunks: readonly KnowledgeChunkPlanEntry[];
    document: StoredKnowledgeNormalizedDocument | null;
    now: Date;
    sourceArtifactId: string;
    sourceVersionId: string;
  }>
): Promise<"created" | "reused"> {
  const source = await lockSourceArtifact(tx, input);
  if (!source || source.sourceArtifactState === "failed") {
    throw new KnowledgeHierarchicalIndexPersistenceError(
      "knowledge_hierarchical_index_parent_unavailable"
    );
  }
  const plan = buildKnowledgeHierarchicalIndex({
    chunks: input.chunks,
    description: source.description,
    document: input.document,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sourceArtifactId: source.sourceArtifactId,
    sourceName: source.sourceName,
    tags: source.tags
  });
  return persistPlan(tx, { now: input.now, plan, sourceVersionId: source.sourceVersionId });
}

export function createPrismaKnowledgeHierarchicalIndexRepository(
  client: PrismaClient = prisma
) {
  return {
    async build(input: Readonly<{
      chunks: readonly KnowledgeChunkPlanEntry[];
      document: StoredKnowledgeNormalizedDocument | null;
      now: Date;
      sourceArtifactId: string;
      sourceVersionId: string;
    }>): Promise<"created" | "reused"> {
      return client.$transaction((tx) => buildAndPersistKnowledgeHierarchicalIndex(tx, input));
    }
  };
}

export type PrismaKnowledgeHierarchicalIndexRepository = ReturnType<
  typeof createPrismaKnowledgeHierarchicalIndexRepository
>;

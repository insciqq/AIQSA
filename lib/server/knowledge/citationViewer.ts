import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  KNOWLEDGE_VIEWER_MAX_BLOCKS,
  KNOWLEDGE_VIEWER_MAX_BOXES,
  KNOWLEDGE_VIEWER_MAX_TABLE_CELLS,
  KNOWLEDGE_VIEWER_MAX_WORKBOOK_CELLS,
  type KnowledgeCitationViewer,
  type KnowledgeSourceViewer,
  type KnowledgeViewerAvailable,
  type KnowledgeViewerBlock,
  type KnowledgeViewerBoundingBox,
  type KnowledgeViewerVisualEvidence,
  type KnowledgeViewerWorkbook,
  type KnowledgeViewerSourceStatus
} from "../../contracts/knowledgeCitations";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import type { StorageAdapter } from "../uploads/storage";
import { resolveChatAccess, type ChatAccess } from "../projects/access";
import { getKnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import {
  decodeKnowledgeNormalizedDocument,
  type KnowledgeNormalizedBlock,
  type StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";
import { decodeKnowledgeRetrievedPassage } from "./toolResult";
import { decodeStructuredAnalysisResult, type StructuredAnalysisResult } from "./structuredData";
import {
  decodeKnowledgeVisualAnalysisResult,
  type KnowledgeVisualAnalysisResult
} from "./visualEvidence";
import { utils as spreadsheetUtils } from "xlsx";

type CitationViewerClient = PrismaClient | Prisma.TransactionClient;

export type KnowledgeViewerOriginal = Readonly<{
  byteSize: number;
  checksum: string;
  fileName: string;
  mimeType: "application/pdf" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  storageKey: string;
}>;

export type ResolvedKnowledgeCitationViewer = Readonly<{
  citation: KnowledgeCitationViewer;
  original: KnowledgeViewerOriginal | null;
}>;

export type ResolvedKnowledgeSourceViewer = Readonly<{
  original: KnowledgeViewerOriginal | null;
  source: KnowledgeSourceViewer;
}>;

type CurrentBase = Readonly<{
  name: string;
  ownerUserId: string;
  trashedAt: Date | null;
}>;

type ViewerSourceVersion = Readonly<{
  artifacts: readonly Readonly<{
    hierarchicalIndexes: readonly Readonly<{
      passageIndexes: readonly Readonly<{
        headingPath: readonly string[];
        page: number;
        pageEnd: number;
        sourceBlockEnd: number;
        sourceBlockIds: readonly string[];
        sourceBlockStart: number;
      }>[];
    }>[];
    normalizedTextByteSize: number | null;
    normalizedTextChecksum: string | null;
    normalizedTextStorageKey: string | null;
    state: string;
  }>[];
  byteSize: number;
  checksum: string;
  fileName: string;
  id: string;
  mimeType: string;
  originalStorageKey: string | null;
  source: Readonly<{
    baseMemberships: readonly Readonly<{ removedAt: Date | null }>[];
    currentVersionId: string | null;
    deletionRequestedAt: Date | null;
    name: string;
    ownerUserId: string;
    trashedAt: Date | null;
  }>;
  versionNumber: number;
}>;

type EvidenceItem = Readonly<{
  baseName: string | null;
  contextBoundaries: Prisma.JsonValue | null;
  excerpt: string | null;
  fileName: string | null;
  handle: string;
  headingPath: readonly string[];
  knowledgeBaseId: string | null;
  locator: Prisma.JsonValue | null;
  page: number | null;
  passageId: string | null;
  sourceArtifactId: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceVersionId: string | null;
  sourceVersionNumber: number | null;
  state: string;
  textTruncated: boolean | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installationOrGroupPublication(groupIds: readonly string[]): Prisma.KnowledgeBaseWhereInput {
  return {
    archivedAt: null,
    publications: {
      some: {
        OR: [
          { scope: "installation" },
          ...(groupIds.length > 0
            ? [{
                group: { archivedAt: null },
                groupId: { in: [...groupIds] },
                scope: "group" as const
              }]
            : [])
        ]
      }
    },
    trashedAt: null
  };
}

async function currentBaseForAccess(
  client: CitationViewerClient,
  input: Readonly<{
    access: ChatAccess;
    knowledgeBaseId: string;
    userId: string;
  }>
): Promise<CurrentBase | null> {
  if (input.access.kind === "project") {
    return client.knowledgeBase.findFirst({
      select: { name: true, ownerUserId: true, trashedAt: true },
      where: {
        deletionRequestedAt: null,
        id: input.knowledgeBaseId,
        projectBindings: { some: { projectId: input.access.project.projectId } },
        trashedAt: null
      }
    });
  }

  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  return client.knowledgeBase.findFirst({
    select: { name: true, ownerUserId: true, trashedAt: true },
    where: {
      deletionRequestedAt: null,
      id: input.knowledgeBaseId,
      OR: [
        { ownerUserId: input.userId },
        installationOrGroupPublication(memberships.map(({ groupId }) => groupId))
      ]
    }
  });
}

async function currentBaseForSourceLibrary(
  client: CitationViewerClient,
  input: Readonly<{ knowledgeBaseId: string; userId: string }>
): Promise<CurrentBase | null> {
  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  return client.knowledgeBase.findFirst({
    select: { name: true, ownerUserId: true, trashedAt: true },
    where: {
      deletionRequestedAt: null,
      id: input.knowledgeBaseId,
      OR: [
        { ownerUserId: input.userId },
        installationOrGroupPublication(memberships.map(({ groupId }) => groupId))
      ]
    }
  });
}

function originalReference(version: Readonly<{
  byteSize: number;
  checksum: string;
  fileName: string;
  mimeType: string;
  originalStorageKey: string | null;
}>): KnowledgeViewerOriginal | null {
  const supported = new Set<KnowledgeViewerOriginal["mimeType"]>([
    "application/pdf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]);
  return supported.has(version.mimeType as KnowledgeViewerOriginal["mimeType"]) &&
    version.originalStorageKey
    ? {
        byteSize: version.byteSize,
        checksum: version.checksum,
        fileName: version.fileName,
        mimeType: version.mimeType as KnowledgeViewerOriginal["mimeType"],
        storageKey: version.originalStorageKey
      }
    : null;
}

async function normalizedDocument(
  storage: StorageAdapter,
  artifact: Readonly<{
    normalizedTextByteSize: number | null;
    normalizedTextChecksum: string | null;
    normalizedTextStorageKey: string | null;
  }> | null
): Promise<StoredKnowledgeNormalizedDocument | null> {
  if (!artifact?.normalizedTextStorageKey || !artifact.normalizedTextByteSize ||
    !artifact.normalizedTextChecksum) return null;
  const config = getKnowledgeExtractionConfig();
  try {
    const stored = await storage.getObject(artifact.normalizedTextStorageKey, {
      maxBytes: config.maxNormalizedObjectBytes
    });
    if (stored.body.byteLength !== artifact.normalizedTextByteSize ||
      createHash("sha256").update(stored.body).digest("hex") !== artifact.normalizedTextChecksum) {
      return null;
    }
    return decodeKnowledgeNormalizedDocument(stored.body, config);
  } catch {
    return null;
  }
}

function safeTable(block: KnowledgeNormalizedBlock): KnowledgeViewerBlock["table"] {
  if (!block.table) return null;
  const cells = block.table.cells.slice(0, KNOWLEDGE_VIEWER_MAX_TABLE_CELLS);
  return {
    cells: cells.map((cell) => ({ ...cell })),
    columnCount: block.table.columnCount,
    rowCount: block.table.rowCount,
    truncated: cells.length < block.table.cells.length
  };
}

function viewerBlock(
  block: KnowledgeNormalizedBlock,
  relation: KnowledgeViewerBlock["relation"]
): KnowledgeViewerBlock {
  return {
    boundingBoxes: block.boundingBoxes.slice(0, KNOWLEDGE_VIEWER_MAX_BOXES).map((box) => ({
      ...box
    })),
    headingPath: [...block.headingPath],
    pageEnd: block.locator.pageEnd,
    pageStart: block.locator.pageStart,
    relation,
    table: safeTable(block),
    text: block.text,
    type: block.type
  };
}

function contextBlocks(
  document: StoredKnowledgeNormalizedDocument | null,
  target: Readonly<{
    sourceBlockEnd?: number;
    sourceBlockIds?: readonly string[];
    sourceBlockStart?: number;
  }> | null
): readonly KnowledgeViewerBlock[] {
  if (!document || document.blocks.length === 0) return [];
  const targetIds = new Set(target?.sourceBlockIds ?? []);
  const targetBlocks = document.blocks.filter((block) =>
    targetIds.size > 0
      ? targetIds.has(block.id)
      : target?.sourceBlockStart !== undefined && target.sourceBlockEnd !== undefined
        ? block.order >= target.sourceBlockStart && block.order <= target.sourceBlockEnd
        : block.order === 0
  ).slice(0, 8);
  const selected = targetBlocks.length > 0 ? targetBlocks : document.blocks.slice(0, 1);
  const firstOrder = selected[0]?.order ?? 0;
  const lastOrder = selected.at(-1)?.order ?? firstOrder;
  const before = document.blocks
    .filter((block) => block.order < firstOrder)
    .slice(-2)
    .map((block) => viewerBlock(block, "before"));
  const exact = selected.map((block) => viewerBlock(block, "target"));
  const remaining = Math.max(0, KNOWLEDGE_VIEWER_MAX_BLOCKS - before.length - exact.length);
  const after = document.blocks
    .filter((block) => block.order > lastOrder)
    .slice(0, Math.min(2, remaining))
    .map((block) => viewerBlock(block, "after"));
  return [...before, ...exact, ...after].slice(0, KNOWLEDGE_VIEWER_MAX_BLOCKS);
}

function targetBoxes(blocks: readonly KnowledgeViewerBlock[]) {
  return blocks
    .filter((block) => block.relation === "target")
    .flatMap((block) => block.boundingBoxes)
    .slice(0, KNOWLEDGE_VIEWER_MAX_BOXES);
}

function availableViewer(input: Readonly<{
  baseName: string | null;
  blocks: readonly KnowledgeViewerBlock[];
  excerpt: string;
  excerptTruncated: boolean;
  fileName: string;
  headingPath: readonly string[];
  mimeType: string;
  name: string;
  originalKind: "image" | "pdf" | null;
  locatorBoxes?: readonly KnowledgeViewerBoundingBox[];
  pageEnd: number;
  pageStart: number;
  statuses: readonly KnowledgeViewerSourceStatus[];
  versionNumber: number;
  visual: KnowledgeViewerVisualEvidence | null;
  workbook: KnowledgeViewerWorkbook | null;
}>): KnowledgeViewerAvailable {
  return {
    blocks: input.blocks,
    excerpt: input.excerpt,
    excerptTruncated: input.excerptTruncated,
    headingPath: [...input.headingPath],
    locator: {
      boundingBoxes: [...(input.locatorBoxes ?? targetBoxes(input.blocks))]
        .slice(0, KNOWLEDGE_VIEWER_MAX_BOXES),
      pageEnd: input.pageEnd,
      pageStart: input.pageStart
    },
    originalKind: input.originalKind,
    source: {
      baseName: input.baseName,
      fileName: input.fileName,
      mimeType: input.mimeType,
      name: input.name,
      statuses: [...input.statuses],
      versionNumber: input.versionNumber
    },
    state: "available",
    visual: input.visual,
    workbook: input.workbook
  };
}

function structuredAnalysis(item: EvidenceItem): StructuredAnalysisResult | null {
  return record(item.contextBoundaries)
    ? decodeStructuredAnalysisResult(item.contextBoundaries.structuredAnalysis)
    : null;
}

function visualAnalysis(item: EvidenceItem): KnowledgeVisualAnalysisResult | null {
  return record(item.contextBoundaries)
    ? decodeKnowledgeVisualAnalysisResult(item.contextBoundaries.visualAnalysis)
    : null;
}

function visualViewer(
  analysis: KnowledgeVisualAnalysisResult | null
): KnowledgeViewerVisualEvidence | null {
  return analysis ? {
    caption: analysis.caption,
    description: analysis.description,
    kind: analysis.kind,
    label: analysis.label,
    status: analysis.status,
    warnings: [...analysis.warnings]
  } : null;
}

function workbookViewer(
  document: StoredKnowledgeNormalizedDocument | null,
  analysis: StructuredAnalysisResult | null
): KnowledgeViewerWorkbook | null {
  if (!document?.workbook || !analysis) return null;
  let remaining = KNOWLEDGE_VIEWER_MAX_WORKBOOK_CELLS;
  const ranges = analysis.receipt.inputRanges.map((inputRange) => {
    const sheet = document.workbook!.sheets[inputRange.sheetIndex];
    if (!sheet || sheet.name !== inputRange.sheet) return null;
    let decoded: ReturnType<typeof spreadsheetUtils.decode_range>;
    try {
      decoded = spreadsheetUtils.decode_range(inputRange.range);
    } catch {
      return null;
    }
    const matching = sheet.cells.filter((cell) =>
      cell.row >= decoded.s.r && cell.row <= decoded.e.r &&
      cell.column >= decoded.s.c && cell.column <= decoded.e.c);
    const selected = matching.slice(0, Math.max(0, remaining));
    remaining -= selected.length;
    return {
      cells: selected.map((cell) => ({
        address: cell.address,
        column: cell.column,
        display: cell.display,
        formula: cell.formula,
        row: cell.row,
        type: cell.type,
        value: cell.value
      })),
      range: inputRange.range,
      role: inputRange.role,
      sheet: inputRange.sheet,
      sheetIndex: inputRange.sheetIndex,
      truncated: selected.length < matching.length
    };
  });
  if (ranges.some((range) => range === null)) return null;
  return {
    operationSummary: analysis.receipt.operationSummary,
    ranges: ranges as NonNullable<typeof ranges[number]>[],
    result: {
      columns: [...analysis.columns],
      rows: analysis.rows.map((row) => [...row])
    },
    warnings: [...analysis.receipt.warnings]
  };
}

async function sourceVersionForEvidence(
  client: CitationViewerClient,
  item: EvidenceItem
): Promise<ViewerSourceVersion | null> {
  if (!item.sourceId || !item.sourceVersionId || !item.knowledgeBaseId) return null;
  return client.knowledgeSourceVersion.findFirst({
    select: {
      artifacts: {
        select: {
          hierarchicalIndexes: {
            orderBy: { schemaVersion: "desc" },
            select: {
              passageIndexes: {
                select: {
                  headingPath: true,
                  page: true,
                  pageEnd: true,
                  sourceBlockEnd: true,
                  sourceBlockIds: true,
                  sourceBlockStart: true
                },
                take: 1,
                ...(item.passageId ? { where: { id: item.passageId } } : {})
              }
            },
            take: 1,
            where: { state: "ready" }
          },
          normalizedTextByteSize: true,
          normalizedTextChecksum: true,
          normalizedTextStorageKey: true,
          state: true
        },
        take: 1,
        where: item.sourceArtifactId ? { id: item.sourceArtifactId } : undefined
      },
      byteSize: true,
      checksum: true,
      fileName: true,
      id: true,
      mimeType: true,
      originalStorageKey: true,
      source: {
        select: {
          baseMemberships: {
            select: { removedAt: true },
            where: { knowledgeBaseId: item.knowledgeBaseId }
          },
          currentVersionId: true,
          deletionRequestedAt: true,
          name: true,
          ownerUserId: true,
          trashedAt: true
        }
      },
      versionNumber: true
    },
    where: { id: item.sourceVersionId, sourceId: item.sourceId }
  });
}

function sourceStatuses(input: Readonly<{
  base: CurrentBase;
  userId: string;
  version: ViewerSourceVersion;
}>): readonly KnowledgeViewerSourceStatus[] {
  const statuses: KnowledgeViewerSourceStatus[] = [];
  if (input.version.source.currentVersionId !== input.version.id) statuses.push("earlier_version");
  const membership = input.version.source.baseMemberships[0];
  if (!membership || membership.removedAt) statuses.push("removed");
  if ((input.base.trashedAt || input.version.source.trashedAt) &&
    input.version.source.ownerUserId === input.userId) statuses.push("trash");
  return statuses;
}

function sourceCurrentlyReadable(
  access: ChatAccess,
  userId: string,
  version: ViewerSourceVersion
): boolean {
  if (version.source.deletionRequestedAt) return false;
  if (version.source.trashedAt) {
    return access.kind === "personal" && version.source.ownerUserId === userId;
  }
  return true;
}

async function citationFromEvidence(
  client: CitationViewerClient,
  storage: StorageAdapter,
  input: Readonly<{
    access: ChatAccess;
    item: EvidenceItem;
    userId: string;
  }>
): Promise<ResolvedKnowledgeCitationViewer | null> {
  if (input.item.state === "deleted") {
    return {
      citation: { handle: input.item.handle, state: "deleted" },
      original: null
    };
  }
  if (
    input.item.state !== "available" || !input.item.knowledgeBaseId ||
    !input.item.sourceArtifactId || !input.item.passageId ||
    input.item.excerpt === null || !input.item.fileName || input.item.page === null
  ) return null;
  const base = await currentBaseForAccess(client, {
    access: input.access,
    knowledgeBaseId: input.item.knowledgeBaseId,
    userId: input.userId
  });
  if (!base) return null;
  const version = await sourceVersionForEvidence(client, input.item);
  if (!version || !sourceCurrentlyReadable(input.access, input.userId, version)) return null;
  const artifact = version.artifacts[0] ?? null;
  const passage = artifact?.hierarchicalIndexes[0]?.passageIndexes[0] ?? null;
  const document = await normalizedDocument(storage, artifact);
  const visual = visualAnalysis(input.item);
  const blocks = contextBlocks(document, visual
    ? { sourceBlockIds: [visual.blockId] }
    : passage);
  const workbook = workbookViewer(document, structuredAnalysis(input.item));
  const original = originalReference(version);
  return {
    citation: {
      ...availableViewer({
        baseName: input.item.baseName ?? base.name,
        blocks,
        excerpt: input.item.excerpt,
        excerptTruncated: input.item.textTruncated === true,
        fileName: version.fileName,
        headingPath: input.item.headingPath.length > 0
          ? input.item.headingPath
          : passage?.headingPath ?? [],
        mimeType: version.mimeType,
        name: input.item.sourceName ?? version.source.name,
        originalKind: original?.mimeType === "application/pdf"
          ? "pdf"
          : original ? "image" : null,
        ...(visual ? { locatorBoxes: visual.boundingBoxes } : {}),
        pageEnd: passage?.pageEnd ?? input.item.page,
        pageStart: passage?.page ?? input.item.page,
        statuses: sourceStatuses({ base, userId: input.userId, version }),
        versionNumber: input.item.sourceVersionNumber ?? version.versionNumber,
        visual: visualViewer(visual),
        workbook
      }),
      handle: input.item.handle
    },
    original
  };
}

function legacyMimeType(fileName: string): string {
  return fileName.toLocaleLowerCase("und").endsWith(".pdf")
    ? "application/pdf"
    : "application/octet-stream";
}

async function citationFromLegacyRun(
  client: CitationViewerClient,
  input: Readonly<{
    access: ChatAccess;
    decodedHandle: Readonly<{ handle: string; invocationOrdinal: number; resultOrdinal: number }>;
    runId: string;
    userId: string;
  }>
): Promise<ResolvedKnowledgeCitationViewer | null> {
  const knowledgeRun = await client.knowledgeRun.findFirst({
    select: { results: true },
    where: {
      invocationOrdinal: input.decodedHandle.invocationOrdinal,
      modelRunId: input.runId
    }
  });
  const results = Array.isArray(knowledgeRun?.results) ? knowledgeRun.results : [];
  const tombstone = results.find((candidate) =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).deleted === true &&
    (candidate as Record<string, unknown>).handle === input.decodedHandle.handle
  );
  if (tombstone) {
    return {
      citation: { handle: input.decodedHandle.handle, state: "deleted" },
      original: null
    };
  }
  const passage = results.map(decodeKnowledgeRetrievedPassage).find((candidate) =>
    candidate?.handle === input.decodedHandle.handle) ?? null;
  if (!passage) return null;
  const base = await currentBaseForAccess(client, {
    access: input.access,
    knowledgeBaseId: passage.knowledgeBaseId,
    userId: input.userId
  });
  if (!base) return null;
  const mimeType = legacyMimeType(passage.fileName);
  return {
    citation: {
      ...availableViewer({
        baseName: passage.baseName,
        blocks: [{
          boundingBoxes: [],
          headingPath: passage.headingPath ?? [],
          pageEnd: passage.page,
          pageStart: passage.page,
          relation: "target",
          table: null,
          text: passage.includedText,
          type: "paragraph"
        }],
        excerpt: passage.includedText,
        excerptTruncated: passage.textTruncated,
        fileName: passage.fileName,
        headingPath: passage.headingPath ?? [],
        mimeType,
        name: passage.sourceName ?? passage.fileName,
        originalKind: null,
        pageEnd: passage.page,
        pageStart: passage.page,
        statuses: base.trashedAt ? ["trash"] : [],
        versionNumber: passage.documentVersionNumber,
        visual: visualViewer(passage.visualAnalysis ?? null),
        workbook: null
      }),
      handle: input.decodedHandle.handle
    },
    original: null
  };
}

export async function resolveKnowledgeCitationViewer(
  client: CitationViewerClient,
  storage: StorageAdapter,
  input: Readonly<{
    assistantMessageId: string;
    handle: string;
    runId: string;
    userId: string;
  }>
): Promise<ResolvedKnowledgeCitationViewer | null> {
  const decodedHandle = decodeKnowledgeCitationHandle(input.handle);
  if (!input.assistantMessageId || !input.runId || !input.userId || !decodedHandle) return null;
  const run = await client.modelRun.findFirst({
    select: { chatId: true, id: true },
    where: { assistantMessageId: input.assistantMessageId, id: input.runId }
  });
  if (!run) return null;
  const access = await resolveChatAccess(client, {
    chatId: run.chatId,
    userId: input.userId
  });
  if (!access) return null;

  if ("evidenceOrdinal" in decodedHandle) {
    const item = await client.knowledgeEvidenceItem.findFirst({
      select: {
        baseName: true,
        contextBoundaries: true,
        excerpt: true,
        fileName: true,
        handle: true,
        headingPath: true,
        knowledgeBaseId: true,
        locator: true,
        page: true,
        passageId: true,
        sourceArtifactId: true,
        sourceId: true,
        sourceName: true,
        sourceVersionId: true,
        sourceVersionNumber: true,
        state: true,
        textTruncated: true
      },
      where: {
        handle: decodedHandle.handle,
        retrievalSession: { modelRunId: run.id }
      }
    });
    return item
      ? citationFromEvidence(client, storage, {
          access,
          item,
          userId: input.userId
        })
      : null;
  }

  return citationFromLegacyRun(client, {
    access,
    decodedHandle,
    runId: run.id,
    userId: input.userId
  });
}

export async function resolveKnowledgeSourceViewer(
  client: CitationViewerClient,
  storage: StorageAdapter,
  input: Readonly<{ sourceId: string; userId: string }>
): Promise<ResolvedKnowledgeSourceViewer | null> {
  if (!input.sourceId || !input.userId) return null;
  const source = await client.knowledgeSource.findFirst({
    select: {
      baseMemberships: {
        orderBy: { createdAt: "asc" },
        select: { knowledgeBaseId: true, removedAt: true }
      },
      currentVersion: {
        select: {
          artifacts: {
            orderBy: { updatedAt: "desc" },
            select: {
              normalizedTextByteSize: true,
              normalizedTextChecksum: true,
              normalizedTextStorageKey: true,
              state: true
            },
            take: 1,
            where: { state: "ready" }
          },
          byteSize: true,
          checksum: true,
          fileName: true,
          mimeType: true,
          originalStorageKey: true,
          versionNumber: true
        }
      },
      deletionRequestedAt: true,
      name: true,
      ownerUserId: true,
      trashedAt: true
    },
    where: { id: input.sourceId }
  });
  if (!source || source.deletionRequestedAt || !source.currentVersion) return null;
  const activeMemberships = source.baseMemberships.filter(({ removedAt }) => !removedAt);
  let base: CurrentBase | null = null;
  for (const membership of activeMemberships) {
    base = await currentBaseForSourceLibrary(client, {
      knowledgeBaseId: membership.knowledgeBaseId,
      userId: input.userId
    });
    if (base) break;
  }
  if (!base && source.ownerUserId !== input.userId) return null;
  if (source.trashedAt && source.ownerUserId !== input.userId) return null;
  const version = source.currentVersion;
  const artifact = version.artifacts[0] ?? null;
  const document = await normalizedDocument(storage, artifact);
  if (!document) return null;
  const blocks = contextBlocks(document, null);
  const target = blocks.find((block) => block.relation === "target") ?? null;
  if (!target) return null;
  const original = originalReference(version);
  return {
    original,
    source: availableViewer({
      baseName: base?.name ?? null,
      blocks,
      excerpt: target.text,
      excerptTruncated: false,
      fileName: version.fileName,
      headingPath: target.headingPath,
      mimeType: version.mimeType,
      name: source.name,
      originalKind: original?.mimeType === "application/pdf"
        ? "pdf"
        : original ? "image" : null,
      pageEnd: target.pageEnd,
      pageStart: target.pageStart,
      statuses: source.trashedAt ? ["trash"] : [],
      versionNumber: version.versionNumber,
      visual: null,
      workbook: null
    })
  };
}

export async function readKnowledgeViewerOriginal(
  storage: StorageAdapter,
  original: KnowledgeViewerOriginal,
  signal?: AbortSignal
): Promise<Buffer> {
  const maximum = getKnowledgeExtractionConfig().maxFileBytes;
  if (original.byteSize < 1 || original.byteSize > maximum) {
    throw new Error("knowledge_viewer_original_unavailable");
  }
  const stored = await storage.getObject(original.storageKey, {
    maxBytes: maximum,
    ...(signal ? { signal } : {})
  });
  if (stored.body.byteLength !== original.byteSize) {
    throw new Error("knowledge_viewer_original_size_mismatch");
  }
  if (createHash("sha256").update(stored.body).digest("hex") !== original.checksum) {
    throw new Error("knowledge_viewer_original_checksum_mismatch");
  }
  return stored.body;
}

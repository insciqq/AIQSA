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
  type KnowledgeNormalizedFieldGroup,
  type StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";
import { decodeKnowledgeRetrievedPassage } from "./toolResult";
import { decodeStructuredAnalysisResult, type StructuredAnalysisResult } from "./structuredData";
import {
  decodeKnowledgeDocumentContext,
  type KnowledgeDocumentContextV1
} from "./documentContext";
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
        contentHash: string;
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
    baseMemberships: readonly Readonly<{
      knowledgeBaseId: string;
      removedAt: Date | null;
    }>[];
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
  contentHash: string | null;
  contextBoundaries: Prisma.JsonValue | null;
  documentId: string | null;
  documentVersionId: string | null;
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

type EvidenceAuthority = Readonly<{
  base: CurrentBase | null;
  knowledgeBaseId: string | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptedBaseIds(value: Prisma.JsonValue | null): readonly string[] | null {
  if (!Array.isArray(value)) return value === null ? Object.freeze([]) : null;
  const result: string[] = [];
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).sort().join("\u0000") !==
      "indexGenerationId\u0000knowledgeBaseId" ||
      typeof entry.indexGenerationId !== "string" || !entry.indexGenerationId ||
      typeof entry.knowledgeBaseId !== "string" || !entry.knowledgeBaseId) return null;
    result.push(entry.knowledgeBaseId);
  }
  return new Set(result).size === result.length ? Object.freeze(result) : null;
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

function safeTable(
  block: KnowledgeNormalizedBlock,
  documentContext: KnowledgeDocumentContextV1 | null = null
): KnowledgeViewerBlock["table"] {
  if (!block.table) return null;
  const locator = documentContext?.locator;
  const tableLocator = locator?.kind === "table_row" || locator?.kind === "table_row_projection"
    ? locator
    : null;
  const rows = tableLocator
    ? new Set([tableLocator.rowIndex, ...tableLocator.headerLineage.map((header) => header.rowIndex)])
    : null;
  const sourceCells = rows
    ? block.table.cells.filter((cell) => {
        const rowMatch = [...rows].some((row) => row >= cell.row && row < cell.row + cell.rowSpan);
        return rowMatch;
      })
    : block.table.cells;
  const cells = sourceCells.slice(0, KNOWLEDGE_VIEWER_MAX_TABLE_CELLS);
  return {
    cells: cells.map((cell) => ({ ...cell })),
    columnCount: block.table.columnCount,
    rowCount: block.table.rowCount,
    truncated: Boolean(rows) || cells.length < sourceCells.length
  };
}

function tableText(table: NonNullable<KnowledgeViewerBlock["table"]>): string {
  const rows = [...new Set(table.cells.map((cell) => cell.row))].sort((left, right) => left - right);
  return rows.map((row) => table.cells.filter((cell) => cell.row === row)
    .sort((left, right) => left.column - right.column)
    .map((cell) => cell.text)
    .join("\t")).join("\n");
}

function fieldGroupViewerBlock(
  document: StoredKnowledgeNormalizedDocument,
  group: KnowledgeNormalizedFieldGroup,
  context: KnowledgeDocumentContextV1
): KnowledgeViewerBlock | null {
  const locator = context.locator;
  if ((locator.kind !== "field_pair" && locator.kind !== "field_ambiguous") ||
    locator.fieldGroupId !== group.id) return null;
  const selectedIds = locator.kind === "field_pair"
    ? [locator.labelCellId, locator.valueCellId]
    : [locator.cellId, ...locator.candidateCellIds];
  const selected = selectedIds.map((id) => group.cells.find((cell) => cell.id === id) ?? null);
  if (selected.some((cell) => cell === null)) return null;
  const cells = (selected as NonNullable<typeof selected[number]>[])
    .slice(0, KNOWLEDGE_VIEWER_MAX_TABLE_CELLS);
  const pair = locator.kind === "field_pair";
  const tableCells = cells.map((cell, index) => ({
    column: pair ? index : 0,
    columnSpan: 1,
    row: pair ? 0 : index,
    rowSpan: 1,
    text: cell.text
  }));
  const anchor = document.blocks
    .filter((block) => block.order < group.readingOrder)
    .at(-1) ?? null;
  return {
    boundingBoxes: cells.flatMap((cell) => cell.boundingBoxes)
      .slice(0, KNOWLEDGE_VIEWER_MAX_BOXES).map((box) => ({ ...box })),
    headingPath: anchor ? [...anchor.headingPath] : [],
    pageEnd: group.locator.pageEnd,
    pageStart: group.locator.pageStart,
    relation: "target",
    table: {
      cells: tableCells,
      columnCount: pair ? cells.length : 1,
      rowCount: pair ? 1 : cells.length,
      truncated: cells.length < selectedIds.length
    },
    text: pair ? cells.map((cell) => cell.text).join("\t") : cells.map((cell) => cell.text).join("\n"),
    type: "table"
  };
}

function viewerBlock(
  block: KnowledgeNormalizedBlock,
  relation: KnowledgeViewerBlock["relation"],
  documentContext: KnowledgeDocumentContextV1 | null = null
): KnowledgeViewerBlock {
  const table = safeTable(block, documentContext);
  return {
    boundingBoxes: block.boundingBoxes.slice(0, KNOWLEDGE_VIEWER_MAX_BOXES).map((box) => ({
      ...box
    })),
    headingPath: [...block.headingPath],
    pageEnd: block.locator.pageEnd,
    pageStart: block.locator.pageStart,
    relation,
    table,
    text: documentContext && table ? tableText(table) : block.text,
    type: block.type
  };
}

function contextBlocks(
  document: StoredKnowledgeNormalizedDocument | null,
  target: Readonly<{
    sourceBlockEnd?: number;
    sourceBlockIds?: readonly string[];
    sourceBlockStart?: number;
  }> | null,
  documentContext: KnowledgeDocumentContextV1 | null = null
): readonly KnowledgeViewerBlock[] {
  if (!document) return [];
  const targetIds = new Set(target?.sourceBlockIds ?? []);
  const locator = documentContext?.locator;
  if (locator?.kind === "field_pair" || locator?.kind === "field_ambiguous") {
    if (!targetIds.has(locator.fieldGroupId)) return [];
    const group = document.fieldGroups.find((candidate) => candidate.id === locator.fieldGroupId);
    const exact = group ? fieldGroupViewerBlock(document, group, documentContext!) : null;
    if (!group || !exact) return [];
    const before = document.blocks.filter((block) => block.order < group.readingOrder)
      .slice(-2).map((block) => viewerBlock(block, "before"));
    const remaining = Math.max(0, KNOWLEDGE_VIEWER_MAX_BLOCKS - before.length - 1);
    const after = document.blocks.filter((block) => block.order >= group.readingOrder)
      .slice(0, remaining).map((block) => viewerBlock(block, "after"));
    return [...before, exact, ...after];
  }
  if (document.blocks.length === 0) return [];
  const targetBlocks = document.blocks.filter((block) =>
    targetIds.size > 0
      ? targetIds.has(block.id)
      : target?.sourceBlockStart !== undefined && target.sourceBlockEnd !== undefined
        ? block.order >= target.sourceBlockStart && block.order <= target.sourceBlockEnd
        : block.order === 0
  ).slice(0, 8);
  if (target && targetBlocks.length === 0) return [];
  const selected = targetBlocks.length > 0 ? targetBlocks : document.blocks.slice(0, 1);
  const firstOrder = selected[0]?.order ?? 0;
  const lastOrder = selected.at(-1)?.order ?? firstOrder;
  const before = document.blocks
    .filter((block) => block.order < firstOrder)
    .slice(-2)
    .map((block) => viewerBlock(block, "before"));
  const exact = selected.map((block) => viewerBlock(
    block,
    "target",
    documentContext && "blockId" in documentContext.locator &&
      documentContext.locator.blockId === block.id
      ? documentContext
      : null
  ));
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

function documentContext(item: EvidenceItem): KnowledgeDocumentContextV1 | null | undefined {
  if (!record(item.contextBoundaries) || item.contextBoundaries.documentContext === undefined) {
    return null;
  }
  return decodeKnowledgeDocumentContext(item.contextBoundaries.documentContext) ?? undefined;
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
  input: Readonly<{
    item: EvidenceItem;
    knowledgeBaseId: string | null;
  }>
): Promise<ViewerSourceVersion | null> {
  const item = input.item;
  if (!item.sourceId || !item.sourceVersionId || !item.sourceArtifactId) return null;
  return client.knowledgeSourceVersion.findFirst({
    select: {
      artifacts: {
        select: {
          hierarchicalIndexes: {
            orderBy: { schemaVersion: "desc" },
            select: {
              passageIndexes: {
                select: {
                  contentHash: true,
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
            where: {
              state: "ready",
              ...(item.passageId
                ? { passageIndexes: { some: { id: item.passageId } } }
                : {})
            }
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
            select: { knowledgeBaseId: true, removedAt: true },
            where: input.knowledgeBaseId
              ? { knowledgeBaseId: input.knowledgeBaseId }
              : { knowledgeBaseId: { in: [] } }
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

async function currentAuthorityForEvidence(
  client: CitationViewerClient,
  input: Readonly<{
    access: ChatAccess;
    item: EvidenceItem;
    runId: string;
    userId: string;
  }>
): Promise<EvidenceAuthority | null> {
  if (!input.item.sourceId || !input.item.sourceVersionId || !input.item.sourceArtifactId) {
    return null;
  }
  const binding = await client.knowledgeRunSourceBinding.findFirst({
    select: {
      baseProvenance: true,
      profileBindingId: true,
      sourceVersionNumber: true,
      source: { select: { ownerUserId: true } }
    },
    where: {
      modelRunId: input.runId,
      readinessState: "ready",
      sourceArtifactId: input.item.sourceArtifactId,
      sourceId: input.item.sourceId,
      sourceVersionId: input.item.sourceVersionId,
      tombstonedAt: null
    }
  });
  if (!binding?.source || binding.profileBindingId !== input.item.knowledgeBaseId ||
    binding.sourceVersionNumber !== input.item.sourceVersionNumber) return null;
  const baseIds = acceptedBaseIds(binding.baseProvenance);
  if (baseIds === null) return null;
  for (const knowledgeBaseId of baseIds) {
    const base = await currentBaseForAccess(client, {
      access: input.access,
      knowledgeBaseId,
      userId: input.userId
    });
    if (base) return Object.freeze({ base, knowledgeBaseId });
  }
  if (baseIds.length > 0) return null;
  if (input.access.kind === "personal") {
    return binding.source.ownerUserId === input.userId
      ? Object.freeze({ base: null, knowledgeBaseId: null })
      : null;
  }
  const projectBinding = await client.projectKnowledgeSourceBinding.findUnique({
    select: { projectId: true },
    where: {
      projectId_sourceId: {
        projectId: input.access.project.projectId,
        sourceId: input.item.sourceId
      }
    }
  });
  return projectBinding
    ? Object.freeze({ base: null, knowledgeBaseId: null })
    : null;
}

function sourceStatuses(input: Readonly<{
  base: CurrentBase | null;
  knowledgeBaseId: string | null;
  userId: string;
  version: ViewerSourceVersion;
}>): readonly KnowledgeViewerSourceStatus[] {
  const statuses: KnowledgeViewerSourceStatus[] = [];
  if (input.version.source.currentVersionId !== input.version.id) statuses.push("earlier_version");
  const membership = input.knowledgeBaseId
    ? input.version.source.baseMemberships.find((entry) =>
        entry.knowledgeBaseId === input.knowledgeBaseId)
    : null;
  if (input.knowledgeBaseId && (!membership || membership.removedAt)) statuses.push("removed");
  if ((input.base?.trashedAt || input.version.source.trashedAt) &&
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
    runId: string;
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
    input.item.state !== "available" ||
    !input.item.knowledgeBaseId || !input.item.sourceArtifactId || !input.item.passageId ||
    input.item.excerpt === null || !input.item.fileName || input.item.page === null
  ) return null;
  const authority = await currentAuthorityForEvidence(client, {
    access: input.access,
    item: input.item,
    runId: input.runId,
    userId: input.userId
  });
  if (!authority) return null;
  const version = await sourceVersionForEvidence(client, {
    item: input.item,
    knowledgeBaseId: authority.knowledgeBaseId
  });
  if (!version || !sourceCurrentlyReadable(input.access, input.userId, version)) return null;
  const artifact = version.artifacts[0] ?? null;
  const passage = artifact?.hierarchicalIndexes[0]?.passageIndexes[0] ?? null;
  const visual = visualAnalysis(input.item);
  const context = documentContext(input.item);
  if (
    !artifact || artifact.state !== "ready" ||
    version.id !== input.item.sourceVersionId ||
    version.versionNumber !== input.item.sourceVersionNumber ||
    input.item.documentId !== input.item.sourceId ||
    input.item.documentVersionId !== input.item.sourceVersionId ||
    context === undefined ||
    (!visual && (!passage || input.item.contentHash === null ||
      passage.contentHash.trim() !== input.item.contentHash))
  ) return null;
  const document = await normalizedDocument(storage, artifact);
  const blocks = contextBlocks(document, visual
    ? { sourceBlockIds: [visual.blockId] }
    : passage, context);
  if (blocks.length === 0) return null;
  const workbook = workbookViewer(document, structuredAnalysis(input.item));
  const original = originalReference(version);
  return {
    citation: {
      ...availableViewer({
        baseName: input.item.baseName ?? authority.base?.name ?? null,
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
        statuses: sourceStatuses({
          base: authority.base,
          knowledgeBaseId: authority.knowledgeBaseId,
          userId: input.userId,
          version
        }),
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
        contentHash: true,
        contextBoundaries: true,
        documentId: true,
        documentVersionId: true,
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
          runId: run.id,
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

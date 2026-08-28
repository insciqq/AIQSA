import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentBlock
} from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";

const INLINE_REFERENCE_MARKER = /^(?:\p{N}{1,3}|[*†‡§¶])$/u;
const REFERENCE_ANCHOR_END = /[,.;:!?…\])»]$/u;

type PositionedBlock = Readonly<{
  block: ParsedDocumentBlock;
  box: ParsedBoundingBox;
  center: number;
  height: number;
  width: number;
}>;

export function isInlineReferenceMarkerText(value: string): boolean {
  return INLINE_REFERENCE_MARKER.test(value.trim());
}

function positioned(block: ParsedDocumentBlock): PositionedBlock | null {
  if (
    block.page !== block.pageEnd || block.boundingBoxes.length !== 1 ||
    block.assetIds.length > 0 || block.table !== null || block.isTable
  ) return null;
  const box = block.boundingBoxes[0]!;
  if (box.page !== block.page) return null;
  const height = Math.abs(box.bottom - box.top);
  const width = box.right - box.left;
  if (height <= 0 || width <= 0) return null;
  return Object.freeze({
    block,
    box,
    center: (box.bottom + box.top) / 2,
    height,
    width
  });
}

function visualCenter(item: PositionedBlock): number {
  return item.box.coordinateOrigin === "top_left" ? item.center : -item.center;
}

function verticalOverlap(left: PositionedBlock, right: PositionedBlock): number {
  const leftLow = Math.min(left.box.top, left.box.bottom);
  const leftHigh = Math.max(left.box.top, left.box.bottom);
  const rightLow = Math.min(right.box.top, right.box.bottom);
  const rightHigh = Math.max(right.box.top, right.box.bottom);
  return Math.max(0, Math.min(leftHigh, rightHigh) - Math.max(leftLow, rightLow));
}

function isReferenceAnchor(marker: PositionedBlock, candidate: PositionedBlock): boolean {
  if (
    candidate.block.index === marker.block.index ||
    candidate.block.page !== marker.block.page ||
    candidate.box.coordinateOrigin !== marker.box.coordinateOrigin ||
    candidate.block.text.trim().length < 4 ||
    !REFERENCE_ANCHOR_END.test(candidate.block.text.trim()) ||
    candidate.height < marker.height * 1.45 ||
    candidate.height > marker.height * 6 ||
    marker.width > candidate.height * 1.25
  ) return false;

  const horizontalGap = marker.box.left - candidate.box.right;
  if (horizontalGap < -marker.width * 0.5 || horizontalGap > candidate.height) return false;
  const raisedBy = visualCenter(candidate) - visualCenter(marker);
  return raisedBy >= candidate.height * 0.2 && raisedBy <= candidate.height * 1.25 &&
    verticalOverlap(marker, candidate) >= marker.height * 0.15;
}

function inferredInlineReference(
  block: ParsedDocumentBlock,
  positionedBlocks: readonly PositionedBlock[]
): boolean {
  if (block.type !== "paragraph" || !isInlineReferenceMarkerText(block.text)) return false;
  const marker = positioned(block);
  if (!marker) return false;
  return positionedBlocks.some((candidate) => isReferenceAnchor(marker, candidate));
}

/**
 * Conservatively separates parser-misclassified inline footnote references
 * from body evidence. A marker must be a tiny isolated glyph, geometrically
 * raised at the punctuated end of a larger text line. Values on the normal
 * baseline, boxed values such as `:2:`, and geometry-free text are unchanged.
 */
export function withLayoutAwareInlineReferences(document: ParsedDocument): ParsedDocument {
  const positionedBlocks = document.blocks.flatMap((block) => {
    const value = positioned(block);
    return value ? [value] : [];
  });
  const inferred = new Set(document.blocks.filter((block) =>
    inferredInlineReference(block, positionedBlocks)).map((block) => block.index));
  if (inferred.size === 0) return document;
  const blocks = document.blocks.map((block) => inferred.has(block.index)
    ? Object.freeze({ ...block, type: "footnote" as const })
    : block);
  return finalizeParsedDocument({
    assets: document.assets,
    attempts: document.attempts,
    blocks,
    engine: document.engine,
    fieldGroups: document.fieldGroups,
    languages: document.languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: document.status,
    warnings: document.warnings,
    workbook: document.workbook
  });
}

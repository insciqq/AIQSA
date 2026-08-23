import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentBlock
} from "./types";
import type { NativePdfGeometry } from "./nativePdf";

const MAX_GEOMETRY_BOXES_PER_BLOCK = 256;

function textKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function modelKeys(block: ParsedDocumentBlock): readonly string[] {
  const lines = block.text.split(/\r?\n/gu).map(textKey).filter(Boolean);
  const whole = textKey(block.text);
  return Object.freeze([...new Set([whole, ...lines].filter(Boolean))]);
}

function exactGeometryMatch(
  model: readonly string[],
  geometry: string
): boolean {
  if (geometry.length < 4) return false;
  return model.some((candidate) => candidate === geometry ||
    Math.min(candidate.length, geometry.length) >= 12 &&
      (candidate.includes(geometry) || geometry.includes(candidate)));
}

function boxKey(box: ParsedBoundingBox): string {
  return [
    box.page,
    box.coordinateOrigin,
    box.left,
    box.top,
    box.right,
    box.bottom
  ].join(":");
}

/** Adds only conservatively matched native PDF coordinates. Model-authored
 * text, structure, ordering, and quality remain authoritative and unchanged. */
export function enrichModelPdfGeometry(
  document: ParsedDocument,
  geometry: NativePdfGeometry
): ParsedDocument {
  if (geometry.pageCount !== document.pageCount || geometry.blocks.length < 1) return document;
  const consumed = new Set<number>();
  const blocks = document.blocks.map((block) => {
    if (block.boundingBoxes.length > 0) return block;
    const keys = modelKeys(block);
    const boxes: ParsedBoundingBox[] = [];
    for (const [index, candidate] of geometry.blocks.entries()) {
      if (consumed.has(index) || candidate.page < block.page || candidate.page > block.pageEnd ||
        !exactGeometryMatch(keys, textKey(candidate.text))) continue;
      consumed.add(index);
      boxes.push(...candidate.boundingBoxes);
    }
    const deduplicated = [...new Map(boxes.map((box) => [boxKey(box), box])).values()]
      .slice(0, MAX_GEOMETRY_BOXES_PER_BLOCK);
    return deduplicated.length < 1
      ? block
      : Object.freeze({ ...block, boundingBoxes: Object.freeze(deduplicated) });
  });
  if (blocks.every((block, index) => block === document.blocks[index])) return document;
  return Object.freeze({ ...document, blocks: Object.freeze(blocks) });
}

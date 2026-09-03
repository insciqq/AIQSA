export const KNOWLEDGE_FURNITURE_EDGE_FRACTION = 0.15;
export const KNOWLEDGE_FURNITURE_MIN_PAGE_FRACTION = 0.5;
export const KNOWLEDGE_FURNITURE_MAX_POSITION_DRIFT = 0.05;

type FurnitureBoundingBox = Readonly<{
  bottom: number;
  coordinateOrigin: "bottom_left" | "top_left";
  page: number;
  top: number;
}>;

export type KnowledgeFurnitureCandidate<Identifier> = Readonly<{
  boundingBoxes: readonly FurnitureBoundingBox[];
  id: Identifier;
  order: number;
  pageEnd: number;
  pageStart: number;
  table: unknown | null;
  text: string;
  type: string;
}>;

type PageVerticalExtent = Readonly<{
  maximum: number;
  minimum: number;
}>;

function verticalExtents<Identifier>(
  blocks: readonly KnowledgeFurnitureCandidate<Identifier>[]
): ReadonlyMap<string, PageVerticalExtent> {
  const mutable = new Map<string, { maximum: number; minimum: number }>();
  for (const block of blocks) {
    for (const box of block.boundingBoxes) {
      const key = `${box.page}:${box.coordinateOrigin}`;
      const low = Math.min(box.top, box.bottom);
      const high = Math.max(box.top, box.bottom);
      const current = mutable.get(key);
      if (current) {
        current.minimum = Math.min(current.minimum, low);
        current.maximum = Math.max(current.maximum, high);
      } else {
        mutable.set(key, { maximum: high, minimum: low });
      }
    }
  }
  return mutable;
}

function furniturePosition<Identifier>(
  block: KnowledgeFurnitureCandidate<Identifier>,
  extents: ReadonlyMap<string, PageVerticalExtent>
): Readonly<{ edge: "bottom" | "top"; position: number }> | null {
  if (block.pageStart !== block.pageEnd || block.boundingBoxes.length === 0) return null;
  const page = block.pageStart;
  if (block.boundingBoxes.some((box) => box.page !== page) ||
    new Set(block.boundingBoxes.map((box) => box.coordinateOrigin)).size !== 1) return null;
  const origin = block.boundingBoxes[0]!.coordinateOrigin;
  const extent = extents.get(`${page}:${origin}`);
  if (!extent || extent.maximum <= extent.minimum) return null;
  const low = Math.min(...block.boundingBoxes.map((box) => Math.min(box.top, box.bottom)));
  const high = Math.max(...block.boundingBoxes.map((box) => Math.max(box.top, box.bottom)));
  const rawPosition = ((low + high) / 2 - extent.minimum) /
    (extent.maximum - extent.minimum);
  const position = origin === "top_left" ? rawPosition : 1 - rawPosition;
  if (!Number.isFinite(position)) return null;
  if (position <= KNOWLEDGE_FURNITURE_EDGE_FRACTION) return { edge: "top", position };
  if (position >= 1 - KNOWLEDGE_FURNITURE_EDGE_FRACTION) {
    return { edge: "bottom", position };
  }
  return null;
}

function furnitureKey(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Returns only blocks whose repetition is proven by stable page-edge geometry.
 * Keeping one canonical occurrence mirrors current retrieval behavior.
 */
export function geometryProvenRepeatedFurniture<Identifier>(
  blocks: readonly KnowledgeFurnitureCandidate<Identifier>[],
  pageCount: number,
  preserveCanonical: boolean
): ReadonlySet<Identifier> {
  const extents = verticalExtents(blocks);
  const candidatesByKey = new Map<string, Array<Readonly<{
    block: KnowledgeFurnitureCandidate<Identifier>;
    edge: "bottom" | "top";
    position: number;
  }>>>();
  for (const block of blocks) {
    if (!block.text || block.text.length > 240 ||
      block.type === "title" || block.type === "heading" || block.type === "table" ||
      block.type === "image" || block.table !== null) continue;
    const position = furniturePosition(block, extents);
    if (!position) continue;
    const key = furnitureKey(block.text);
    if (!key) continue;
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push({ block, ...position });
    candidatesByKey.set(key, candidates);
  }

  const requiredPageCount = Math.max(
    3,
    Math.ceil(pageCount * KNOWLEDGE_FURNITURE_MIN_PAGE_FRACTION)
  );
  const excluded = new Set<Identifier>();
  for (const candidates of candidatesByKey.values()) {
    const pages = new Set(candidates.map(({ block }) => block.pageStart));
    const edges = new Set(candidates.map(({ edge }) => edge));
    const positions = candidates.map(({ position }) => position);
    if (pages.size < requiredPageCount || edges.size !== 1 ||
      Math.max(...positions) - Math.min(...positions) >
        KNOWLEDGE_FURNITURE_MAX_POSITION_DRIFT) continue;
    const duplicates = preserveCanonical
      ? [...candidates].sort((left, right) => left.block.order - right.block.order).slice(1)
      : candidates;
    for (const { block } of duplicates) excluded.add(block.id);
  }
  return excluded;
}

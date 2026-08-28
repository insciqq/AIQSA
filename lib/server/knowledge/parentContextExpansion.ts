import { KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS } from "./chunking";
import {
  conservativeQwen2TokenUpperBound,
  qwen2BpeTokenCounter
} from "./tokenizer/qwen2BpeTokenizer";
import type { KnowledgeDocumentContextV1 } from "./documentContext";
import type {
  KnowledgeParentExpansion,
  KnowledgeParentExpansionEvidence,
  KnowledgeParentExpansionUnit,
  KnowledgePassageLayoutKind
} from "./retrievalTypes";

/**
 * FR-14 child-to-parent context expansion.
 *
 * The retrieval unit stays the atomic passage. After hosted reranking and
 * final selection — and before provider delivery — every selected primary may
 * carry bounded same-Source context:
 *
 * - a body primary receives a centered canonical-section window loaded from
 *   the hierarchical passage index, rendered as at most one merged previous
 *   and one merged next same-Source block (the documented external neighbor
 *   contract is preserved: one previous and one next block per unstructured
 *   primary — each block simply carries the token-bounded section window
 *   instead of a single passage);
 * - a table primary keeps the pre-existing complete nearby-row and
 *   independently matched mechanics and may add at most one adjacent
 *   explanatory body passage per side from the same canonical section (table
 *   titles/captions are ordinary adjacent blocks, and the heading path is
 *   already rendered with every evidence block);
 * - a form primary keeps its field-group neighbors and may add at most one
 *   adjacent body passage per side; passages from a different form group are
 *   never mixed in.
 *
 * One evidence group (legacy segments plus new window units) never exceeds
 * `KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS` model tokens, counted with the
 * model-native tokenizer when available (a conservative UTF-8 byte upper
 * bound otherwise). The cap applies to the exact rendered expansion payload,
 * including its labels and separators. Overlapping windows from several
 * primaries are merged by a shared claim set: the same text never ships
 * twice, while every atomic evidence handle and each child hit's ranking
 * survive untouched.
 *
 * Failure discipline mirrors the hosted rerank stage: classified loading and
 * assembly failures degrade to the atomic evidence (plus the candidate-pool
 * fallback) with a content-free reason recorded in the receipt; unclassified
 * errors from outside this stage propagate. Citations always keep pointing at
 * the atomic passage and its canonical locator — expanded context is never
 * synthetic evidence, receives no locator, and never changes the Source
 * Version.
 */

/** Passage-ordinal radius loaded around one hit; the token cap is the real
 * bound, this only bounds the repository read. */
export const KNOWLEDGE_PARENT_CONTEXT_WINDOW_RADIUS = 8;
/** Existing table-neighbor policy shared by focused retrieval and the
 * full-context structural presentation. The radius counts logical table rows;
 * the maximum counts neighboring passages and excludes the atomic primary. */
export const KNOWLEDGE_TABLE_CONTEXT_ROW_RADIUS = 4;
export const KNOWLEDGE_TABLE_CONTEXT_MAX = 8;
/** Adjacent explanatory body passages allowed per side for table/form hits. */
export const KNOWLEDGE_PARENT_CONTEXT_STRUCTURED_ADJACENT_PER_SIDE = 1;

const PREVIOUS_SECTION_LABEL = "Previous same-Source context";
const NEXT_SECTION_LABEL = "Next same-Source context";

export type KnowledgeParentContextFailureCode =
  | "parent_context_assembly_failed"
  | "parent_context_load_failed"
  | "parent_context_rows_invalid"
  | "parent_context_window_unavailable";

/** Classified expansion-stage failure: degrades to atomic evidence. */
export class KnowledgeParentContextError extends Error {
  readonly code: KnowledgeParentContextFailureCode;

  constructor(code: KnowledgeParentContextFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
    this.name = "KnowledgeParentContextError";
  }
}

/**
 * Retrieval-time token counter following the Phase-4 formatter convention:
 * the model-native counter when its pinned asset verifies, otherwise the
 * conservative UTF-8 byte upper bound of byte-level BPE, which can only
 * tighten the expansion budget — retrieval never hard-fails on a
 * counting-side tokenizer problem (indexing keeps its own fail-closed path).
 */
export function knowledgeParentContextTokenCounter(): (text: string) => number {
  try {
    const counter = qwen2BpeTokenCounter();
    return (text) => counter.countTokens(text);
  } catch {
    return conservativeQwen2TokenUpperBound;
  }
}

/** One hierarchical-index row of a loaded canonical-section window. */
export type KnowledgeParentContextRow = Readonly<{
  contentHash: string;
  documentContext: KnowledgeDocumentContextV1 | null;
  id: string;
  layoutKind: KnowledgePassageLayoutKind;
  ordinal: number;
  sectionId: string;
  text: string;
}>;

export type KnowledgeParentSectionWindowRequest = Readonly<{
  chunkId: string;
  chunkIndex: number;
  documentVersionId: string;
  fromOrdinal: number;
  sectionId: string;
  sourceArtifactId: string;
  toOrdinal: number;
}>;

/**
 * Loads canonical-section windows for the selected primaries, keyed by the
 * anchor chunk id. A request whose window cannot be resolved is simply absent
 * from the result; classified failures throw `KnowledgeParentContextError`.
 */
export type KnowledgeParentContextLoader = (
  requests: readonly KnowledgeParentSectionWindowRequest[]
) => Promise<ReadonlyMap<string, readonly KnowledgeParentContextRow[]>>;

/** One selected primary, in final rank order, with its candidate-pool units. */
export type KnowledgeParentExpansionPrimary = Readonly<{
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  documentContext?: KnowledgeDocumentContextV1 | null;
  documentId: string;
  documentVersionId: string;
  layoutKind: KnowledgePassageLayoutKind;
  /** Pre-existing candidate-pool neighbor/secondary segments as units, in
   * relevance order; empty when the section window subsumes them. */
  legacyUnits: readonly KnowledgeParentExpansionUnit[];
  sectionId: string | null;
  sourceArtifactId: string | null;
}>;

function sortedWindowRows(
  rows: readonly KnowledgeParentContextRow[]
): readonly KnowledgeParentContextRow[] {
  return [...rows].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id));
}

/**
 * A window is usable when every row belongs to the primary's canonical
 * section and the anchor row is present with the exact chunk identity — a
 * concurrently activated index generation cannot silently substitute text.
 */
export function usableKnowledgeParentContextWindow(
  rows: readonly KnowledgeParentContextRow[] | undefined,
  primary: Readonly<{ chunkId: string; chunkIndex: number; sectionId: string | null }>
): readonly KnowledgeParentContextRow[] | null {
  if (!rows || rows.length < 1 || primary.sectionId === null) return null;
  if (rows.some((row) => row.sectionId !== primary.sectionId)) return null;
  const ordered = sortedWindowRows(rows);
  const anchor = ordered.find((row) => row.ordinal === primary.chunkIndex);
  if (!anchor || anchor.id !== primary.chunkId) return null;
  return ordered;
}

type StructureKey = Readonly<{ blockId?: string; fieldGroupId?: string }>;

function primaryStructure(primary: KnowledgeParentExpansionPrimary): StructureKey | null {
  const locator = primary.documentContext?.locator;
  if (!locator) return null;
  if (locator.kind === "table_row" || locator.kind === "table_row_projection") {
    return { blockId: locator.blockId };
  }
  if (locator.kind === "field_pair" || locator.kind === "field_ambiguous") {
    return { fieldGroupId: locator.fieldGroupId };
  }
  return null;
}

function sameStructureRow(
  primary: KnowledgeParentExpansionPrimary,
  structure: StructureKey | null,
  row: KnowledgeParentContextRow
): boolean {
  const locator = row.documentContext?.locator;
  if (structure?.blockId !== undefined) {
    return (locator?.kind === "table_row" || locator?.kind === "table_row_projection") &&
      locator.blockId === structure.blockId;
  }
  if (structure?.fieldGroupId !== undefined) {
    return (locator?.kind === "field_pair" || locator?.kind === "field_ambiguous") &&
      locator.fieldGroupId === structure.fieldGroupId;
  }
  return primary.layoutKind === "table_ambiguous" && row.layoutKind === "table_ambiguous";
}

type SideState = Readonly<{
  index: number;
  open: boolean;
  taken: number;
}>;

type PrimaryState = {
  anchorIndex: number;
  next: SideState;
  previous: SideState;
  primary: KnowledgeParentExpansionPrimary;
  structure: StructureKey | null;
  structured: boolean;
  units: KnowledgeParentExpansionUnit[];
  window: readonly KnowledgeParentContextRow[];
};

type Claims = Readonly<{
  chunkIds: Set<string>;
  contentHashes: Set<string>;
}>;

function claimed(claims: Claims, row: KnowledgeParentContextRow): boolean {
  return claims.chunkIds.has(row.id) || claims.contentHashes.has(row.contentHash);
}

/**
 * Advances one side's frontier to the next takeable row and returns it, or
 * closes the side. Structured primaries skip rows of their own structure
 * (those are the legacy mechanics' responsibility) and take only bounded
 * adjacent body context; body primaries extend contiguously through body rows
 * only, so canonical-section boundaries and structure boundaries both stop
 * the window.
 */
function peekSide(
  state: PrimaryState,
  claims: Claims,
  side: "next" | "previous"
): Readonly<{ index: number; row: KnowledgeParentContextRow }> | null {
  const direction = side === "previous" ? -1 : 1;
  const limit = state.structured
    ? KNOWLEDGE_PARENT_CONTEXT_STRUCTURED_ADJACENT_PER_SIDE
    : Number.POSITIVE_INFINITY;
  let sideState = state[side];
  if (!sideState.open || sideState.taken >= limit) return null;
  let index = sideState.index;
  let previousOrdinal = index === state.anchorIndex + direction
    ? state.window[state.anchorIndex]!.ordinal
    : state.window[index - direction]!.ordinal;
  while (index >= 0 && index < state.window.length) {
    const row = state.window[index]!;
    if (Math.abs(row.ordinal - previousOrdinal) !== 1) break;
    if (state.structured && sameStructureRow(state.primary, state.structure, row)) {
      previousOrdinal = row.ordinal;
      index += direction;
      continue;
    }
    if (row.layoutKind !== "body" || claimed(claims, row)) break;
    sideState = { ...sideState, index };
    state[side] = sideState;
    return { index, row };
  }
  state[side] = { ...sideState, open: false };
  return null;
}

function sectionExpansionUnit(
  state: PrimaryState,
  side: "next" | "previous",
  found: Readonly<{ index: number; row: KnowledgeParentContextRow }>,
  tokens: number
): KnowledgeParentExpansionUnit {
  return Object.freeze({
    chunkId: found.row.id,
    chunkIndex: found.row.ordinal,
    contentHash: found.row.contentHash,
    label: side === "previous" ? PREVIOUS_SECTION_LABEL : NEXT_SECTION_LABEL,
    origin: "section" as const,
    position: side,
    rank: state.units.length,
    text: found.row.text,
    tokens
  });
}

function takeSide(
  state: PrimaryState,
  claims: Claims,
  side: "next" | "previous",
  found: Readonly<{ index: number; row: KnowledgeParentContextRow }>,
  unit: KnowledgeParentExpansionUnit
): void {
  claims.chunkIds.add(found.row.id);
  claims.contentHashes.add(found.row.contentHash);
  state.units.push(unit);
  const direction = side === "previous" ? -1 : 1;
  state[side] = {
    index: found.index + direction,
    open: true,
    taken: state[side].taken + 1
  };
}

/** Keeps the relevance-ordered prefix of units that fits the token cap. */
function unitsWithinTokenCap(
  units: readonly KnowledgeParentExpansionUnit[],
  countTokens: (text: string) => number,
  cap: number
): readonly KnowledgeParentExpansionUnit[] {
  const kept: KnowledgeParentExpansionUnit[] = [];
  for (const unit of units) {
    if (countTokens(renderKnowledgeParentExpansionUnits([...kept, unit])) > cap) break;
    kept.push(unit);
  }
  return kept;
}

function interleaveBySource(states: readonly PrimaryState[]): readonly PrimaryState[] {
  const bySource = new Map<string, PrimaryState[]>();
  for (const state of states) {
    const key = [
      state.primary.documentId,
      state.primary.documentVersionId,
      state.primary.sourceArtifactId ?? ""
    ].join("\u001f");
    const group = bySource.get(key) ?? [];
    group.push(state);
    bySource.set(key, group);
  }
  const groups = [...bySource.values()];
  const queue: PrimaryState[] = [];
  for (let position = 0; ; position += 1) {
    let any = false;
    for (const group of groups) {
      const state = group[position];
      if (state) {
        queue.push(state);
        any = true;
      }
    }
    if (!any) break;
  }
  return queue;
}

/**
 * Assembles the FR-14 expansion for every selected primary. `primaries` must
 * be in final rank order. Section-window units are allocated with per-source
 * round-robin fairness: each primary receives one expansion slot before any
 * primary receives a second. The shared claim set merges overlapping windows
 * so no passage text ships twice across primaries or mechanisms.
 */
export function assembleKnowledgeParentExpansions(input: Readonly<{
  countTokens: (text: string) => number;
  excludedContentHashes: ReadonlySet<string>;
  loadFailureCode?: KnowledgeParentContextFailureCode;
  maxTokensPerGroup?: number;
  primaries: readonly KnowledgeParentExpansionPrimary[];
  windows: ReadonlyMap<string, readonly KnowledgeParentContextRow[]>;
}>): ReadonlyMap<string, KnowledgeParentExpansion> {
  const cap = input.maxTokensPerGroup ?? KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS;
  const claims: Claims = {
    chunkIds: new Set(input.primaries.map((primary) => primary.chunkId)),
    contentHashes: new Set([
      ...input.excludedContentHashes,
      ...input.primaries.map((primary) => primary.contentHash)
    ])
  };
  const results = new Map<string, {
    reason?: KnowledgeParentContextFailureCode;
    state: KnowledgeParentExpansion["state"];
    units: readonly KnowledgeParentExpansionUnit[];
  }>();
  const states: PrimaryState[] = [];
  for (const primary of input.primaries) {
    const legacy = unitsWithinTokenCap(primary.legacyUnits, input.countTokens, cap);
    for (const unit of legacy) {
      claims.chunkIds.add(unit.chunkId);
      claims.contentHashes.add(unit.contentHash);
    }
    if (primary.sectionId === null) {
      results.set(primary.chunkId, { state: "legacy", units: legacy });
      continue;
    }
    if (input.loadFailureCode) {
      results.set(primary.chunkId, {
        reason: input.loadFailureCode,
        state: "degraded",
        units: legacy
      });
      continue;
    }
    const window = usableKnowledgeParentContextWindow(windowRows(input.windows, primary), primary);
    if (!window) {
      results.set(primary.chunkId, {
        reason: "parent_context_window_unavailable",
        state: "degraded",
        units: legacy
      });
      continue;
    }
    const anchorIndex = window.findIndex((row) => row.id === primary.chunkId);
    states.push({
      anchorIndex,
      next: { index: anchorIndex + 1, open: true, taken: 0 },
      previous: { index: anchorIndex - 1, open: true, taken: 0 },
      primary,
      structure: primaryStructure(primary),
      structured: primary.layoutKind !== "body",
      units: [...legacy],
      window
    });
    results.set(primary.chunkId, { state: "expanded", units: legacy });
  }
  let active = interleaveBySource(states);
  while (active.length > 0) {
    const still: PrimaryState[] = [];
    for (const state of active) {
      const previous = peekSide(state, claims, "previous");
      const next = peekSide(state, claims, "next");
      const anchorOrdinal = state.window[state.anchorIndex]!.ordinal;
      const ordered = [
        ...(previous === null ? [] : [{ found: previous, side: "previous" as const }]),
        ...(next === null ? [] : [{ found: next, side: "next" as const }])
      ].sort((left, right) =>
        Math.abs(left.found.row.ordinal - anchorOrdinal) -
          Math.abs(right.found.row.ordinal - anchorOrdinal) ||
        (left.side === "previous" ? 0 : 1) - (right.side === "previous" ? 0 : 1));
      let took = false;
      for (const entry of ordered) {
        const tokens = input.countTokens(entry.found.row.text);
        const unit = sectionExpansionUnit(state, entry.side, entry.found, tokens);
        const renderedTokenTotal = input.countTokens(
          renderKnowledgeParentExpansionUnits([...state.units, unit])
        );
        if (renderedTokenTotal > cap) continue;
        takeSide(state, claims, entry.side, entry.found, unit);
        took = true;
        break;
      }
      if (!took) continue;
      if (state.previous.open || state.next.open) still.push(state);
    }
    active = still;
  }
  for (const state of states) {
    results.set(state.primary.chunkId, {
      state: "expanded",
      units: Object.freeze([...state.units])
    });
  }
  return new Map([...results].map(([chunkId, value]) => [chunkId, Object.freeze({
    ...(value.reason ? { reason: value.reason } : {}),
    state: value.state,
    units: Object.freeze([...value.units])
  })]));
}

function windowRows(
  windows: ReadonlyMap<string, readonly KnowledgeParentContextRow[]>,
  primary: KnowledgeParentExpansionPrimary
): readonly KnowledgeParentContextRow[] | undefined {
  return windows.get(primary.chunkId);
}

/**
 * Renders one primary's expansion units into the provider-visible
 * `expandedContext` payload. Contiguous section-window units merge into at
 * most one previous and one next same-Source block; table, independent, and
 * field-group units keep their individual legacy labels and document order.
 * The rendered text is clearly separated from the primary excerpt by the
 * existing "Related same-Source context" wrapper in the evidence block.
 */
export function renderKnowledgeParentExpansionUnits(
  units: readonly KnowledgeParentExpansionUnit[]
): string {
  const ordered = [...units].sort((left, right) =>
    left.chunkIndex - right.chunkIndex || left.chunkId.localeCompare(right.chunkId));
  const previousSection = ordered.filter((unit) =>
    unit.origin === "section" && unit.position === "previous");
  const nextSection = ordered.filter((unit) =>
    unit.origin === "section" && unit.position === "next");
  const other = ordered.filter((unit) => unit.origin !== "section");
  const segments = [
    ...(previousSection.length > 0 ? [
      `${PREVIOUS_SECTION_LABEL}:\n${previousSection.map((unit) => unit.text).join("\n")}`
    ] : []),
    ...other.map((unit) => `${unit.label}:\n${unit.text}`),
    ...(nextSection.length > 0 ? [
      `${NEXT_SECTION_LABEL}:\n${nextSection.map((unit) => unit.text).join("\n")}`
    ] : [])
  ];
  return segments.join("\n\n");
}

/** Content-free receipt summary for one primary's shipped expansion. */
export function knowledgeParentExpansionEvidence(
  expansion: KnowledgeParentExpansion,
  shippedUnits: readonly KnowledgeParentExpansionUnit[]
): KnowledgeParentExpansionEvidence {
  const rendered = renderKnowledgeParentExpansionUnits(shippedUnits);
  return Object.freeze({
    passageCount: shippedUnits.length,
    ...(expansion.reason ? { reason: expansion.reason } : {}),
    state: expansion.state,
    tokens: rendered ? knowledgeParentContextTokenCounter()(rendered) : 0
  });
}

const EXPANSION_STATES = new Set<KnowledgeParentExpansion["state"]>([
  "degraded",
  "expanded",
  "legacy"
]);

/** Strict additive decoder for persisted content-free expansion facts. */
export function decodeKnowledgeParentExpansionEvidence(
  value: unknown
): KnowledgeParentExpansionEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const passageCount = record.passageCount;
  const tokens = record.tokens;
  if (
    !Number.isSafeInteger(passageCount) || Number(passageCount) < 0 ||
    Number(passageCount) > 10_000 ||
    !Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > 1_000_000 ||
    typeof record.state !== "string" ||
    !EXPANSION_STATES.has(record.state as KnowledgeParentExpansion["state"]) ||
    (record.reason !== undefined && (
      typeof record.reason !== "string" || record.reason.length < 1 ||
      record.reason.length > 128
    ))
  ) return null;
  return Object.freeze({
    passageCount: Number(passageCount),
    ...(record.reason !== undefined ? { reason: record.reason as string } : {}),
    state: record.state as KnowledgeParentExpansion["state"],
    tokens: Number(tokens)
  });
}

export type KnowledgeParentExpansionBudgetEntry = Readonly<{
  key: string;
  sourceKey: string;
  units: readonly KnowledgeParentExpansionUnit[];
}>;

/**
 * Fits assembled expansions into the remaining provider byte budget using the
 * FR-14 trim order: atomic hits were already packed by the caller and are
 * never touched here; expansions shrink unit-by-unit (least relevant units of
 * each group trim first) with per-source round-robin fairness — each primary
 * keeps one expansion slot before any primary keeps a second — and only then
 * do the least relevant expansions drop entirely (an entry that wins no slot
 * ships as atomic evidence alone).
 */
export function fitKnowledgeParentExpansionsToByteBudget(input: Readonly<{
  entries: readonly KnowledgeParentExpansionBudgetEntry[];
  maximumBytes: number;
}>): ReadonlyMap<string, Readonly<{
  text: string;
  units: readonly KnowledgeParentExpansionUnit[];
}>> {
  const kept = new Map<string, KnowledgeParentExpansionUnit[]>(
    input.entries.map((entry) => [entry.key, []])
  );
  const renderedBytes = (): number => {
    let total = 0;
    for (const units of kept.values()) {
      if (units.length === 0) continue;
      total += Buffer.byteLength(renderKnowledgeParentExpansionUnits(units), "utf8");
    }
    return total;
  };
  type EntryState = { entry: KnowledgeParentExpansionBudgetEntry; nextUnit: number; open: boolean };
  const bySource = new Map<string, EntryState[]>();
  for (const entry of input.entries) {
    const group = bySource.get(entry.sourceKey) ?? [];
    group.push({ entry, nextUnit: 0, open: entry.units.length > 0 });
    bySource.set(entry.sourceKey, group);
  }
  const groups = [...bySource.values()];
  const queue: EntryState[] = [];
  for (let position = 0; ; position += 1) {
    let any = false;
    for (const group of groups) {
      const state = group[position];
      if (state) {
        queue.push(state);
        any = true;
      }
    }
    if (!any) break;
  }
  let open = queue.filter((state) => state.open);
  while (open.length > 0) {
    for (const state of open) {
      const unit = state.entry.units[state.nextUnit];
      if (!unit) {
        state.open = false;
        continue;
      }
      const units = kept.get(state.entry.key)!;
      units.push(unit);
      if (renderedBytes() > input.maximumBytes) {
        units.pop();
        state.open = false;
        continue;
      }
      state.nextUnit += 1;
    }
    open = open.filter((state) => state.open);
  }
  return new Map([...kept].map(([key, units]) => [key, Object.freeze({
    text: units.length > 0 ? renderKnowledgeParentExpansionUnits(units) : "",
    units: Object.freeze([...units])
  })]));
}

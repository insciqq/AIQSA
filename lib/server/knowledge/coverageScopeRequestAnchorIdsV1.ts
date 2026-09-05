import { KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS } from "./coverageScopeV6";

export const KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_VERSION = 1 as const;
export const KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS = 64 as const;

export type KnowledgeCoverageRequestAnchorIndexV1 = Readonly<{
  items: readonly Readonly<{
    id: string;
    text: string;
  }>[];
  version: typeof KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_VERSION;
}>;

export const KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_coverage_request_anchor_ids_contract version="1">',
  "requestAnchorIndex is a bounded server-authored ledger of exact fragments from the normalized request. For every finding or addition, put exactly one supplied Q ID in requestAnchor; do not copy, retype, translate, normalize, extend, or paraphrase its text.",
  "Choose the most specific content-bearing Q ID whose displayed text corresponds to the answer task. For a task that answers the whole broad question, choose its earliest applicable content-bearing Q ID. Reusing one Q ID across multiple independently answer-bearing findings is allowed.",
  "The server resolves a known Q ID to its immutable exact request substring before the historical V6 anchor validator, ordering, and persistence. An unknown Q ID or an unrelated literal still fails closed. Resolution performs no semantic matching, Scope filtering, promotion, or benchmark-specific inference.",
  "This follows the same least-authority pattern as selecting supplied K evidence handles: the model chooses among server-owned identifiers and never authors control-plane identity text.",
  "</aiqsa_knowledge_coverage_request_anchor_ids_contract>"
].join("\n"));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

function boundedRequestFragments(request: string): readonly string[] {
  const tokens = [...request.matchAll(/\S+/gu)].map((match) =>
    match[0].replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "") || match[0]);
  if (tokens.length > 0 &&
    tokens.length <= KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS &&
    tokens.every((token) => [...token].length <=
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints)) {
    return uniqueNonEmpty(tokens);
  }

  const codePoints = [...request];
  const targetSize = Math.max(1, Math.ceil(
    codePoints.length / KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS
  ));
  const chunkSize = Math.min(
    targetSize,
    KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints
  );
  const fragments: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
    const fragment = codePoints.slice(offset, offset + chunkSize).join("").trim();
    if (fragment) fragments.push(fragment);
    if (fragments.length === KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS) break;
  }
  return uniqueNonEmpty(fragments);
}

export function knowledgeCoverageRequestAnchorIndexV1(
  request: string
): KnowledgeCoverageRequestAnchorIndexV1 {
  if (typeof request !== "string" || !request.trim() || request.trim() !== request) {
    throw new Error("knowledge_coverage_request_anchor_index_invalid");
  }
  const fragments = boundedRequestFragments(request);
  if (fragments.length < 1 ||
    fragments.length > KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS ||
    fragments.some((fragment) => !request.includes(fragment) ||
      [...fragment].length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints)) {
    throw new Error("knowledge_coverage_request_anchor_index_invalid");
  }
  return Object.freeze({
    items: Object.freeze(fragments.map((text, index) => Object.freeze({
      id: `Q${index + 1}`,
      text
    }))),
    version: KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_VERSION
  });
}

/** Resolves only server-issued Q IDs. Historical exact-substring output remains
 * valid and is left for the unchanged V6 validator; unknown IDs and paraphrases
 * remain unchanged and therefore fail closed there. */
export function resolveKnowledgeCoverageRequestAnchorIdsV1(
  value: unknown,
  request: string,
  suppliedIndex?: Readonly<{ items: readonly Readonly<{ id: string; text: string }>[] }>
): unknown {
  const index = suppliedIndex ?? knowledgeCoverageRequestAnchorIndexV1(request);
  const textById = new Map(index.items.map(({ id, text }) => [id, text] as const));
  const resolve = (candidate: unknown, key: string | null = null): unknown => {
    if (key === "requestAnchor" && typeof candidate === "string") {
      return textById.get(candidate) ?? candidate;
    }
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => resolve(item)));
    }
    if (!record(candidate)) return candidate;
    return Object.freeze(Object.fromEntries(Object.entries(candidate).map(([name, item]) =>
      [name, resolve(item, name)])));
  };
  return resolve(value);
}

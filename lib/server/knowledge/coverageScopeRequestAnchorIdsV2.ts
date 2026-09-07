import { KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS } from "./coverageScopeV6";
import { KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS } from "./coverageScopeRequestAnchorIdsV1";

/** Control-free exact spans. Anchors locate tasks; the unchanged complete
 * request remains the scope authority, including text outside this bounded index. */
export function knowledgeCoverageRequestAnchorIndexV2(request: string) {
  if (typeof request !== "string" || !request.trim() || request.trim() !== request) {
    throw new Error("knowledge_coverage_request_anchor_index_invalid");
  }
  const fragments: string[] = [];
  const maximum = KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints;
  for (const line of request.split(/\p{Cc}+/u)) {
    let remaining = [...line.trim()];
    while (remaining.length > 0) {
      let end = Math.min(maximum, remaining.length);
      if (end < remaining.length) {
        for (let index = end - 1; index > 0; index -= 1) {
          if (/\s/u.test(remaining[index]!)) { end = index; break; }
        }
      }
      const fragment = remaining.slice(0, end).join("").trim();
      if (fragment) fragments.push(fragment);
      remaining = [...remaining.slice(end).join("").trim()];
    }
  }
  const unique = [...new Set(fragments)];
  const limit = KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS;
  const selected = unique.length <= limit ? unique : Array.from({ length: limit }, (_, index) =>
    unique[Math.floor(index * (unique.length - 1) / (limit - 1))]!);
  if (selected.length === 0) throw new Error("knowledge_coverage_request_anchor_index_invalid");
  return Object.freeze({ items: Object.freeze(selected.map((text, index) =>
    Object.freeze({ id: `Q${index + 1}`, text }))), version: 2 as const });
}

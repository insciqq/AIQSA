const bracketCitationMarkerPattern =
  /(?:\[\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?\s*\]|【\s*K[1-9]\d{0,3}(?:\.[1-9]\d?)?\s*】)/giu;
const providerCitationWrapperPattern =
  /cite(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)+/giu;
const nonRepairableControlPattern =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const nestedMarkdownLinePattern =
  /[\r\n]\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s/u;
const leadingMarkdownLinePattern =
  /^(?:\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+)/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapWholePresentationMarker(value: string): string {
  const wrappers = ["**", "__", "~~", "`", "*", "_"] as const;
  let normalized = value;
  for (let pass = 0; pass < wrappers.length; pass += 1) {
    const marker = wrappers.find((candidate) =>
      normalized.startsWith(candidate) && normalized.endsWith(candidate) &&
      normalized.length > candidate.length * 2 &&
      normalized.slice(candidate.length, -candidate.length).trim().length > 0);
    if (!marker) break;
    normalized = normalized.slice(marker.length, -marker.length).trim();
  }
  return normalized;
}

/** Repairs only presentation artifacts whose removal cannot invent factual
 * content. Multi-item Markdown, HTML, links, opaque controls, overlong text,
 * private identities, and every semantic constraint remain authoritative in
 * the existing Draft validator. */
export function normalizeKnowledgeClaimSurfaceV1(value: unknown): unknown {
  if (typeof value !== "string" || nonRepairableControlPattern.test(value)) return value;
  const trimmed = value.trim();
  if (nestedMarkdownLinePattern.test(trimmed)) return value;
  let normalized = trimmed
    .replace(providerCitationWrapperPattern, "")
    .replace(bracketCitationMarkerPattern, "")
    .replace(/[\t\r\n]+/gu, " ")
    .replace(leadingMarkdownLinePattern, "")
    .trim();
  normalized = unwrapWholePresentationMarker(normalized)
    .replace(/ {2,}/gu, " ")
    .replace(/ +([,.;:!?])/gu, "$1")
    .trim();
  return normalized;
}

/** Canonicalizes only claim `text` fields while preserving the exact provider
 * object shape. Returning the original object when unchanged keeps accepted
 * historical payload hashes stable. */
export function normalizeKnowledgeClaimPayloadV1(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(value.claims)) return value;
  let changed = false;
  const claims = value.claims.map((claim) => {
    if (!record(claim) || !Object.hasOwn(claim, "text")) return claim;
    const text = normalizeKnowledgeClaimSurfaceV1(claim.text);
    if (text === claim.text) return claim;
    changed = true;
    return { ...claim, text };
  });
  return changed ? { ...value, claims } : value;
}

/** Canonicalizes grouped Supplement V2 claim strings without changing target
 * keys, array cardinality, order, or any other provider-owned field. */
export function normalizeKnowledgeTargetedSupplementPayloadV2(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (!record(value.targets)) return value;
  let changed = false;
  const targets = Object.fromEntries(Object.entries(value.targets).map(([id, claims]) => {
    if (!Array.isArray(claims)) return [id, claims];
    const normalizedClaims = claims.map((claim) => {
      const normalized = normalizeKnowledgeClaimSurfaceV1(claim);
      if (normalized !== claim) changed = true;
      return normalized;
    });
    return [id, normalizedClaims];
  }));
  return changed ? { ...value, targets } : value;
}

export type ProviderConnectionLabelSource = Readonly<{
  id: string;
  name: string;
}>;

const FNV_64_OFFSET = 14_695_981_039_346_656_037n;
const FNV_64_PRIME = 1_099_511_628_211n;
const MINIMUM_REFERENCE_LENGTH = 6;

function normalizedConnectionName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function stableTextOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function connectionReference(value: string): string {
  let hash = FNV_64_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }
  return hash.toString(36).toUpperCase().padStart(13, "0");
}

function distinctReferenceLength(references: readonly string[]): number | null {
  for (let length = MINIMUM_REFERENCE_LENGTH; length <= references[0]!.length; length += 1) {
    if (new Set(references.map((reference) => reference.slice(0, length))).size === references.length) {
      return length;
    }
  }
  return null;
}

const endpointHostFragmentPattern =
  /(?:[a-z][a-z0-9+.-]*:\/\/)?(?:(?:[\w-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s·•|]*)?/giu;

/**
 * Removes endpoint-host fragments (domains, host:port pairs, URLs) from an
 * operator-authored connection label before it reaches ordinary UI. Run
 * controls require display names or neutral copy there; endpoint hosts stay
 * on Admin and diagnostic surfaces only. Domain-shaped tokens are stripped
 * even when they were meant as branding, because ordinary UI cannot tell the
 * difference. Callers strip before collision resolution so the deterministic
 * "· ref" suffix still separates connections whose stripped names collide.
 */
export function stripEndpointHostFragments(
  label: string,
  fallback = "Custom connection"
): string {
  const cleaned = label
    .split(/[·•|]|\s+[–—-]\s+/u)
    .map((part) => part
      .replace(endpointHostFragmentPattern, " ")
      .replace(/\(\s*\)|\[\s*\]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim())
    .filter((part) => part.length > 0)
    .join(" · ");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Resolves privacy-safe presentation labels for an already filtered connection catalog.
 * Runtime binding continues to use the exact connection id; only colliding display names
 * receive an opaque, deterministic reference.
 */
export function resolveProviderConnectionLabels(
  sources: readonly ProviderConnectionLabelSource[]
): ReadonlyMap<string, string> {
  const uniqueSources = [...sources]
    .sort((left, right) => stableTextOrder(left.id, right.id) || stableTextOrder(left.name, right.name))
    .filter((source, index, sorted) => index === 0 || source.id !== sorted[index - 1]!.id);
  const collisionGroups = new Map<string, ProviderConnectionLabelSource[]>();

  for (const source of uniqueSources) {
    const normalizedName = normalizedConnectionName(source.name);
    collisionGroups.set(normalizedName, [...(collisionGroups.get(normalizedName) ?? []), source]);
  }

  const labels = new Map<string, string>();
  for (const group of collisionGroups.values()) {
    if (group.length === 1) {
      labels.set(group[0]!.id, group[0]!.name);
      continue;
    }

    const references = group.map((source) => connectionReference(source.id));
    const referenceLength = distinctReferenceLength(references);
    for (const [index, source] of group.entries()) {
      const reference = referenceLength === null
        ? `${references[index]!.slice(0, MINIMUM_REFERENCE_LENGTH)}-${index + 1}`
        : references[index]!.slice(0, referenceLength);
      labels.set(source.id, `${source.name} · ref ${reference}`);
    }
  }

  return labels;
}

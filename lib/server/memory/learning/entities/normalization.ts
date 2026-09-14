import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_DEFAULT_IDENTITY_PROFILE,
  assertMemoryIdentityWritable,
  normalizeMemoryIdentityComponent,
  type MemoryIdentityProfile
} from "../identity/normalization";

export const MEMORY_ENTITY_RESOLUTION_VERSION = "memory-entity-resolution-v3";

export const MEMORY_ENTITY_TYPES = Object.freeze([
  "PERSON",
  "PLACE",
  "ORGANIZATION",
  "PRODUCT",
  "PROJECT",
  "SERVICE",
  "DEVICE",
  "CONCEPT",
  "OTHER"
] as const);

export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

const surroundingPunctuation = /^[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+|[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+$/gu;

function boundedText(value: string, maxLength = 256): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized && normalized.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

export function normalizeMemoryEntityAlias(value: string): string | null {
  const bounded = boundedText(value);
  if (!bounded) return null;
  const stripped = bounded.replace(surroundingPunctuation, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
  return stripped && stripped.length <= 256 ? stripped : null;
}

function mappedType(value: string): MemoryEntityType | null {
  if ((MEMORY_ENTITY_TYPES as readonly string[]).includes(value)) {
    return value as MemoryEntityType;
  }
  if (value === "GOAL") return "CONCEPT";
  return null;
}

export function memoryEntityType(value: string): MemoryEntityType | null {
  return mappedType(value);
}

export function memoryEntityTypeFamily(value: string): string | null {
  const entityType = mappedType(value);
  if (!entityType) return null;
  return entityType === "PRODUCT" || entityType === "DEVICE"
    ? "product-device"
    : entityType.toLocaleLowerCase("und");
}

/** Creation identity is grounded only in an exact nominal source span. The
 * provider's canonical label and free-standing qualifier proposals are never
 * part of this key. */
export function memoryGroundedEntityCanonicalKey(input: Readonly<{
  entityType: string;
  mention: string | null;
  mentionKind: "NAMED" | "NOMINAL" | "PRONOMINAL" | "ELLIPSIS" | "UNKNOWN";
}>, profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE): string | null {
  assertMemoryIdentityWritable(profile);
  if ((input.mentionKind !== "NAMED" && input.mentionKind !== "NOMINAL") ||
    input.mention === null) return null;
  const family = memoryEntityTypeFamily(input.entityType);
  const mention = normalizeMemoryEntityAlias(input.mention);
  if (!family || !mention) return null;
  const component = normalizeMemoryIdentityComponent(`entity-v4-${family}-mention`, mention);
  return component ? `entity:v4:${family}:${component}` : null;
}

export function memoryEntityCanonicalKey(input: Readonly<{
  canonicalLabel: string;
  entityType: string;
  qualifiers?: Readonly<Record<string, string | null>>;
}>, profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE): string | null {
  assertMemoryIdentityWritable(profile);
  const entityType = mappedType(input.entityType);
  const label = boundedText(input.canonicalLabel);
  if (!entityType || !label) return null;
  const qualifiers = Object.entries(input.qualifiers ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => [
      key.toLocaleLowerCase("und"),
      normalizeMemoryIdentityComponent(
        `entity-${entityType}-${key}`,
        value,
        profile
      )
    ] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  const labelComponent = normalizeMemoryIdentityComponent(
    `entity-${entityType}-label`,
    label,
    profile
  );
  if (!labelComponent) return null;
  const version = "v4";
  const direct = [
    "entity",
    version,
    entityType.toLocaleLowerCase("und"),
    ...qualifiers.flatMap(([key, value]) => [key, value]),
    labelComponent
  ].join(":");
  return direct.length <= 256
    ? direct
    : `entity:${version}:${entityType.toLocaleLowerCase("und")}:h-${memorySha256({
        domain: "aiqsa.memory.entity-key-v4",
        entityType,
        label: label.toLocaleLowerCase("und"),
        qualifiers,
        version: 4
      }).slice(0, 48)}`;
}

export function memoryEntityAliases(input: Readonly<{
  aliases: readonly string[];
  canonicalLabel: string;
  mention: string | null;
  mentionKind?: "NAMED" | "NOMINAL" | "PRONOMINAL" | "ELLIPSIS" | "UNKNOWN";
}>): readonly Readonly<{ displayAlias: string; normalizedAlias: string }>[] {
  const unique = new Map<string, string>();
  const sourceSupported = input.mentionKind === undefined ||
    input.mentionKind === "NAMED" || input.mentionKind === "NOMINAL"
    ? [input.mention, ...input.aliases]
    : [];
  for (const displayAlias of sourceSupported) {
    if (displayAlias === null) continue;
    const normalizedAlias = normalizeMemoryEntityAlias(displayAlias);
    if (normalizedAlias && !unique.has(normalizedAlias)) {
      unique.set(normalizedAlias, displayAlias.normalize("NFKC").trim());
    }
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normalizedAlias, displayAlias]) => ({ displayAlias, normalizedAlias }));
}

export function memoryEntityAliasSupportFingerprint(input: Readonly<{
  aliasId: string;
  evidenceId?: string;
  factVersionId?: string;
  userId: string;
}>): string {
  return memorySha256({
    aliasId: input.aliasId,
    domain: "aiqsa.memory.entity-alias-support",
    evidenceId: input.evidenceId ?? null,
    factVersionId: input.factVersionId ?? null,
    userId: input.userId,
    version: 1
  });
}

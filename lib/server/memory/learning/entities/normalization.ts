import { memorySha256 } from "../../persistence/lexical";
import { normalizeMemoryIdentityComponent } from "../identity/normalization";

export const MEMORY_ENTITY_RESOLUTION_VERSION = "memory-entity-resolution-v2";

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
const pronounAlias = /^(?:it|its|itself|he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves|this|that|these|those|one|ones|он|она|оно|они|его|её|ее|их|ему|ей|им|него|неё|нее|них|этот|эта|это|эти|тот|та|то|те|данный|данная|данное|данные)$/iu;

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
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е");
  return stripped && stripped.length <= 256 && !pronounAlias.test(stripped)
    ? stripped
    : null;
}

export function memoryEntityAliasIsPronoun(value: string): boolean {
  const bounded = boundedText(value);
  if (!bounded) return false;
  const stripped = bounded.replace(surroundingPunctuation, "")
    .trim()
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е");
  return pronounAlias.test(stripped);
}

export function memoryTextContainsCoreference(value: string): boolean {
  const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.some((token) => memoryEntityAliasIsPronoun(token));
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

export function memoryEntityCanonicalKey(input: Readonly<{
  canonicalLabel: string;
  entityType: string;
  qualifiers?: Readonly<Record<string, string | null>>;
}>): string | null {
  const entityType = mappedType(input.entityType);
  const label = boundedText(input.canonicalLabel);
  if (!entityType || !label) return null;
  const qualifiers = Object.entries(input.qualifiers ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => [
      key.toLocaleLowerCase("und"),
      normalizeMemoryIdentityComponent(`entity-${entityType}-${key}`, value)
    ] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  const labelComponent = normalizeMemoryIdentityComponent(
    `entity-${entityType}-label`,
    label
  );
  if (!labelComponent) return null;
  const direct = [
    "entity",
    "v2",
    entityType.toLocaleLowerCase("und"),
    ...qualifiers.flatMap(([key, value]) => [key, value]),
    labelComponent
  ].join(":");
  return direct.length <= 256
    ? direct
    : `entity:v2:${entityType.toLocaleLowerCase("und")}:h-${memorySha256({
        domain: "aiqsa.memory.entity-key",
        entityType,
        label: label.toLocaleLowerCase("und"),
        qualifiers,
        version: 2
      }).slice(0, 48)}`;
}

export function memoryEntityAliases(input: Readonly<{
  aliases: readonly string[];
  canonicalLabel: string;
  mention: string;
}>): readonly Readonly<{ displayAlias: string; normalizedAlias: string }>[] {
  const unique = new Map<string, string>();
  for (const displayAlias of [input.mention, input.canonicalLabel, ...input.aliases]) {
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

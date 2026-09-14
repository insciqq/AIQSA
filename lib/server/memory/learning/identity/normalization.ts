import { memorySha256 } from "../../persistence/lexical";

export const MEMORY_IDENTITY_PROFILES = Object.freeze([
  "LEGACY_V1",
  "UNICODE_V2"
] as const);
export type MemoryIdentityProfile =
  (typeof MEMORY_IDENTITY_PROFILES)[number];

export const MEMORY_DEFAULT_IDENTITY_PROFILE: MemoryIdentityProfile =
  "UNICODE_V2";
export const MEMORY_SLOT_IDENTITY_VERSION = "slot-v4";
export const MEMORY_ENTITY_SLOT_IDENTITY_VERSION = "slot-v3";
export const MEMORY_PROPOSITION_IDENTITY_VERSION = "proposition-v2";

const asciiComponent = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function normalizeMemorySemanticText(
  value: string,
  maxLength = 512
): string | null {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized && normalized.length <= maxLength && !normalized.includes("\u0000")
    ? normalized
    : null;
}

function foldedIdentityText(text: string): string {
  return text.toLocaleLowerCase("und").normalize("NFKC");
}

/** Historical profiles identify accepted data; they cannot calculate new keys. */
export function assertMemoryIdentityWritable(profile: MemoryIdentityProfile): void {
  if (profile !== "UNICODE_V2") throw new Error("memory_identity_profile_retired");
}

/** Identity never consumes transliteration, lexical folding or n-grams.
 * UNICODE_V2 emits a readable token only when the complete folded value is an
 * ASCII-safe component. Every other value hashes the complete normalized
 * input under the versioned domain. */
export function normalizeMemoryIdentityComponent(
  namespace: string,
  value: string,
  profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE
): string | null {
  assertMemoryIdentityWritable(profile);
  const text = normalizeMemorySemanticText(value, 512);
  if (!text) return null;
  const folded = foldedIdentityText(text);
  const digest = memorySha256({
    domain: "aiqsa.memory.identity-component-v2",
    namespace,
    text: folded,
    version: 2
  });
  if (folded.length <= 94 && asciiComponent.test(folded)) {
    return `a-${folded}`;
  }
  return `h-${digest.slice(0, 48)}`;
}

export function normalizeMemoryProposition(
  statement: string,
  profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE
): string | null {
  assertMemoryIdentityWritable(profile);
  const text = normalizeMemorySemanticText(statement, 2_000);
  if (!text) return null;
  const folded = text
    .toLocaleLowerCase("und")
    .normalize("NFKC");
  return folded
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([,.;:!?]){2,}/gu, "$1");
}

export function memoryPropositionCanonicalKey(
  statement: string,
  profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE
): string | null {
  const proposition = normalizeMemoryProposition(statement, profile);
  return proposition
    ? `prop:v2:${memorySha256({
        domain: "aiqsa.memory.proposition-v2",
        proposition
      })}`
    : null;
}

/** MEDIUM observations live in a disjoint proposition namespace. Their own
 * lifecycle pointer makes them retrievable, while key separation prevents a
 * supporting observation from colliding with or mutating an authoritative
 * HIGH/explicit proposition or SLOT. */
export function memorySupportingPropositionCanonicalKey(input: Readonly<{
  expectedAt: string | null;
  occurredAt: string | null;
  statement: string;
  validFrom: string | null;
  validTo: string | null;
}>, profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE): string | null {
  const proposition = normalizeMemoryProposition(input.statement, profile);
  return proposition
    ? `prop:v2:${memorySha256({
        domain: "aiqsa.memory.supporting-proposition-v2",
        proposition,
        temporalIdentity: {
          expectedAt: input.expectedAt,
          occurredAt: input.occurredAt,
          validFrom: input.validFrom,
          validTo: input.validTo
        },
        version: 2
      })}`
    : null;
}

export function memorySlotCanonicalKey(input: Readonly<{
  dimensionKey: string | null;
  predicateKey: string;
  subjectKey: string;
}>, profile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE): string {
  assertMemoryIdentityWritable(profile);
  const slotVersion = "v4";
  const direct = `slot:${slotVersion}:${input.subjectKey}:${input.predicateKey}:${
    input.dimensionKey ?? "_"
  }`;
  if (direct.length <= 256) return direct;
  const subject = `h-${memorySha256({
    domain: "aiqsa.memory.slot-subject-v2",
    subjectKey: input.subjectKey,
    version: 2
  }).slice(0, 48)}`;
  const dimension = input.dimensionKey === null
    ? "_"
    : `h-${memorySha256({
        dimensionKey: input.dimensionKey,
        domain: "aiqsa.memory.slot-dimension-v2",
        version: 2
      }).slice(0, 48)}`;
  return `slot:${slotVersion}:${subject}:${input.predicateKey}:${dimension}`;
}

export function memoryEntitySlotCanonicalKey(entityId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(entityId)) {
    throw new Error("memory_entity_identity_invalid");
  }
  const key = `slot:v3:entity:${entityId}:product_status:_`;
  if (key.length > 256) throw new Error("memory_entity_identity_invalid");
  return key;
}

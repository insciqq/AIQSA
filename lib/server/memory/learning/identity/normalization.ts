import { memorySha256 } from "../../persistence/lexical";

export const MEMORY_SLOT_IDENTITY_VERSION = "slot-v2";
export const MEMORY_ENTITY_SLOT_IDENTITY_VERSION = "slot-v3";
export const MEMORY_PROPOSITION_IDENTITY_VERSION = "proposition-v1";

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

/** Components are never transliterated. ASCII labels receive a readable slug;
 * every other or overlong label receives a versioned 192-bit hash token. */
export function normalizeMemoryIdentityComponent(
  namespace: string,
  value: string
): string | null {
  const text = normalizeMemorySemanticText(value, 512);
  if (!text) return null;
  const folded = text
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  if (folded.length <= 96 && asciiComponent.test(folded)) return folded;
  return `h-${memorySha256({
    domain: "aiqsa.memory.identity-component",
    namespace,
    text: text.toLocaleLowerCase("und"),
    version: 1
  }).slice(0, 48)}`;
}

export function normalizeMemoryProposition(statement: string): string | null {
  const text = normalizeMemorySemanticText(statement, 2_000);
  if (!text) return null;
  return text
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([,.;:!?]){2,}/gu, "$1");
}

export function memoryPropositionCanonicalKey(statement: string): string | null {
  const proposition = normalizeMemoryProposition(statement);
  return proposition
    ? `prop:v1:${memorySha256({
        domain: "aiqsa.memory.proposition-v1",
        proposition
      })}`
    : null;
}

export function memorySlotCanonicalKey(input: Readonly<{
  dimensionKey: string | null;
  predicateKey: string;
  subjectKey: string;
}>): string {
  const direct = `slot:v2:${input.subjectKey}:${input.predicateKey}:${
    input.dimensionKey ?? "_"
  }`;
  if (direct.length <= 256) return direct;
  const subject = `h-${memorySha256({
    domain: "aiqsa.memory.slot-subject",
    subjectKey: input.subjectKey,
    version: 1
  }).slice(0, 48)}`;
  const dimension = input.dimensionKey === null
    ? "_"
    : `h-${memorySha256({
        dimensionKey: input.dimensionKey,
        domain: "aiqsa.memory.slot-dimension",
        version: 1
      }).slice(0, 48)}`;
  return `slot:v2:${subject}:${input.predicateKey}:${dimension}`;
}

export function memoryEntitySlotCanonicalKey(entityId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(entityId)) {
    throw new Error("memory_entity_identity_invalid");
  }
  const key = `slot:v3:entity:${entityId}:product_status:_`;
  if (key.length > 256) throw new Error("memory_entity_identity_invalid");
  return key;
}

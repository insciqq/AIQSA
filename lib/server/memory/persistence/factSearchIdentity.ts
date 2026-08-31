import type { Prisma } from "@prisma/client";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../explicit/safety";
import type { MemoryReusableFactSourceSnapshot } from
  "../synthesis/authoritySnapshots";
import { memorySha256, normalizeMemorySearchText } from "./lexical";

export type MemoryFactSearchIdentityInput = Readonly<{
  canonicalKey: string;
  category: string;
  displayText: string;
  factId: string;
  languageCode: string;
  sensitivityClass: string;
  sourceMode: string;
  structuredValue: Prisma.JsonValue | Prisma.InputJsonValue;
  versionId: string;
}>;

export type MemoryFactSearchIdentity = Readonly<{
  languageCode: string;
  normalizedSearchText: string;
  safeContentHash: string;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
}>;

/**
 * Builds the one canonical FACT_VERSION search identity shared by incremental
 * projection, embedding validation, compatible-generation promotion, and a
 * full rebuild. Logical authority is fenced by the caller; automatic facts
 * additionally fail closed when no exact reusable source snapshot survives.
 */
export function buildMemoryFactSearchIdentity(
  input: MemoryFactSearchIdentityInput,
  sources: readonly MemoryReusableFactSourceSnapshot[]
): MemoryFactSearchIdentity | null {
  const redaction = redactMemorySecrets(input.displayText);
  if (
    redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(input.displayText, redaction)
  ) {
    return null;
  }
  const safeDisplayText = redaction.redactedText;
  const normalizedSearchText = normalizeMemorySearchText(safeDisplayText);
  if (!normalizedSearchText) return null;
  if (input.sourceMode === "AUTOMATIC" && sources.length === 0) return null;
  return Object.freeze({
    languageCode: input.languageCode,
    normalizedSearchText,
    safeContentHash: memorySha256({
      displayText: safeDisplayText,
      structuredValue: input.structuredValue
    }),
    safetyIdentitySnapshot: memorySha256({
      sensitivityClass: input.sensitivityClass,
      sources
    }),
    sourceIdentitySnapshot: memorySha256({
      factId: input.factId,
      sourceMode: input.sourceMode,
      sources,
      versionId: input.versionId
    }),
    suppressionIdentitySnapshot: memorySha256({
      canonicalKey: input.canonicalKey,
      category: input.category,
      normalizedValue: normalizedSearchText
    })
  });
}

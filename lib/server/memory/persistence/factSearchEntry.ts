import { Prisma } from "@prisma/client";
import { enqueueMemoryEmbeddingBatchItem } from "../embedding/enqueue";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../explicit/safety";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { loadMemoryReusableFactSourceSnapshots } from
  "../synthesis/authoritySnapshots";
import { memorySha256, normalizeMemorySearchText } from "./lexical";
import { memoryCanonicalGlobalScopePredicate } from "./scopes";
import {
  requireActiveMemoryIndex,
  type LockedMemorySettings
} from "./transaction";

type IndexableClassifiedFact = Readonly<{
  canonicalKey: string;
  category: string;
  displayText: string;
  factId: string;
  languageCode: string;
  modality: string;
  sensitivityClass: string;
  sourceMode: string;
  structuredValue: Prisma.JsonValue;
  versionId: string;
}>;

/**
 * Materializes the retry-idempotent lexical entry for one authoritative,
 * locally classified fact and schedules its optional vector independently.
 * Every semantic admission path calls this same post-commit projection seam;
 * safety classification is not an indexing owner.
 */
export async function ensureClassifiedSearchEntry(
  tx: Prisma.TransactionClient,
  settings: LockedMemorySettings,
  factVersionId: string,
  triggerIdentity: string,
  now: Date
): Promise<void> {
  const [row] = await tx.$queryRaw<IndexableClassifiedFact[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId", fact."canonicalKey", fact."category",
      version."id" AS "versionId", version."displayText",
      version."structuredValue", version."languageCode",
      version."modality"::text AS "modality",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    WHERE version."userId" = ${settings.userId}
      AND version."id" = ${factVersionId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND ${memoryReusableFactAuthorityPredicate(settings.userId, {
        includePatterns: true
      })}
  `);
  if (!row) return;
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const redaction = redactMemorySecrets(row.displayText);
  if (redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(row.displayText, redaction)) return;
  const safeDisplayText = redaction.redactedText;
  const normalizedSearchText = normalizeMemorySearchText(safeDisplayText);
  if (!normalizedSearchText) return;
  const snapshots = await loadMemoryReusableFactSourceSnapshots(
    tx,
    settings.userId,
    [row]
  );
  const sources = snapshots.get(factVersionId) ?? [];
  if (row.sourceMode === "AUTOMATIC" && sources.length === 0) return;
  let entry = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, id: true },
    where: {
      factVersionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  entry ??= await tx.memorySearchEntry.create({
    data: {
      embeddingState: index.indexMode === "HYBRID"
        ? "PENDING"
        : "NOT_APPLICABLE",
      factVersionId,
      indexGenerationId: index.id,
      itemType: "FACT_VERSION",
      languageCode: row.languageCode,
      normalizedSearchText,
      safeContentHash: memorySha256({
        displayText: safeDisplayText,
        structuredValue: row.structuredValue
      }),
      safetyIdentitySnapshot: memorySha256({
        sensitivityClass: row.sensitivityClass,
        sources
      }),
      sourceIdentitySnapshot: memorySha256({
        factId: row.factId,
        sourceMode: row.sourceMode,
        sources,
        versionId: row.versionId
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: row.canonicalKey,
        category: row.category,
        normalizedValue: normalizedSearchText
      }),
      userId: settings.userId
    },
    select: { embeddingState: true, id: true }
  });
  if (entry.embeddingState === "PENDING") {
    await enqueueMemoryEmbeddingBatchItem(tx, settings, {
      entryId: entry.id,
      triggerIdentity
    });
  }
}

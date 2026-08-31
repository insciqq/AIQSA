import { Prisma, type MemoryEmbeddingState } from "@prisma/client";
import { enqueueMemoryEmbeddingBatchItem } from "../embedding/enqueue";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { loadMemoryReusableFactSourceSnapshots } from
  "../synthesis/authoritySnapshots";
import { buildMemoryFactSearchIdentity } from "./factSearchIdentity";
import {
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryActiveIndex
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
  now: Date,
  activeIndex?: MemoryActiveIndex
): Promise<void> {
  const index = activeIndex ?? await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
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
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    WHERE version."userId" = ${settings.userId}
      AND version."id" = ${factVersionId}
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
      AND ${memoryReusableFactAuthorityPredicate(settings.userId, {
        includePatterns: true,
        lifecycle: "CURRENT_OR_HISTORICAL"
      })}
  `);
  if (!row) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
    return;
  }
  const snapshots = await loadMemoryReusableFactSourceSnapshots(
    tx,
    settings.userId,
    [row]
  );
  const sources = snapshots.get(factVersionId) ?? [];
  const identity = buildMemoryFactSearchIdentity(row, sources);
  if (!identity) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
    return;
  }
  let entry = await tx.memorySearchEntry.findFirst({
    select: {
      embeddingState: true,
      id: true,
      languageCode: true,
      normalizedSearchText: true,
      safeContentHash: true,
      safetyIdentitySnapshot: true,
      sourceIdentitySnapshot: true,
      suppressionIdentitySnapshot: true
    },
    where: {
      factVersionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  const embeddingInputChanged = entry !== null && (
    entry.normalizedSearchText !== identity.normalizedSearchText ||
    entry.safeContentHash !== identity.safeContentHash
  );
  const embeddingState: MemoryEmbeddingState = index.indexMode === "LEXICAL_ONLY"
    ? "NOT_APPLICABLE"
    : !entry || embeddingInputChanged || entry.embeddingState === "NOT_APPLICABLE"
      ? "PENDING"
      : entry.embeddingState;
  const identityChanged = entry !== null && (
    entry.languageCode !== identity.languageCode ||
    entry.normalizedSearchText !== identity.normalizedSearchText ||
    entry.safeContentHash !== identity.safeContentHash ||
    entry.safetyIdentitySnapshot !== identity.safetyIdentitySnapshot ||
    entry.sourceIdentitySnapshot !== identity.sourceIdentitySnapshot ||
    entry.suppressionIdentitySnapshot !== identity.suppressionIdentitySnapshot
  );
  if (!entry) {
    entry = await tx.memorySearchEntry.create({
      data: {
        ...identity,
        embeddingState,
        factVersionId,
        indexGenerationId: index.id,
        itemType: "FACT_VERSION",
        userId: settings.userId
      },
      select: {
        embeddingState: true,
        id: true,
        languageCode: true,
        normalizedSearchText: true,
        safeContentHash: true,
        safetyIdentitySnapshot: true,
        sourceIdentitySnapshot: true,
        suppressionIdentitySnapshot: true
      }
    });
  } else if (identityChanged || entry.embeddingState !== embeddingState) {
    entry = await tx.memorySearchEntry.update({
      data: { ...identity, embeddingState },
      select: {
        embeddingState: true,
        id: true,
        languageCode: true,
        normalizedSearchText: true,
        safeContentHash: true,
        safetyIdentitySnapshot: true,
        sourceIdentitySnapshot: true,
        suppressionIdentitySnapshot: true
      },
      where: { id: entry.id }
    });
  }
  if (entry.embeddingState === "PENDING" || entry.embeddingState === "FAILED") {
    await enqueueMemoryEmbeddingBatchItem(tx, settings, {
      entryId: entry.id,
      triggerIdentity
    });
  }
}

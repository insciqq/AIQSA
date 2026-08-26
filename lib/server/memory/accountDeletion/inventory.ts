import { Prisma, type PrismaClient } from "@prisma/client";

type MemoryInventoryClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  "$queryRaw"
>;

type MemoryOwnedCountRow = Readonly<{
  recordCount: string;
  userId: string;
}>;

function requestedOwners(userIds?: readonly string[]): Prisma.Sql {
  if (userIds === undefined) {
    return Prisma.sql`SELECT owner."id" AS "userId" FROM "User" AS owner`;
  }
  if (userIds.length === 0) {
    return Prisma.sql`SELECT owner."id" AS "userId" FROM "User" AS owner WHERE FALSE`;
  }
  return Prisma.sql`
    SELECT owner."id" AS "userId"
    FROM "User" AS owner
    WHERE owner."id" IN (${Prisma.join([...userIds])})
  `;
}

function safeCount(value: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("memory_account_inventory_invalid");
  }
  if (parsed < 0n) throw new Error("memory_account_inventory_invalid");
  return parsed > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(parsed);
}

/**
 * Counts meaningful Memory-owned records. The mandatory untouched settings
 * row is deliberately inert and does not turn every stale account into a
 * deletion blocker. `learnAutomatically` is not inspected directly because
 * an actual user mutation is already fenced by `settingsRevision`.
 */
export async function loadAccountMemoryOwnedCounts(
  client: MemoryInventoryClient,
  userIds?: readonly string[]
): Promise<ReadonlyMap<string, number>> {
  const rows = await client.$queryRaw<MemoryOwnedCountRow[]>(Prisma.sql`
    WITH requested AS (${requestedOwners(userIds)}), inventory AS (
      SELECT settings."userId", COUNT(*)::bigint AS records
      FROM "UserMemorySettings" AS settings
      INNER JOIN requested ON requested."userId" = settings."userId"
      WHERE
        settings."useMemoryFacts" IS DISTINCT FROM TRUE
        OR settings."referenceChatHistory" IS DISTINCT FROM TRUE
        OR settings."memoryGeneration" <> 0
        OR settings."memoryRevision" <> 0
        OR settings."activeIndexGenerationId" IS NOT NULL
        OR settings."embeddingProviderModelId" IS NOT NULL
        OR settings."sensitiveAutomaticPolicy" <> 'EXPLICIT_ONLY'::"MemorySensitiveAutomaticPolicy"
        OR settings."memoryConsentRevision" <> 0
        OR settings."settingsRevision" <> 0
        OR settings."acceptedUtilityEgressFingerprint" IS NOT NULL
        OR settings."acceptedUtilityPolicyVersion" IS NOT NULL
        OR settings."acceptedUtilityEgressAt" IS NOT NULL
        OR settings."decayEnabled" = TRUE
        OR settings."decayPolicyVersion" IS NOT NULL
        OR settings."synthesisEnabled" = TRUE
        OR settings."synthesisEnabledAt" IS NOT NULL
        OR settings."synthesisPolicyVersion" IS NOT NULL
        OR settings."lastSynthesisAt" IS NOT NULL
      GROUP BY settings."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryScope" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ChatMemoryCheckpoint" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ChatMemoryCheckpointMessage" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryRecallChunk" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryRecallChunkMessage" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ChatMemoryDigest" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ChatMemoryDigestChunk" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ChatMemoryDigestMessage" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryCandidate" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryCandidateMessage" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryCandidateDecision" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFact" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactVersion" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactVersionRelation" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactVersionSourceDependency" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryEntity" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryEntityAlias" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryEntityAliasSupport" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactVersionEntity" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactExtractionExecution" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFactExtractionCandidateReceipt" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemorySynthesisExecution" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryAuxiliarySemanticCall" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryEvidence" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryEvent" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryFeedback" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemorySuppression" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryPauseInterval" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemorySourceBarrier" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryMutationAuthorization" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryOperationReceipt" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryIndexGeneration" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemorySearchEntry" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryJob" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryDeletionOutbox" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryRetrievalAttempt" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryRetrievalAttemptItem" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryExecutionBinding" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ModelRunMemoryBinding" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "ModelRunMemoryItem" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryHistoryRun" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
      UNION ALL SELECT row."userId", COUNT(*)::bigint FROM "MemoryToolEgressReceipt" row INNER JOIN requested USING ("userId") GROUP BY row."userId"
    )
    SELECT inventory."userId", SUM(inventory.records)::text AS "recordCount"
    FROM inventory
    GROUP BY inventory."userId"
  `);
  return new Map(rows.map((row) => [row.userId, safeCount(row.recordCount)]));
}

export async function countAccountMemoryOwnedData(
  client: MemoryInventoryClient,
  userId: string
): Promise<number> {
  return (await loadAccountMemoryOwnedCounts(client, [userId])).get(userId) ?? 0;
}

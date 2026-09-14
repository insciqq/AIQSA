import { Prisma } from "@prisma/client";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTransaction } from "../../persistence/transaction";

export const MEMORY_IDENTITY_COMPATIBILITY_VERSION =
  "memory-identity-compatibility-v1";

export type MemoryIdentityCompatibilityNamespace =
  | "FACT"
  | "GROUNDED_ENTITY"
  | "LABEL_ENTITY";

export function memoryIdentityKeyHash(canonicalKey: string): string {
  return memorySha256(canonicalKey);
}

/** Resolve recorded bytes through the owner/container-bound ledger. Never
 * reconstruct a historical key from current text. Unmapped forgotten roots
 * remain candidates for suppression checks, but cannot authorize identity reuse. */
export async function memoryRecordedLegacyIdentityKeys(
  tx: MemoryTransaction,
  input: Readonly<{
    containerId: string;
    namespace: MemoryIdentityCompatibilityNamespace;
    unicodeCanonicalKey: string;
    userId: string;
  }>
): Promise<readonly Readonly<{ canonicalKey: string; unambiguous: boolean }>[]> {
  const roots = input.namespace === "FACT"
    ? Prisma.sql`
        SELECT "canonicalKey", "state" = 'FORGOTTEN' AS "forgotten"
        FROM "MemoryFact"
        WHERE "userId" = ${input.userId} AND "scopeId" = ${input.containerId}
          AND "identityVersion" IN ('proposition-v1', 'slot-v2')
          AND "category" <> 'patterns'
      `
    : Prisma.sql`
        SELECT "canonicalKey", FALSE AS "forgotten"
        FROM "MemoryEntity"
        WHERE "userId" = ${input.userId} AND ${input.containerId} = 'ENTITY'
          AND "canonicalKey" LIKE ${input.namespace === "GROUNDED_ENTITY"
            ? "entity:v3:%" : "entity:v2:%"}
      `;
  return tx.$queryRaw(Prisma.sql`
    WITH roots AS (${roots})
    SELECT roots."canonicalKey",
      COUNT(DISTINCT mapping."unicodeKeyHash") = 1 AND
        COALESCE(BOOL_OR(mapping."unicodeKeyHash" = ${memoryIdentityKeyHash(
          input.unicodeCanonicalKey
        )}), FALSE) AS "unambiguous"
    FROM roots
    LEFT JOIN "MemoryIdentityCompatibility" AS mapping
      ON mapping."userId" = ${input.userId}
      AND mapping."namespace" = ${input.namespace}
      AND mapping."containerId" = ${input.containerId}
      AND mapping."legacyKeyHash" = encode(digest(roots."canonicalKey", 'sha256'), 'hex')
    GROUP BY roots."canonicalKey", roots."forgotten"
    HAVING COALESCE(BOOL_OR(mapping."unicodeKeyHash" = ${memoryIdentityKeyHash(
      input.unicodeCanonicalKey
    )}), FALSE) OR (roots."forgotten" AND COUNT(mapping."id") = 0)
    ORDER BY roots."canonicalKey"
  `);
}

export async function registerMemoryIdentityCompatibility(
  tx: MemoryTransaction,
  input: Readonly<{
    containerId: string;
    legacyCanonicalKey: string;
    namespace: MemoryIdentityCompatibilityNamespace;
    now: Date;
    unicodeCanonicalKey: string;
    userId: string;
  }>
): Promise<void> {
  if (input.legacyCanonicalKey === input.unicodeCanonicalKey) return;
  const legacyKeyHash = memoryIdentityKeyHash(input.legacyCanonicalKey);
  const unicodeKeyHash = memoryIdentityKeyHash(input.unicodeCanonicalKey);
  const id = memorySha256({
    containerId: input.containerId,
    domain: "aiqsa.memory.identity-compatibility",
    legacyKeyHash,
    namespace: input.namespace,
    unicodeKeyHash,
    userId: input.userId,
    version: 1
  });
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "MemoryIdentityCompatibility" (
      "id", "userId", "namespace", "containerId", "legacyKeyHash",
      "unicodeKeyHash", "firstObservedAt", "lastObservedAt",
      "observationCount"
    ) VALUES (
      ${id}, ${input.userId}, ${input.namespace}, ${input.containerId},
      ${legacyKeyHash}, ${unicodeKeyHash}, ${input.now}, ${input.now}, 1
    )
    ON CONFLICT (
      "userId", "namespace", "containerId", "legacyKeyHash",
      "unicodeKeyHash"
    ) DO UPDATE SET
      "lastObservedAt" = EXCLUDED."lastObservedAt",
      "observationCount" = LEAST(
        "MemoryIdentityCompatibility"."observationCount" + 1,
        2147483647
      )
  `);
}

/** A legacy key is safe for compatibility lookup only while it maps to one
 * complete Unicode identity for the same owner and identity container. */
export async function memoryLegacyIdentityIsUnambiguous(
  tx: MemoryTransaction,
  input: Readonly<{
    containerId: string;
    legacyCanonicalKey: string;
    namespace: MemoryIdentityCompatibilityNamespace;
    unicodeCanonicalKey: string;
    userId: string;
  }>
): Promise<boolean> {
  if (input.legacyCanonicalKey === input.unicodeCanonicalKey) return true;
  const legacyKeyHash = memoryIdentityKeyHash(input.legacyCanonicalKey);
  const unicodeKeyHash = memoryIdentityKeyHash(input.unicodeCanonicalKey);
  const rows = await tx.$queryRaw<Array<{
    mappingCount: bigint;
    targetPresent: boolean;
  }>>(Prisma.sql`
    SELECT
      COUNT(DISTINCT compatibility."unicodeKeyHash") AS "mappingCount",
      COALESCE(BOOL_OR(
        compatibility."unicodeKeyHash" = ${unicodeKeyHash}
      ), FALSE) AS "targetPresent"
    FROM "MemoryIdentityCompatibility" AS compatibility
    WHERE compatibility."userId" = ${input.userId}
      AND compatibility."namespace" = ${input.namespace}
      AND compatibility."containerId" = ${input.containerId}
      AND compatibility."legacyKeyHash" = ${legacyKeyHash}
  `);
  return rows[0]?.mappingCount === 1n && rows[0].targetPresent;
}

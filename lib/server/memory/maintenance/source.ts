import { Prisma, type PrismaClient } from "@prisma/client";
import { loadPersonalMemoryEvidenceSnapshots } from "../persistence/eligibility";
import { memorySha256 } from "../persistence/lexical";
import { redactMemorySecrets } from "../explicit/safety";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";
import { loadMemoryMaintenanceContext } from "./context";
import { MEMORY_MAINTENANCE_BATCH_SIZE, MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_QUIET_MS,
  memoryMaintenancePlan, type MemoryMaintenanceEvidence, type MemoryMaintenancePlan, type MemoryMaintenanceSource,
  type MemoryUsefulness } from "./policy";

type QueryClient = Pick<PrismaClient, "$queryRaw">;

/** Protection is independent of model decisions and applies to the entire fact
 * lineage, including an explicit owner action on an automatic current row. */
export function memoryMaintenanceSourcePredicate(userId: string): Prisma.Sql {
  return Prisma.sql`
    ${memoryReusableFactAuthorityPredicate(userId, { includePatterns: false, lifecycle: "CURRENT" })}
    AND settings."learnAutomatically" = TRUE
    AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    AND fact."pinned" = FALSE AND fact."movedToFactId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "MemoryFactVersion" AS explicit_version
      WHERE explicit_version."userId" = fact."userId" AND explicit_version."factId" = fact."id"
        AND explicit_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode")
    AND NOT EXISTS (SELECT 1 FROM "MemoryEvent" AS owner_event
      WHERE owner_event."userId" = fact."userId" AND owner_event."factId" = fact."id"
        AND owner_event."actorType" = 'USER'::"MemoryActorType")
  `;
}

async function scanSources(
  client: QueryClient, userId: string, input: Readonly<{ versionIds?: readonly string[]; now: Date; unreviewed?: boolean; cursor?: string | null }>
): Promise<Readonly<{ plan: MemoryMaintenancePlan | null; cursor: string | null }>> {
  if (input.versionIds?.length === 0) return { plan: null, cursor: null };
  const rows = await client.$queryRaw<Array<{
    factId: string; versionId: string; statement: string; category: string; modality: string;
    confidence: number; usefulness: MemoryUsefulness | null; observedAt: Date; evidenceThrough: Date; supportCount: number;
  }>>(Prisma.sql`
    SELECT fact."id" AS "factId", version."id" AS "versionId", version."displayText" AS statement,
      version."category", version."modality"::text AS modality, version."confidence", version."usefulness",
      version."observedAt", latest."evidenceThrough", latest."supportCount"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."id" = version."factId" AND fact."userId" = version."userId"
    JOIN "MemoryScope" AS scope ON scope."id" = fact."scopeId" AND scope."userId" = fact."userId"
    JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
    JOIN "User" AS owner_user ON owner_user."id" = fact."userId" AND owner_user.status = 'active'::"UserStatus"
    CROSS JOIN LATERAL (SELECT MAX(evidence."createdAt") AS "evidenceThrough", COUNT(*)::integer AS "supportCount" FROM "MemoryEvidence" AS evidence
      WHERE evidence."userId" = version."userId" AND evidence."factVersionId" = version."id"
        AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance") AS latest
    WHERE ${memoryMaintenanceSourcePredicate(userId)}
      AND version."observedAt" IS NOT NULL
      AND latest."evidenceThrough" IS NOT NULL
      ${input.cursor ? Prisma.sql`AND version.id > ${input.cursor}` : Prisma.empty}
      ${input.versionIds ? Prisma.sql`AND version."id" IN (${Prisma.join([...input.versionIds])})` : Prisma.empty}
      ${input.unreviewed ? Prisma.sql`
        AND latest."evidenceThrough" <= ${new Date(input.now.getTime() - MEMORY_MAINTENANCE_QUIET_MS)}
        AND NOT EXISTS (SELECT 1 FROM "MemoryMaintenanceReview" AS reviewed
          WHERE reviewed."userId" = version."userId" AND reviewed."factVersionId" = version."id"
            AND reviewed."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
            AND reviewed."evidenceThrough" >= latest."evidenceThrough")
      ` : Prisma.empty}
    ORDER BY version."id" LIMIT ${MEMORY_MAINTENANCE_BATCH_SIZE}
  `);
  const cursor = rows.at(-1)?.versionId ?? null;
  if (rows.length === 0) return { plan: null, cursor };
  const verified = await loadPersonalMemoryEvidenceSnapshots(client, userId, rows.map(({ versionId }) => versionId), { exactVNext: true });
  if (verified.length === 0) return { plan: null, cursor };
  const evidence = await client.$queryRaw<Array<MemoryMaintenanceEvidence & { factVersionId: string }>>(Prisma.sql`
    SELECT "id", "factVersionId", "chatId", "messageId", "branchGeneration", "sourceMessageContentHash" AS "sourceTextHash",
      "sourceStartOffset" AS "startOffset", "sourceEndOffset" AS "endOffset", "safeExcerpt" AS quote, "observedAt", "createdAt"
    FROM "MemoryEvidence" WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(verified.map(({ id }) => id))})
    ORDER BY "factVersionId", "id"
  `);
  const sources: MemoryMaintenanceSource[] = [];
  let characters = 0;
  for (const row of rows) {
    const supports = evidence.filter(({ factVersionId }) => factVersionId === row.versionId);
    if (supports.length === 0 || supports.length > 8 || supports.length !== row.supportCount || row.statement.length > 2_000 ||
      supports.some((support) => !Number.isSafeInteger(support.startOffset) || !Number.isSafeInteger(support.endOffset) ||
        support.endOffset <= support.startOffset || !support.sourceTextHash || support.quote.length > 4_000)) continue;
    const statement = redactMemorySecrets(row.statement).redactedText;
    const safeEvidence = supports.map((support) => ({ ...support, quote: redactMemorySecrets(support.quote).redactedText }));
    const context = await loadMemoryMaintenanceContext(client, userId, row.versionId, supports.map(({ messageId }) => messageId));
    if (!context) continue;
    const size = statement.length + safeEvidence.reduce((sum, item) => sum + item.quote.length, 0) + context.reduce((sum, item) => sum + item.text.length, 0);
    if (characters + size > 40_000) continue;
    characters += size;
    const sourceSnapshotHash = memorySha256({ ...row, statement, evidence: safeEvidence, context });
    sources.push({ ...row, statement, evidence: safeEvidence, context, sourceSnapshotHash, ref: `S${sources.length + 1}` });
  }
  return { plan: sources.length ? memoryMaintenancePlan(sources) : null, cursor };
}

export async function loadMemoryMaintenanceSources(client: QueryClient, userId: string,
  input: Readonly<{ versionIds?: readonly string[]; now: Date; unreviewed?: boolean }>): Promise<MemoryMaintenancePlan | null> {
  return (await scanSources(client, userId, input)).plan;
}
export function scanMemoryMaintenanceSources(client: QueryClient, userId: string, now: Date, cursor: string | null) {
  return scanSources(client, userId, { now, cursor, unreviewed: true });
}

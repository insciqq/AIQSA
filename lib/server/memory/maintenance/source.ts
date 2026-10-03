import { Prisma, type PrismaClient } from "@prisma/client";
import { loadPersonalMemoryEvidenceSnapshots, memoryAutomaticExplicitRememberPredicate } from "../persistence/eligibility";
import { memorySha256 } from "../persistence/lexical";
import { redactMemorySecrets } from "../explicit/safety";
import { memoryReusableFactAuthorityPredicate } from "../persistence/reusableFactAuthority";
import { loadMemoryMaintenanceContext } from "./context";
import { MEMORY_MAINTENANCE_BATCH_SIZE, MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS, MEMORY_MAINTENANCE_FAILURE_CODES,
  MEMORY_MAINTENANCE_MAX_FAILED_ATTEMPTS, MEMORY_MAINTENANCE_MAX_INVALID_OUTPUT_ATTEMPTS, MEMORY_MAINTENANCE_POLICY_VERSION,
  MEMORY_MAINTENANCE_QUIET_MS, MEMORY_MAINTENANCE_TRANSIENT_RETRY_MS, memoryMaintenancePlan, memoryMaintenanceReasonDisposition,
  type MemoryMaintenanceEvidence, type MemoryMaintenancePlan, type MemoryMaintenanceReasonCode,
  type MemoryMaintenanceSource, type MemoryUsefulness } from "./policy";

type QueryClient = Pick<PrismaClient, "$queryRaw">;

const MAX_STATEMENT_CHARACTERS = 2_000;
const MAX_QUOTE_CHARACTERS = 4_000;
const MAX_REVIEWED_EVIDENCE = 8;
const MAX_BATCH_CHARACTERS = 40_000;

/** A source the planner records without a provider call. */
export type MemoryMaintenanceBlocker = Readonly<{
  factId: string;
  versionId: string;
  evidenceThrough: Date;
  disposition: "BLOCKED" | "UNREVIEWABLE";
  reasonCode: MemoryMaintenanceReasonCode;
  sourceSnapshotHash: string;
}>;
export type MemoryMaintenanceScan = Readonly<{
  plan: MemoryMaintenancePlan | null;
  blockers: readonly MemoryMaintenanceBlocker[];
  cursor: string | null;
}>;

/** Protection is independent of model decisions and applies to the entire fact
 * lineage, including an explicit owner action on an automatic current row and
 * an automatic version whose source turn asked Memory to remember it. */
export function memoryMaintenanceSourcePredicate(userId: string | Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    ${memoryReusableFactAuthorityPredicate(userId, { lifecycle: "CURRENT" })}
    AND settings."learnAutomatically" = TRUE
    AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
    AND fact."pinned" = FALSE AND fact."movedToFactId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "MemoryFactVersion" AS lineage
      WHERE lineage."userId" = fact."userId" AND lineage."factId" = fact."id"
        AND (lineage."sourceMode" <> 'AUTOMATIC'::"MemoryFactSourceMode"
          OR ${memoryAutomaticExplicitRememberPredicate(Prisma.sql`lineage`)}))
    AND NOT EXISTS (SELECT 1 FROM "MemoryEvent" AS owner_event
      WHERE owner_event."userId" = fact."userId" AND owner_event."factId" = fact."id"
        AND owner_event."actorType" = 'USER'::"MemoryActorType")
  `;
}

/** The single v3 coverage rule of the planner scan and the owner query.
 * Callers expose `version`, `fact` and `latest`, the newest SUPPORTS evidence
 * time of the version. A settled decision or a job in flight covers it; a
 * planner blocker covers for a week while the lineage is unchanged. Failed
 * attempts of its current evidence (a blocker found in apply only for a week)
 * admit new jobs by the outcome of their job: two ordinary failures or three
 * invalid answers cover it; a transient provider failure only delays the next
 * job, doubling; a source changed before dispatch and a failure recorded
 * before causes were stable (memory_job_failed) cost nothing. */
export function memoryMaintenanceUncoveredPredicate(latest: Prisma.Sql, now: Date): Prisma.Sql {
  const recheckAfter = new Date(now.getTime() - MEMORY_MAINTENANCE_BLOCKED_RECHECK_MS);
  const { dispatchStale, invalidOutput, legacy, transient } = MEMORY_MAINTENANCE_FAILURE_CODES;
  const outcome = Prisma.sql`COALESCE(attempt."errorCode", '')`;
  return Prisma.sql`
    NOT EXISTS (SELECT 1 FROM "MemoryMaintenanceReview" AS covered
      WHERE covered."userId" = version."userId" AND covered."factVersionId" = version."id"
        AND covered."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
        AND covered."evidenceThrough" >= ${latest}
        AND (covered."disposition" IN ('PENDING', 'KEEP', 'REMOVED', 'REJECTED')
          OR (covered."disposition" IN ('BLOCKED', 'UNREVIEWABLE') AND covered."memoryJobId" IS NULL
            AND covered."reviewedAt" >= ${recheckAfter}
            AND NOT EXISTS (SELECT 1 FROM "MemoryFactVersion" AS changed
              WHERE changed."userId" = fact."userId" AND changed."factId" = fact."id"
                AND changed."createdAt" > covered."createdAt"))))
    AND (SELECT COUNT(*) FILTER (WHERE ${outcome} NOT IN (${invalidOutput}, ${transient}, ${dispatchStale}, ${legacy}))
        < ${MEMORY_MAINTENANCE_MAX_FAILED_ATTEMPTS}
      AND COUNT(*) FILTER (WHERE ${outcome} = ${invalidOutput}) < ${MEMORY_MAINTENANCE_MAX_INVALID_OUTPUT_ATTEMPTS}
      AND COALESCE(MAX(attempt."completedAt") FILTER (WHERE ${outcome} = ${transient})
        + LEAST(POWER(2::double precision, (COUNT(*) FILTER (WHERE ${outcome} = ${transient}) - 1)::double precision)
          * ${MEMORY_MAINTENANCE_TRANSIENT_RETRY_MS.first}::double precision,
          ${MEMORY_MAINTENANCE_TRANSIENT_RETRY_MS.max}::double precision) * INTERVAL '1 millisecond'
        <= ${now}, TRUE)
      FROM "MemoryMaintenanceReview" AS failed
      LEFT JOIN "MemoryJob" AS attempt ON attempt."userId" = failed."userId" AND attempt."id" = failed."memoryJobId"
      WHERE failed."userId" = version."userId" AND failed."factVersionId" = version."id"
        AND failed."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
        AND failed."evidenceThrough" >= ${latest}
        AND (failed."disposition" IN ('STALE', 'UNKNOWN')
          OR (failed."disposition" = 'BLOCKED' AND failed."memoryJobId" IS NOT NULL
            AND failed."reviewedAt" >= ${recheckAfter})))
  `;
}

/** Earlier non-final v3 rows of the version. Both counts only grow while its
 * evidence is unchanged, so a recheck or retry always gets a new source hash;
 * the attempt count includes failures that spend no budget. */
function priorOrdinals(latest: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    (SELECT COUNT(*)::integer FROM "MemoryMaintenanceReview" AS prior
      WHERE prior."userId" = version."userId" AND prior."factVersionId" = version."id"
        AND prior."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
        AND prior."evidenceThrough" >= ${latest}
        AND prior."disposition" IN ('BLOCKED', 'UNREVIEWABLE')) AS "recheckOrdinal",
    (SELECT COUNT(*)::integer FROM "MemoryMaintenanceReview" AS prior
      WHERE prior."userId" = version."userId" AND prior."factVersionId" = version."id"
        AND prior."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION}
        AND prior."evidenceThrough" >= ${latest}
        AND (prior."disposition" IN ('STALE', 'UNKNOWN')
          OR (prior."disposition" = 'BLOCKED' AND prior."memoryJobId" IS NOT NULL))) AS "attemptOrdinal"
  `;
}

function boundedQuote(text: string): string {
  if (text.length <= MAX_QUOTE_CHARACTERS) return text;
  const code = text.charCodeAt(MAX_QUOTE_CHARACTERS);
  const previous = text.charCodeAt(MAX_QUOTE_CHARACTERS - 1);
  const end = code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
    ? MAX_QUOTE_CHARACTERS - 1 : MAX_QUOTE_CHARACTERS;
  return `${text.slice(0, end)}…`;
}

type SourceRow = Readonly<{
  factId: string; versionId: string; statement: string; category: string; modality: string;
  confidence: number; usefulness: MemoryUsefulness | null; observedAt: Date; evidenceThrough: Date;
  supportCount: number; recheckOrdinal: number; attemptOrdinal: number;
}>;

async function scanSources(
  client: QueryClient, userId: string,
  input: Readonly<{ versionIds?: readonly string[]; now: Date; unreviewed?: boolean; cursor?: string | null }>
): Promise<Readonly<{ sources: readonly MemoryMaintenanceSource[]; blockers: readonly MemoryMaintenanceBlocker[]; cursor: string | null }>> {
  if (input.versionIds?.length === 0) return { sources: [], blockers: [], cursor: null };
  const rows = await client.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT fact."id" AS "factId", version."id" AS "versionId", version."displayText" AS statement,
      version."category", version."modality"::text AS modality, version."confidence", version."usefulness",
      version."observedAt", latest."evidenceThrough", latest."supportCount",
      ${priorOrdinals(Prisma.sql`latest."evidenceThrough"`)}
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
        AND ${memoryMaintenanceUncoveredPredicate(Prisma.sql`latest."evidenceThrough"`, input.now)}
      ` : Prisma.empty}
    ORDER BY version."id" LIMIT ${MEMORY_MAINTENANCE_BATCH_SIZE}
  `);
  const cursor = rows.at(-1)?.versionId ?? null;
  if (rows.length === 0) return { sources: [], blockers: [], cursor };
  const factIds = [...new Set(rows.map(({ factId }) => factId))];
  const [lineageRows, withoutOffsets, newer] = await Promise.all([
    client.$queryRaw<Array<{ factId: string; id: string; state: string }>>(Prisma.sql`
      SELECT lineage."factId", lineage."id", lineage."state"::text AS state FROM "MemoryFactVersion" AS lineage
      WHERE lineage."userId" = ${userId} AND lineage."factId" IN (${Prisma.join(factIds)})
      ORDER BY lineage."factId", lineage."id"
    `),
    // The fence must cover every exact source span of the whole lineage.
    client.$queryRaw<Array<{ factId: string; id: string }>>(Prisma.sql`
      SELECT version."factId", evidence."id" FROM "MemoryEvidence" AS evidence
      JOIN "MemoryFactVersion" AS version ON version."userId" = evidence."userId" AND version."id" = evidence."factVersionId"
      WHERE evidence."userId" = ${userId} AND version."factId" IN (${Prisma.join(factIds)})
        AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance" AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
        AND (evidence."messageId" IS NULL OR evidence."sourceMessageContentHash" IS NULL
          OR evidence."sourceMessageContentHash" !~ '^[a-f0-9]{64}$'
          OR evidence."sourceStartOffset" IS NULL OR evidence."sourceEndOffset" IS NULL
          OR evidence."sourceStartOffset" < 0 OR evidence."sourceEndOffset" <= evidence."sourceStartOffset")
      ORDER BY version."factId", evidence."id"
    `),
    // Removal takes the whole lineage: unresolved newer testimony is not reviewed.
    client.$queryRaw<Array<{ factId: string; id: string }>>(Prisma.sql`
      SELECT newer."factId", newer."id" FROM "MemoryFactVersion" AS newer
      JOIN "MemoryFactVersion" AS reviewed ON reviewed."userId" = newer."userId" AND reviewed."factId" = newer."factId"
      WHERE newer."userId" = ${userId} AND reviewed."id" IN (${Prisma.join(rows.map(({ versionId }) => versionId))})
        AND newer."id" <> reviewed."id" AND newer."createdAt" > reviewed."createdAt"
        AND (newer."state" IN ('PENDING_RELATION'::"MemoryFactVersionState", 'CONFLICTING'::"MemoryFactVersionState")
          OR (newer."state" = 'ACTIVE'::"MemoryFactVersionState" AND EXISTS (SELECT 1 FROM "MemoryEvidence" AS newer_support
            WHERE newer_support."userId" = newer."userId" AND newer_support."factVersionId" = newer."id"
              AND newer_support."stance" = 'SUPPORTS'::"MemoryEvidenceStance")))
      ORDER BY newer."factId", newer."id"
    `)
  ]);
  const verified = await loadPersonalMemoryEvidenceSnapshots(client, userId, rows.map(({ versionId }) => versionId), { exactVNext: true });
  const evidence = verified.length === 0 ? [] : await client.$queryRaw<Array<MemoryMaintenanceEvidence & { factVersionId: string }>>(Prisma.sql`
    SELECT "id", "factVersionId", "chatId", "messageId", "branchGeneration", "sourceMessageContentHash" AS "sourceTextHash",
      "sourceStartOffset" AS "startOffset", "sourceEndOffset" AS "endOffset", "safeExcerpt" AS quote, "observedAt", "createdAt"
    FROM "MemoryEvidence" WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(verified.map(({ id }) => id))})
    ORDER BY "factVersionId", "createdAt", "id"
  `);
  const sources: MemoryMaintenanceSource[] = [];
  const blockers: MemoryMaintenanceBlocker[] = [];
  let characters = 0;
  for (const row of rows) {
    const lineage = lineageRows.filter(({ factId }) => factId === row.factId).map(({ id, state }) => ({ id, state }));
    const ordinals = { recheckOrdinal: row.recheckOrdinal, attemptOrdinal: row.attemptOrdinal };
    const block = (reasonCode: MemoryMaintenanceReasonCode, identity: unknown) => {
      blockers.push({ factId: row.factId, versionId: row.versionId, evidenceThrough: row.evidenceThrough,
        disposition: memoryMaintenanceReasonDisposition(reasonCode), reasonCode,
        sourceSnapshotHash: memorySha256({ domain: "memory-maintenance-blocker", factId: row.factId, versionId: row.versionId,
          evidenceThrough: row.evidenceThrough, lineage, blocker: { code: reasonCode, identity }, ...ordinals }) });
    };
    const pending = newer.filter(({ factId }) => factId === row.factId).map(({ id }) => id);
    if (pending.length) { block("pending_relation", pending); continue; }
    const inexact = withoutOffsets.filter(({ factId }) => factId === row.factId).map(({ id }) => id);
    if (inexact.length) { block("evidence_without_offsets", inexact); continue; }
    if (row.statement.length > MAX_STATEMENT_CHARACTERS) { block("statement_too_long", row.statement.length); continue; }
    // The newest exact current supports; older ones stay in the hash through
    // evidenceThrough and supportCount.
    const supports = evidence.filter(({ factVersionId }) => factVersionId === row.versionId)
      .filter((support) => Number.isSafeInteger(support.startOffset) && Number.isSafeInteger(support.endOffset) &&
        support.endOffset > support.startOffset && Boolean(support.sourceTextHash))
      .slice(-MAX_REVIEWED_EVIDENCE);
    if (supports.length === 0) { block("evidence_not_current", row.supportCount); continue; }
    const context = await loadMemoryMaintenanceContext(client, userId, row.versionId,
      supports.map(({ messageId, startOffset, endOffset }) => ({ messageId, startOffset, endOffset })));
    if (!context) { block("unreviewable_context", [...new Set(supports.map(({ messageId }) => messageId))].sort()); continue; }
    const statement = redactMemorySecrets(row.statement).redactedText;
    const safeEvidence = supports.map(({ factVersionId: _factVersionId, ...support }) => ({
      ...support, quote: boundedQuote(redactMemorySecrets(support.quote).redactedText) }));
    const size = statement.length + safeEvidence.reduce((sum, item) => sum + item.quote.length, 0) + context.reduce((sum, item) => sum + item.text.length, 0);
    if (input.unreviewed && characters + size > MAX_BATCH_CHARACTERS) continue;
    characters += size;
    const sourceSnapshotHash = memorySha256({ factId: row.factId, versionId: row.versionId, statement,
      category: row.category, modality: row.modality, confidence: row.confidence, usefulness: row.usefulness,
      observedAt: row.observedAt, evidenceThrough: row.evidenceThrough, supportCount: row.supportCount,
      evidence: safeEvidence, context, lineage, blocker: null, ...ordinals });
    sources.push({ ref: `S${sources.length + 1}`, factId: row.factId, versionId: row.versionId, statement,
      category: row.category, modality: row.modality, confidence: row.confidence, usefulness: row.usefulness,
      observedAt: row.observedAt, evidence: safeEvidence, context, evidenceThrough: row.evidenceThrough, sourceSnapshotHash });
  }
  return { sources, blockers, cursor };
}

/** Current state of exact versions: a reviewable source or a blocker. Never writes. */
export async function loadMemoryMaintenanceSources(client: QueryClient, userId: string,
  input: Readonly<{ versionIds: readonly string[]; now: Date }>): Promise<Readonly<{
    sources: ReadonlyMap<string, MemoryMaintenanceSource>; blockers: ReadonlyMap<string, MemoryMaintenanceBlocker>;
  }>> {
  const scan = await scanSources(client, userId, input);
  return { sources: new Map(scan.sources.map((source) => [source.versionId, source])),
    blockers: new Map(scan.blockers.map((blocker) => [blocker.versionId, blocker])) };
}
/** Next page of uncovered sources. Blockers are only returned here; the
 * planner records them inside its locked transaction. */
export async function scanMemoryMaintenanceSources(client: QueryClient, userId: string, now: Date,
  cursor: string | null): Promise<MemoryMaintenanceScan> {
  const scan = await scanSources(client, userId, { now, cursor, unreviewed: true });
  return { plan: scan.sources.length ? memoryMaintenancePlan(scan.sources) : null, blockers: scan.blockers, cursor: scan.cursor };
}

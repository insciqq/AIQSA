import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../../persistence/transaction";
import { memorySha256 } from "../../persistence/lexical";
import type {
  MemoryExtractedCandidate,
  MemoryFactCandidateEntity
} from "../extraction/contract";
import {
  memoryEntityAliases,
  memoryEntityAliasSupportFingerprint,
  memoryEntityCanonicalKey,
  normalizeMemoryEntityAlias,
  type MemoryEntityType
} from "./normalization";
import {
  resolveMemoryEntityCandidate,
  type MemoryEntityResolutionCandidate
} from "./resolver";

type EntityRow = Readonly<{
  canonicalKey: string;
  entityType: MemoryEntityType;
  id: string;
  mergedIntoId: string | null;
}>;

type LockedEntity = Readonly<{
  entityType: string;
  id: string;
  mergedIntoId: string | null;
  state: string;
}>;

async function rootId(
  tx: MemoryTransaction,
  userId: string,
  entityId: string
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{
    cycle: boolean;
    id: string;
    mergedIntoId: string | null;
  }>>(Prisma.sql`
    WITH RECURSIVE roots AS (
      SELECT entity."id", entity."mergedIntoId",
        ARRAY[entity."id"]::text[] AS visited, FALSE AS cycle
      FROM "MemoryEntity" AS entity
      WHERE entity."userId" = ${userId} AND entity."id" = ${entityId}

      UNION ALL

      SELECT entity."id", entity."mergedIntoId", roots.visited || entity."id",
        entity."id" = ANY(roots.visited)
      FROM roots
      INNER JOIN "MemoryEntity" AS entity
        ON entity."userId" = ${userId} AND entity."id" = roots."mergedIntoId"
      WHERE NOT roots.cycle
    )
    SELECT "id", "mergedIntoId", cycle FROM roots
    ORDER BY cardinality(visited) DESC
  `);
  if (rows.some(({ cycle }) => cycle)) throw new Error("memory_entity_merge_cycle");
  return rows.find(({ mergedIntoId }) => mergedIntoId === null)?.id ?? null;
}

async function resolutionCandidates(
  tx: MemoryTransaction,
  userId: string,
  entity: MemoryFactCandidateEntity,
  canonicalKey: string
): Promise<readonly MemoryEntityResolutionCandidate[]> {
  const normalizedAliases = memoryEntityAliases(entity)
    .map(({ normalizedAlias }) => normalizedAlias);
  const rows = await tx.$queryRaw<EntityRow[]>(Prisma.sql`
    SELECT DISTINCT entity."id", entity."canonicalKey",
      entity."entityType", entity."mergedIntoId"
    FROM "MemoryEntity" AS entity
    LEFT JOIN "MemoryEntityAlias" AS alias
      ON alias."userId" = entity."userId" AND alias."entityId" = entity."id"
    WHERE entity."userId" = ${userId}
      AND (
        entity."id" = ${entity.contextEntityId}
        OR entity."canonicalKey" = ${canonicalKey}
        OR ${normalizedAliases.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`alias."normalizedAlias" IN (${Prisma.join(normalizedAliases)})`}
      )
    ORDER BY entity."id"
    LIMIT 32
  `);
  const candidates: MemoryEntityResolutionCandidate[] = [];
  for (const row of rows) {
    const canonicalRootId = await rootId(tx, userId, row.id);
    if (!canonicalRootId) continue;
    const root = canonicalRootId === row.id
      ? row
      : await tx.memoryEntity.findFirst({
          select: { canonicalKey: true, entityType: true, id: true, mergedIntoId: true },
          where: { id: canonicalRootId, userId }
        }) as EntityRow | null;
    if (!root) continue;
    const aliases = await tx.memoryEntityAlias.findMany({
      orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }],
      select: { normalizedAlias: true },
      where: { entityId: row.id, userId }
    });
    candidates.push({
      aliases: aliases.map(({ normalizedAlias }) => normalizedAlias),
      canonicalKey: root.canonicalKey,
      entityType: root.entityType,
      id: row.id,
      rootId: root.id
    });
  }
  return candidates;
}

function entityId(userId: string, canonicalKey: string): string {
  return memorySha256({
    canonicalKey,
    domain: "aiqsa.memory.entity",
    userId,
    version: 2
  });
}

async function resolveOrCreate(
  tx: MemoryTransaction,
  userId: string,
  entity: MemoryFactCandidateEntity,
  languageCode: string
): Promise<string | null> {
  const canonicalKey = memoryEntityCanonicalKey(entity);
  if (!canonicalKey) return null;
  const candidates = await resolutionCandidates(
    tx,
    userId,
    entity,
    canonicalKey
  );
  const resolution = resolveMemoryEntityCandidate({
    aliases: [entity.mention, entity.canonicalLabel, ...entity.aliases],
    canonicalLabel: entity.canonicalLabel,
    contextEntityId: entity.contextEntityId,
    entityType: entity.entityType as MemoryEntityType,
    qualifiers: entity.qualifiers
  }, candidates);
  if (resolution.outcome === "AMBIGUOUS") return null;
  if (resolution.outcome === "REUSE") return resolution.entityId;
  const id = entityId(userId, resolution.canonicalKey);
  await tx.memoryEntity.createMany({
    data: [{
      canonicalKey: resolution.canonicalKey,
      displayName: entity.canonicalLabel,
      entityType: entity.entityType,
      id,
      languageCode,
      userId
    }],
    skipDuplicates: true
  });
  return (await tx.memoryEntity.findFirst({
    select: { id: true },
    where: { canonicalKey: resolution.canonicalKey, userId }
  }))?.id ?? null;
}

function sourceContainsAlias(source: string, displayAlias: string): boolean {
  return source.normalize("NFKC").toLocaleLowerCase("und").includes(
    displayAlias.normalize("NFKC").trim().toLocaleLowerCase("und")
  );
}

async function attachAliases(
  tx: MemoryTransaction,
  input: Readonly<{
    entity: MemoryFactCandidateEntity;
    entityId: string;
    evidenceId: string;
    languageCode: string;
    quote: string;
    userId: string;
  }>
): Promise<void> {
  const grounded = memoryEntityAliases(input.entity).filter(({ displayAlias }) =>
    sourceContainsAlias(input.quote, displayAlias));
  for (const alias of grounded) {
    const id = memorySha256({
      domain: "aiqsa.memory.entity-alias",
      entityId: input.entityId,
      normalizedAlias: alias.normalizedAlias,
      userId: input.userId,
      version: 1
    });
    await tx.memoryEntityAlias.createMany({
      data: [{
        confidence: 1,
        displayAlias: alias.displayAlias,
        entityId: input.entityId,
        id,
        languageCode: input.languageCode,
        normalizedAlias: alias.normalizedAlias,
        sourceKind: "AUTOMATIC_EVIDENCE",
        userId: input.userId
      }],
      skipDuplicates: true
    });
    const stored = await tx.memoryEntityAlias.findFirst({
      select: { id: true },
      where: {
        entityId: input.entityId,
        normalizedAlias: alias.normalizedAlias,
        userId: input.userId
      }
    });
    if (!stored) throw new Error("memory_entity_alias_commit_failed");
    const supportFingerprint = memoryEntityAliasSupportFingerprint({
      aliasId: stored.id,
      evidenceId: input.evidenceId,
      userId: input.userId
    });
    await tx.memoryEntityAliasSupport.createMany({
      data: [{
        aliasId: stored.id,
        evidenceId: input.evidenceId,
        id: memorySha256({
          domain: "aiqsa.memory.entity-alias-support-id",
          supportFingerprint
        }),
        supportFingerprint,
        supportKind: "EVIDENCE",
        userId: input.userId
      }],
      skipDuplicates: true
    });
  }
}

export async function persistMemoryCandidateEntities(
  tx: MemoryTransaction,
  input: Readonly<{
    candidate: MemoryExtractedCandidate;
    evidenceId: string;
    factVersionId: string;
    userId: string;
  }>
): Promise<void> {
  const entities = [...input.candidate.entities].sort((left, right) => {
    const leftKey = memoryEntityCanonicalKey(left) ?? left.canonicalLabel;
    const rightKey = memoryEntityCanonicalKey(right) ?? right.canonicalLabel;
    return `${leftKey}:${left.role}`.localeCompare(`${rightKey}:${right.role}`);
  });
  for (const entity of entities) {
    const canonicalEntityId = await resolveOrCreate(
      tx,
      input.userId,
      entity,
      input.candidate.languageCode
    );
    if (!canonicalEntityId) continue;
    await tx.memoryFactVersionEntity.createMany({
      data: [{
        confidence: 1,
        entityId: canonicalEntityId,
        factVersionId: input.factVersionId,
        mentionText: entity.mention,
        normalizedMention: normalizeMemoryEntityAlias(entity.mention),
        role: entity.role,
        userId: input.userId
      }],
      skipDuplicates: true
    });
    await attachAliases(tx, {
      entity,
      entityId: canonicalEntityId,
      evidenceId: input.evidenceId,
      languageCode: input.candidate.languageCode,
      quote: input.candidate.quote ?? input.candidate.evidence[0]?.quote ?? "",
      userId: input.userId
    });
  }
}

function compatibleEntityTypes(left: string, right: string): boolean {
  return left === right ||
    (left === "PRODUCT" && right === "DEVICE") ||
    (left === "DEVICE" && right === "PRODUCT");
}

export async function mergeMemoryEntities(
  tx: MemoryTransaction,
  userId: string,
  redundantEntityId: string,
  canonicalEntityId: string
): Promise<string> {
  if (redundantEntityId === canonicalEntityId) {
    throw new Error("memory_entity_merge_self");
  }
  const redundantRootBeforeLock = await rootId(tx, userId, redundantEntityId);
  const canonicalRootBeforeLock = await rootId(tx, userId, canonicalEntityId);
  if (!redundantRootBeforeLock || !canonicalRootBeforeLock ||
    redundantRootBeforeLock === canonicalRootBeforeLock) {
    throw new Error("memory_entity_merge_invalid");
  }
  const ids = [redundantRootBeforeLock, canonicalRootBeforeLock].sort();
  const rows = await tx.$queryRaw<LockedEntity[]>(Prisma.sql`
    SELECT "id", "entityType", "state"::text AS state, "mergedIntoId"
    FROM "MemoryEntity"
    WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `);
  if (rows.length !== 2) throw new Error("memory_entity_merge_target_missing");
  const redundantRoot = await rootId(tx, userId, redundantEntityId);
  const canonicalRoot = await rootId(tx, userId, canonicalEntityId);
  if (redundantRoot !== redundantRootBeforeLock ||
    canonicalRoot !== canonicalRootBeforeLock) {
    throw new Error("memory_entity_merge_stale");
  }
  const redundant = rows.find(({ id }) => id === redundantRoot);
  const canonical = rows.find(({ id }) => id === canonicalRoot);
  if (!redundant || !canonical ||
    !compatibleEntityTypes(redundant.entityType, canonical.entityType)) {
    throw new Error("memory_entity_merge_incompatible");
  }
  const updated = await tx.memoryEntity.updateMany({
    data: {
      mergedIntoId: canonicalRoot,
      state: "MERGED",
      updatedAt: new Date()
    },
    where: {
      id: redundantRoot,
      mergedIntoId: null,
      state: "ACTIVE",
      userId
    }
  });
  if (updated.count !== 1) throw new Error("memory_entity_merge_stale");
  return canonicalRoot;
}

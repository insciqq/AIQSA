import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../../persistence/transaction";
import { memorySha256 } from "../../persistence/lexical";
import type {
  MemoryExtractedCandidate,
  MemoryFactCandidateEntity
} from "../extraction/contract";
import { memoryEntitySlotCanonicalKey } from "../identity/normalization";
import {
  loadAdmissibleMemoryEntityAliases,
  memoryAdmissibleEntityAliasPredicate,
  memoryEntityRootIdSql
} from "./authority";
import {
  memoryEntityAliases,
  memoryEntityAliasSupportFingerprint,
  memoryGroundedEntityCanonicalKey,
  memoryGroundedEntityCanonicalKeys,
  normalizeMemoryEntityAlias,
  type MemoryEntityType
} from "./normalization";
import {
  memoryLegacyIdentityIsUnambiguous,
  registerMemoryIdentityCompatibility
} from "../identity/compatibility";

type EntityRow = Readonly<{
  canonicalKey: string;
  entityType: MemoryEntityType;
  id: string;
  mergedIntoId: string | null;
  state: string;
}>;

type ResolutionCandidate = EntityRow & Readonly<{
  aliases: readonly string[];
  rootId: string;
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
  const [row] = await tx.$queryRaw<Array<{ id: string | null }>>(Prisma.sql`
    SELECT ${memoryEntityRootIdSql(userId, Prisma.sql`${entityId}`)} AS "id"
  `);
  return row?.id ?? null;
}

async function resolutionCandidates(
  tx: MemoryTransaction,
  userId: string,
  entity: MemoryFactCandidateEntity,
  canonicalKeys: readonly string[],
  adjudicatedEntityId: string | null
): Promise<readonly ResolutionCandidate[]> {
  const normalizedAliases = memoryEntityAliases(entity)
    .map(({ normalizedAlias }) => normalizedAlias);
  const lookupIds = [entity.contextEntityId, adjudicatedEntityId]
    .filter((id): id is string => id !== null);
  const rows = await tx.$queryRaw<EntityRow[]>(Prisma.sql`
    SELECT DISTINCT entity."id", entity."canonicalKey",
      entity."entityType", entity."mergedIntoId", entity."state"::text AS state
    FROM "MemoryEntity" AS entity
    WHERE entity."userId" = ${userId}
      AND (
        ${lookupIds.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`entity."id" IN (${Prisma.join(lookupIds)})`}
        OR ${canonicalKeys.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`entity."canonicalKey" IN (${Prisma.join(canonicalKeys)})`}
        OR ${normalizedAliases.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`EXISTS (
              SELECT 1 FROM "MemoryEntityAlias" AS alias
              WHERE alias."userId" = entity."userId"
                AND alias."entityId" = entity."id"
                AND alias."normalizedAlias" IN (${Prisma.join(normalizedAliases)})
                AND ${memoryAdmissibleEntityAliasPredicate(userId)}
            )`}
      )
    ORDER BY entity."id"
    LIMIT 32
  `);
  const candidates: ResolutionCandidate[] = [];
  for (const row of rows) {
    const canonicalRootId = await rootId(tx, userId, row.id);
    if (!canonicalRootId) continue;
    const root = canonicalRootId === row.id
      ? row
      : await tx.memoryEntity.findFirst({
          select: {
            canonicalKey: true,
            entityType: true,
            id: true,
            mergedIntoId: true,
            state: true
          },
          where: { id: canonicalRootId, userId }
        }) as EntityRow | null;
    if (!root || root.state !== "ACTIVE") continue;
    const aliases = await loadAdmissibleMemoryEntityAliases(
      tx,
      userId,
      [row.id],
      16
    );
    candidates.push({
      ...row,
      aliases: aliases.map(({ normalizedAlias }) => normalizedAlias),
      canonicalKey: root.canonicalKey,
      entityType: root.entityType,
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
    version: 3
  });
}

function renewedEntityCanonicalKey(
  baseCanonicalKey: string,
  terminalEntityId: string
): string {
  const renewal = memorySha256({
    baseCanonicalKey,
    domain: "aiqsa.memory.entity-renewal",
    terminalEntityId,
    version: 1
  });
  const suffix = `:renewed:${renewal.slice(0, 32)}`;
  return baseCanonicalKey.length + suffix.length <= 256
    ? `${baseCanonicalKey}${suffix}`
    : `entity:${
        baseCanonicalKey.startsWith("entity:v4:") ? "v4" : "v3"
      }:renewed:${renewal}`;
}

function compatibleEntityTypes(left: string, right: string): boolean {
  return left === right ||
    (left === "PRODUCT" && right === "DEVICE") ||
    (left === "DEVICE" && right === "PRODUCT");
}

function exactAliasRoots(
  entity: MemoryFactCandidateEntity,
  candidates: readonly ResolutionCandidate[]
): readonly string[] {
  const aliases = new Set(memoryEntityAliases(entity)
    .map(({ normalizedAlias }) => normalizedAlias));
  return [...new Set(candidates
    .filter((candidate) => compatibleEntityTypes(
      candidate.entityType,
      entity.entityType
    ) && candidate.aliases.some((alias) => aliases.has(alias)))
    .map(({ rootId }) => rootId))].sort();
}

async function resolveOrCreate(
  tx: MemoryTransaction,
  userId: string,
  entity: MemoryFactCandidateEntity,
  languageCode: string,
  identityProfile: MemoryExtractedCandidate["identityProfile"],
  adjudicatedEntityId: string | null = null
): Promise<string | null> {
  const keySet = memoryGroundedEntityCanonicalKeys(entity);
  if (keySet) {
    await registerMemoryIdentityCompatibility(tx, {
      containerId: "ENTITY",
      legacyCanonicalKey: keySet.legacyCanonicalKey,
      namespace: "GROUNDED_ENTITY",
      now: new Date(),
      unicodeCanonicalKey: keySet.unicodeCanonicalKey,
      userId
    });
  }
  const legacyIsUnambiguous = keySet === null
    ? false
    : await memoryLegacyIdentityIsUnambiguous(tx, {
        containerId: "ENTITY",
        legacyCanonicalKey: keySet.legacyCanonicalKey,
        namespace: "GROUNDED_ENTITY",
        unicodeCanonicalKey: keySet.unicodeCanonicalKey,
        userId
      });
  const canonicalKey = keySet === null
    ? null
    : identityProfile === "LEGACY_V1" && legacyIsUnambiguous
      ? keySet.legacyCanonicalKey
      : keySet.unicodeCanonicalKey;
  const canonicalKeys = keySet === null
    ? []
    : legacyIsUnambiguous
      ? [keySet.unicodeCanonicalKey, keySet.legacyCanonicalKey]
      : [keySet.unicodeCanonicalKey];
  const candidates = await resolutionCandidates(
    tx,
    userId,
    entity,
    canonicalKeys,
    adjudicatedEntityId
  );

  if (entity.contextEntityId !== null) {
    const context = candidates.find((candidate) =>
      compatibleEntityTypes(candidate.entityType, entity.entityType) &&
      (candidate.id === entity.contextEntityId ||
        candidate.rootId === entity.contextEntityId));
    if (!context) return null;
    if (adjudicatedEntityId !== null) {
      const adjudicatedRoot = await rootId(tx, userId, adjudicatedEntityId);
      if (adjudicatedRoot !== context.rootId) return null;
    }
    return context.rootId;
  }

  const unicodeRoots = keySet === null
    ? []
    : [...new Set(candidates.filter((candidate) =>
        candidate.canonicalKey === keySet.unicodeCanonicalKey &&
        compatibleEntityTypes(candidate.entityType, entity.entityType) &&
        candidate.aliases.length > 0)
      .map(({ rootId }) => rootId))].sort();
  if (unicodeRoots.length === 1) return unicodeRoots[0]!;
  if (unicodeRoots.length > 1) return null;
  const canonicalRoots = keySet === null || !legacyIsUnambiguous
    ? []
    : [...new Set(candidates.filter((candidate) =>
        candidate.canonicalKey === keySet.legacyCanonicalKey &&
        compatibleEntityTypes(candidate.entityType, entity.entityType) &&
        candidate.aliases.length > 0)
      .map(({ rootId }) => rootId))].sort();
  if (canonicalRoots.length === 1) return canonicalRoots[0]!;
  if (canonicalRoots.length > 1) return null;

  const aliasRoots = exactAliasRoots(entity, candidates);
  if (aliasRoots.length === 1) return aliasRoots[0]!;
  if (aliasRoots.length > 1) {
    const adjudicatedRoot = adjudicatedEntityId === null
      ? null
      : await rootId(tx, userId, adjudicatedEntityId);
    if (!adjudicatedRoot || !aliasRoots.includes(adjudicatedRoot)) return null;
    // HIGH semantic authority is checked before this repository is called.
    // Exact admissible alias collision bounds the merge and prevents broad /
    // specific lexical similarity from becoming merge authority.
    for (const redundantRoot of aliasRoots) {
      if (redundantRoot === adjudicatedRoot) continue;
      await mergeMemoryEntities(tx, userId, redundantRoot, adjudicatedRoot);
    }
    return adjudicatedRoot;
  }

  if (adjudicatedEntityId !== null) {
    const adjudicatedRoot = await rootId(tx, userId, adjudicatedEntityId);
    const adjudicated = candidates.find(({ rootId }) =>
      rootId === adjudicatedRoot);
    if (adjudicatedRoot && adjudicated && compatibleEntityTypes(
      adjudicated.entityType,
      entity.entityType
    )) return adjudicatedRoot;
    return null;
  }

  if (!canonicalKey) return null;
  let creationKey = canonicalKey;
  for (let depth = 0; depth < 16; depth += 1) {
    const id = entityId(userId, creationKey);
    await tx.memoryEntity.createMany({
      data: [{
        automaticOnly: true,
        canonicalKey: creationKey,
        displayName: entity.mention!,
        entityType: entity.entityType,
        id,
        languageCode,
        userId
      }],
      skipDuplicates: true
    });
    const stored = await tx.memoryEntity.findFirst({
      select: { id: true, state: true },
      where: { canonicalKey: creationKey, userId }
    });
    if (!stored) throw new Error("memory_entity_commit_failed");
    if (stored.state === "ACTIVE") return stored.id;
    if (stored.state === "MERGED") {
      const canonicalRoot = await rootId(tx, userId, stored.id);
      if (canonicalRoot) return canonicalRoot;
    }
    creationKey = renewedEntityCanonicalKey(canonicalKey, stored.id);
  }
  return null;
}

/** Resolves the mandatory product subject before observation fingerprints and
 * fact lookup are computed. Call this inside the per-candidate savepoint. */
export async function materializeMemoryCandidateEntityIdentity(
  tx: MemoryTransaction,
  input: Readonly<{
    adjudicatedEntityId: string | null;
    candidate: MemoryExtractedCandidate;
    userId: string;
  }>
): Promise<MemoryExtractedCandidate> {
  const candidate = input.candidate;
  if (candidate.identityKind !== "SLOT" ||
    candidate.predicateKey !== "product_status") return candidate;

  if (candidate.identityVersion === "slot-v3" && candidate.subjectEntityId) {
    const canonicalRoot = await rootId(
      tx,
      input.userId,
      candidate.subjectEntityId
    );
    if (canonicalRoot !== candidate.subjectEntityId) {
      throw new Error("memory_fact_candidate_invalid");
    }
    return candidate;
  }

  const subjects = candidate.entities.filter((entity) =>
    entity.role === "SUBJECT" &&
    (entity.entityType === "PRODUCT" || entity.entityType === "DEVICE"));
  if (subjects.length !== 1) throw new Error("memory_fact_candidate_invalid");
  const subject = subjects[0]!;
  const resolvedEntityId = await resolveOrCreate(
    tx,
    input.userId,
    subject,
    candidate.languageCode,
    candidate.identityProfile,
    input.adjudicatedEntityId
  );
  if (!resolvedEntityId) throw new Error("memory_fact_candidate_invalid");
  const canonicalKey = memoryEntitySlotCanonicalKey(resolvedEntityId);
  return Object.freeze({
    ...candidate,
    canonicalKey,
    entities: Object.freeze(candidate.entities.map((entity) =>
      entity === subject
        ? Object.freeze({ ...entity, contextEntityId: resolvedEntityId })
        : entity)),
    identityVersion: "slot-v3" as const,
    legacyCanonicalKey: canonicalKey,
    subjectEntityId: resolvedEntityId,
    subjectKey: `entity:${resolvedEntityId}`,
    unicodeCanonicalKey: canonicalKey
  });
}

async function attachAliases(
  tx: MemoryTransaction,
  input: Readonly<{
    entity: MemoryFactCandidateEntity;
    entityId: string;
    evidenceId: string;
    languageCode: string;
    userId: string;
  }>
): Promise<void> {
  const grounded = memoryEntityAliases(input.entity);
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
    const leftKey = memoryGroundedEntityCanonicalKey(left) ?? left.canonicalLabel;
    const rightKey = memoryGroundedEntityCanonicalKey(right) ?? right.canonicalLabel;
    return `${leftKey}:${left.role}`.localeCompare(`${rightKey}:${right.role}`);
  });
  for (const entity of entities) {
    const materializedSubjectId = entity.role === "SUBJECT" &&
      input.candidate.predicateKey === "product_status"
      ? input.candidate.subjectEntityId ?? null
      : null;
    const canonicalEntityId = materializedSubjectId === null
      ? await resolveOrCreate(
          tx,
          input.userId,
          entity,
          input.candidate.languageCode,
          input.candidate.identityProfile
        )
      : await rootId(tx, input.userId, materializedSubjectId);
    if (materializedSubjectId !== null &&
      canonicalEntityId !== materializedSubjectId) {
      throw new Error("memory_fact_candidate_invalid");
    }
    if (!canonicalEntityId) continue;
    await tx.memoryFactVersionEntity.createMany({
      data: [{
        confidence: 1,
        entityId: canonicalEntityId,
        factVersionId: input.factVersionId,
        mentionText: entity.mention,
        normalizedMention: entity.mention === null
          ? null
          : normalizeMemoryEntityAlias(entity.mention),
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
      userId: input.userId
    });
  }
}

export async function mergeMemoryEntities(
  tx: MemoryTransaction,
  userId: string,
  redundantEntityId: string,
  canonicalEntityId: string
): Promise<string> {
  if (redundantEntityId === canonicalEntityId) {
    const canonicalRoot = await rootId(tx, userId, canonicalEntityId);
    if (!canonicalRoot) throw new Error("memory_entity_merge_invalid");
    return canonicalRoot;
  }
  const redundantRootBeforeLock = await rootId(tx, userId, redundantEntityId);
  const canonicalRootBeforeLock = await rootId(tx, userId, canonicalEntityId);
  if (!redundantRootBeforeLock || !canonicalRootBeforeLock) {
    throw new Error("memory_entity_merge_invalid");
  }
  if (redundantRootBeforeLock === canonicalRootBeforeLock) {
    return canonicalRootBeforeLock;
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
  if (redundantRoot !== null && redundantRoot === canonicalRoot) {
    return redundantRoot;
  }
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

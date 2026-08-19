import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeProcessingWarningCode } from "../../domain/knowledgeProcessingWarnings";
import type {
  KnowledgeSourceBaseMembership,
  KnowledgeSourceDetail,
  KnowledgeSourceDuplicateInput,
  KnowledgeSourceFilter,
  KnowledgeSourceListResponse,
  KnowledgeSourceReadiness,
  KnowledgeSourceSummary,
  KnowledgeSourceUpdateInput,
  KnowledgeSourceVersionSummary
} from "../../contracts/knowledge";
import { prisma } from "../prisma";
import { knowledgeTrashPurgeScheduledAt } from "./lifecyclePolicy";
import { knowledgeSourceNormalizedTextStorageKey } from "./sourceArtifactKeys";
import { knowledgeSupportReference } from "./supportReference";

type ArtifactRow = Readonly<{
  errorCode: string | null;
  pageCount: number | null;
  state: "failed" | "pending" | "processing" | "ready";
  updatedAt: Date;
  warningCodes: KnowledgeProcessingWarningCode[];
}>;

type VersionRow = Readonly<{
  artifacts: ArtifactRow[];
  byteSize: number;
  createdAt: Date;
  fileName: string;
  id: string;
  versionNumber: number;
}>;

type SourceRow = Readonly<{
  baseMemberships: Array<Readonly<{
    knowledgeBase: Readonly<{
      archivedAt: Date | null;
      id: string;
      name: string;
    }>;
  }>>;
  createdAt: Date;
  currentVersion: VersionRow | null;
  currentVersionId: string | null;
  deletionRequestedAt: Date | null;
  description: string;
  id: string;
  name: string;
  owner: Readonly<{ displayName: string }>;
  ownerUserId: string;
  pendingVersion: VersionRow | null;
  pendingVersionId: string | null;
  tags: string[];
  trashedAt: Date | null;
  updatedAt: Date;
  version: number;
}>;

type SourceDetailRow = SourceRow & Readonly<{ versions: VersionRow[] }>;

type AccessibleBase = Readonly<{
  archivedAt: Date | null;
  id: string;
  name: string;
  ownerUserId: string;
}>;

export type KnowledgeSourceWriteResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "version_conflict" }>;

export type KnowledgeSourceMembershipResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok" }>;

export type KnowledgeSourceVersionCreateInput = Readonly<{
  byteSize: number;
  checksum: string;
  fileName: string;
  mimeType: string;
  now: Date;
  originalStorageKey: string;
  sourceId: string;
  sourceVersionId: string;
  userId: string;
}>;

export type KnowledgeSourceVersionCreateResult =
  | Readonly<{ kind: "active_ingest" | "not_found" | "profile_unavailable" }>
  | Readonly<{ kind: "ok"; sourceVersionId: string }>;

export type KnowledgeSourceReprocessResult =
  | Readonly<{
      kind: "active_ingest" | "not_found" | "not_retryable" | "profile_unavailable";
    }>
  | Readonly<{ kind: "ok" }>;

const artifactSelect = {
  errorCode: true,
  pageCount: true,
  state: true,
  updatedAt: true,
  warningCodes: true
} satisfies Prisma.KnowledgeSourceIndexArtifactSelect;

const versionSelect = {
  artifacts: { orderBy: [{ updatedAt: "desc" as const }, { id: "asc" as const }], select: artifactSelect },
  byteSize: true,
  createdAt: true,
  fileName: true,
  id: true,
  versionNumber: true
} satisfies Prisma.KnowledgeSourceVersionSelect;

function sourceSelect(accessibleBaseIds: readonly string[], detail: boolean) {
  return {
    baseMemberships: {
      orderBy: { knowledgeBase: { name: "asc" as const } },
      select: {
        knowledgeBase: {
          select: { archivedAt: true, id: true, name: true }
        }
      },
      where: {
        knowledgeBaseId: { in: [...accessibleBaseIds] },
        removedAt: null
      }
    },
    createdAt: true,
    currentVersion: { select: versionSelect },
    currentVersionId: true,
    deletionRequestedAt: true,
    description: true,
    id: true,
    name: true,
    owner: { select: { displayName: true } },
    ownerUserId: true,
    pendingVersion: { select: versionSelect },
    pendingVersionId: true,
    tags: true,
    trashedAt: true,
    updatedAt: true,
    version: true,
    ...(detail
      ? {
          versions: {
            orderBy: [{ versionNumber: "desc" as const }, { id: "asc" as const }],
            select: versionSelect
          }
        }
      : {})
  } satisfies Prisma.KnowledgeSourceSelect;
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && isSerializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_source_library_retry_exhausted");
}

function versionReadiness(sourceId: string, version: VersionRow): KnowledgeSourceReadiness {
  const ready = version.artifacts.find((artifact) => artifact.state === "ready");
  if (ready) {
    return { state: "ready", supportReference: null, warningCodes: [...ready.warningCodes] };
  }
  if (version.artifacts.some((artifact) =>
    artifact.state === "pending" || artifact.state === "processing")) {
    return { state: "processing", supportReference: null, warningCodes: [] };
  }
  const issueParts = version.artifacts.length > 0
    ? version.artifacts.map((artifact) => artifact.errorCode ?? artifact.state).sort()
    : ["artifact_unavailable"];
  return {
    state: "needs_attention",
    supportReference: knowledgeSupportReference("source", sourceId, version.id, ...issueParts),
    warningCodes: []
  };
}

function safeVersion(
  sourceId: string,
  version: VersionRow,
  pointers: Readonly<{ currentVersionId: string | null; pendingVersionId: string | null }>
): KnowledgeSourceVersionSummary {
  const readiness = versionReadiness(sourceId, version);
  const readyArtifact = version.artifacts.find((artifact) => artifact.state === "ready");
  return {
    byteSize: version.byteSize,
    createdAt: version.createdAt.toISOString(),
    fileName: version.fileName,
    isCurrent: pointers.currentVersionId === version.id,
    isPending: pointers.pendingVersionId === version.id,
    pageCount: readyArtifact?.pageCount ?? null,
    readiness,
    versionNumber: version.versionNumber
  };
}

function latestUpdatedAt(source: SourceRow): Date {
  const candidates = [
    source.createdAt,
    source.updatedAt,
    ...(source.currentVersion?.artifacts.map((artifact) => artifact.updatedAt) ?? []),
    ...(source.pendingVersion?.artifacts.map((artifact) => artifact.updatedAt) ?? [])
  ];
  return candidates.reduce((latest, candidate) => candidate > latest ? candidate : latest);
}

function safeMemberships(source: SourceRow): KnowledgeSourceBaseMembership[] {
  return source.baseMemberships.map(({ knowledgeBase }) => ({
    archived: knowledgeBase.archivedAt !== null,
    id: knowledgeBase.id,
    name: knowledgeBase.name
  }));
}

function safeSummary(source: SourceRow, userId: string): KnowledgeSourceSummary {
  const pointers = {
    currentVersionId: source.currentVersionId,
    pendingVersionId: source.pendingVersionId
  };
  const currentVersion = source.currentVersion
    ? safeVersion(source.id, source.currentVersion, pointers)
    : null;
  const pendingReadiness = source.pendingVersion
    ? versionReadiness(source.id, source.pendingVersion)
    : null;
  const readiness: KnowledgeSourceReadiness = currentVersion?.readiness.state === "ready"
    ? currentVersion.readiness
    : currentVersion?.readiness ?? (pendingReadiness?.state === "needs_attention"
      ? pendingReadiness
      : { state: "processing", supportReference: null, warningCodes: [] });
  const replacement: KnowledgeSourceSummary["replacement"] =
    pendingReadiness?.state === "needs_attention"
      ? {
          state: "needs_attention",
          supportReference: pendingReadiness.supportReference
        }
      : pendingReadiness
        ? { state: "processing", supportReference: null }
        : { state: "none", supportReference: null };
  return {
    currentVersion,
    deletionPending: source.deletionRequestedAt !== null,
    description: source.description,
    id: source.id,
    membershipCount: source.baseMemberships.length,
    name: source.name,
    owned: source.ownerUserId === userId,
    ownerDisplayName: source.owner.displayName,
    purgeScheduledAt: knowledgeTrashPurgeScheduledAt(source.trashedAt)?.toISOString() ?? null,
    readiness,
    replacement,
    tags: [...source.tags],
    trashed: source.trashedAt !== null,
    trashedAt: source.trashedAt?.toISOString() ?? null,
    updatedAt: latestUpdatedAt(source).toISOString(),
    version: source.version
  };
}

function baseAccessWhere(userId: string, groupIds: readonly string[]): Prisma.KnowledgeBaseWhereInput {
  return {
    deletionRequestedAt: null,
    OR: [
      { ownerUserId: userId },
      {
        archivedAt: null,
        publications: {
          some: {
            OR: [
              { scope: "installation" },
              ...(groupIds.length > 0
                ? [{
                    group: { archivedAt: null },
                    groupId: { in: [...groupIds] },
                    scope: "group" as const
                  }]
                : [])
            ]
          }
        }
      }
    ],
    trashedAt: null
  };
}

async function requiredProfileRevisionIds(
  tx: Prisma.TransactionClient,
  sourceId: string,
  ownerUserId: string
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ profileRevisionId: string }>>`
    SELECT DISTINCT generation."profileRevisionId"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = membership."knowledgeBaseId"
     AND base."ownerUserId" = membership."ownerUserId"
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND (
       generation."id" = base."activeIndexGenerationId"
         AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
       OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
         AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
         AND generation."sourceBaseVersion" = base."version"
         AND generation."targetContentRevision" = base."contentRevision"
         AND generation."targetSourceRevision" = base."sourceRevision"
         AND EXISTS (
           SELECT 1
           FROM "KnowledgeIndexProfile" AS active_profile
           WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
         )
     )
    WHERE membership."sourceId" = ${sourceId}
      AND membership."ownerUserId" = ${ownerUserId}
      AND membership."removedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
      AND generation."profileRevisionId" IS NOT NULL
    ORDER BY generation."profileRevisionId"
  `;
  return rows.map(({ profileRevisionId }) => profileRevisionId);
}

async function ensureQueuedArtifacts(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    now: Date;
    ownerUserId: string;
    profileRevisionIds: readonly string[];
    sourceId: string;
    sourceVersionIds: readonly string[];
  }>
): Promise<number> {
  const targets = input.sourceVersionIds.flatMap((sourceVersionId) =>
    input.profileRevisionIds.map((profileRevisionId) => ({
      profileRevisionId,
      sourceVersionId
    })));
  if (targets.length === 0) return 0;
  const existing = await tx.knowledgeSourceIndexArtifact.findMany({
    select: { profileRevisionId: true, sourceVersionId: true },
    where: {
      OR: targets.map((target) => ({
        profileRevisionId: target.profileRevisionId,
        sourceVersionId: target.sourceVersionId
      }))
    }
  });
  const existingKeys = new Set(existing.map((artifact) =>
    `${artifact.sourceVersionId}\u0000${artifact.profileRevisionId}`));
  const missing = targets.filter((target) =>
    !existingKeys.has(`${target.sourceVersionId}\u0000${target.profileRevisionId}`));
  if (missing.length === 0) return 0;
  const created = await tx.knowledgeSourceIndexArtifact.createMany({
    data: missing.map((target) => {
      const artifactId = randomUUID();
      return {
        id: artifactId,
        nextAttemptAt: input.now,
        normalizedTextStorageKey: knowledgeSourceNormalizedTextStorageKey({
          artifactId,
          ownerUserId: input.ownerUserId,
          sourceId: input.sourceId,
          sourceVersionId: target.sourceVersionId
        }),
        processingStage: "queued" as const,
        profileRevisionId: target.profileRevisionId,
        sourceVersionId: target.sourceVersionId,
        state: "pending" as const
      };
    }),
    skipDuplicates: true
  });
  return created.count;
}

export function createPrismaKnowledgeSourceLibraryRepository(client: PrismaClient = prisma) {
  async function accessibleBases(userId: string): Promise<AccessibleBase[]> {
    const memberships = await client.userGroup.findMany({
      select: { groupId: true },
      where: { group: { archivedAt: null }, userId }
    });
    return client.knowledgeBase.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { archivedAt: true, id: true, name: true, ownerUserId: true },
      where: baseAccessWhere(userId, memberships.map(({ groupId }) => groupId))
    });
  }

  async function getDetail(userId: string, sourceId: string): Promise<KnowledgeSourceDetail | null> {
    const bases = await accessibleBases(userId);
    const accessibleBaseIds = bases.map(({ id }) => id);
    const row = await client.knowledgeSource.findFirst({
      select: sourceSelect(accessibleBaseIds, true),
      where: {
        id: sourceId,
        OR: [
          { ownerUserId: userId },
          {
            baseMemberships: {
              some: { knowledgeBaseId: { in: accessibleBaseIds }, removedAt: null }
            },
            deletionRequestedAt: null,
            trashedAt: null
          }
        ]
      }
    }) as SourceDetailRow | null;
    if (!row) return null;
    const summary = safeSummary(row, userId);
    const memberships = safeMemberships(row);
    const membershipIds = new Set(memberships.map(({ id }) => id));
    const owned = row.ownerUserId === userId;
    const eligibleBases = owned
      ? bases.filter((base) =>
          base.ownerUserId === userId && base.archivedAt === null && !membershipIds.has(base.id))
        .map((base) => ({ archived: false, id: base.id, name: base.name }))
      : [];
    const versions = (owned
      ? row.versions
      : row.versions.filter((version) => version.id === row.currentVersionId)
    ).map((version) => safeVersion(row.id, version, row));
    return { ...summary, eligibleBases, memberships, versions };
  }

  return {
    async addMemberships(
      userId: string,
      sourceId: string,
      baseIds: readonly string[]
    ): Promise<KnowledgeSourceMembershipResult> {
      if (baseIds.length === 0 || new Set(baseIds).size !== baseIds.length) {
        return { kind: "not_found" };
      }
      return serializable(() => client.$transaction(async (tx) => {
        const sources = await tx.$queryRaw<Array<{
          currentVersionId: string | null;
          deletionRequestedAt: Date | null;
          ownerUserId: string;
          pendingVersionId: string | null;
          trashedAt: Date | null;
        }>>`
          SELECT
            "ownerUserId", "currentVersionId", "pendingVersionId",
            "trashedAt", "deletionRequestedAt"
          FROM "KnowledgeSource"
          WHERE "id" = ${sourceId}
          FOR UPDATE
        `;
        const source = sources[0];
        if (
          source?.ownerUserId !== userId ||
          source.trashedAt ||
          source.deletionRequestedAt
        ) {
          return { kind: "not_found" } as const;
        }
        const bases = await tx.$queryRaw<Array<{
          id: string;
          profileRevisionId: string | null;
        }>>(Prisma.sql`
          SELECT base."id", generation."profileRevisionId"
          FROM "KnowledgeBase" AS base
          LEFT JOIN "KnowledgeIndexGeneration" AS generation
            ON generation."knowledgeBaseId" = base."id"
           AND generation."id" = base."activeIndexGenerationId"
          WHERE base."id" IN (${Prisma.join([...baseIds])})
            AND base."ownerUserId" = ${userId}
            AND base."archivedAt" IS NULL
            AND base."trashedAt" IS NULL
            AND base."deletionRequestedAt" IS NULL
          ORDER BY base."id"
          FOR UPDATE OF base
        `);
        if (
          bases.length !== baseIds.length ||
          bases.some(({ profileRevisionId }) => !profileRevisionId)
        ) return { kind: "not_found" } as const;
        for (const base of bases) {
          const membership = await tx.knowledgeBaseSource.findUnique({
            select: { removedAt: true },
            where: {
              knowledgeBaseId_sourceId: { knowledgeBaseId: base.id, sourceId }
            }
          });
          if (!membership) {
            await tx.knowledgeBaseSource.create({
              data: { knowledgeBaseId: base.id, ownerUserId: userId, sourceId }
            });
          } else if (membership.removedAt) {
            await tx.knowledgeBaseSource.update({
              data: { removedAt: null },
              where: {
                knowledgeBaseId_sourceId: { knowledgeBaseId: base.id, sourceId }
              }
            });
          } else {
            continue;
          }
          await tx.knowledgeBase.update({
            data: { version: { increment: 1 } },
            where: { id: base.id }
          });
        }
        await ensureQueuedArtifacts(tx, {
          now: new Date(),
          ownerUserId: userId,
          profileRevisionIds: bases.map(({ profileRevisionId }) => profileRevisionId!),
          sourceId,
          sourceVersionIds: [...new Set([
            source.currentVersionId,
            source.pendingVersionId
          ].filter((value): value is string => Boolean(value)))]
        });
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async createVersion(
      input: KnowledgeSourceVersionCreateInput
    ): Promise<KnowledgeSourceVersionCreateResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          deletionRequestedAt: Date | null;
          ownerUserId: string;
          pendingVersionId: string | null;
          trashedAt: Date | null;
        }>>`
          SELECT
            "ownerUserId", "pendingVersionId", "trashedAt", "deletionRequestedAt"
          FROM "KnowledgeSource"
          WHERE "id" = ${input.sourceId}
          FOR UPDATE
        `;
        const source = rows[0];
        if (
          source?.ownerUserId !== input.userId ||
          source.trashedAt ||
          source.deletionRequestedAt
        ) return { kind: "not_found" } as const;

        if (source.pendingVersionId) {
          const states = await tx.knowledgeSourceIndexArtifact.findMany({
            select: { state: true },
            where: { sourceVersionId: source.pendingVersionId }
          });
          if (states.some(({ state }) => state !== "failed")) {
            return { kind: "active_ingest" } as const;
          }
        }

        const profileRevisionIds = await requiredProfileRevisionIds(
          tx,
          input.sourceId,
          input.userId
        );
        if (profileRevisionIds.length === 0) return { kind: "profile_unavailable" } as const;
        const latest = await tx.knowledgeSourceVersion.aggregate({
          _max: { versionNumber: true },
          where: { sourceId: input.sourceId }
        });
        await tx.knowledgeSourceVersion.create({
          data: {
            byteSize: input.byteSize,
            checksum: input.checksum,
            createdAt: input.now,
            fileName: input.fileName,
            id: input.sourceVersionId,
            mimeType: input.mimeType,
            originalStorageKey: input.originalStorageKey,
            ownerUserId: input.userId,
            sourceId: input.sourceId,
            versionNumber: (latest._max.versionNumber ?? 0) + 1
          }
        });
        await ensureQueuedArtifacts(tx, {
          now: input.now,
          ownerUserId: input.userId,
          profileRevisionIds,
          sourceId: input.sourceId,
          sourceVersionIds: [input.sourceVersionId]
        });
        await tx.knowledgeSource.update({
          data: {
            pendingVersionId: input.sourceVersionId,
            version: { increment: 1 }
          },
          where: { id: input.sourceId }
        });
        return { kind: "ok", sourceVersionId: input.sourceVersionId } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async findOwnedDuplicate(
      userId: string,
      input: KnowledgeSourceDuplicateInput
    ): Promise<KnowledgeSourceSummary | null> {
      const bases = await accessibleBases(userId);
      const row = await client.knowledgeSource.findFirst({
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: sourceSelect(bases.map(({ id }) => id), false),
        where: {
          currentVersion: {
            is: {
              artifacts: { some: { state: "ready" } },
              byteSize: input.byteSize,
              checksum: input.checksum
            }
          },
          deletionRequestedAt: null,
          ownerUserId: userId,
          trashedAt: null
        }
      }) as SourceRow | null;
      return row ? safeSummary(row, userId) : null;
    },

    getDetail,

    async listForUser(input: Readonly<{
      baseId?: string;
      filter: KnowledgeSourceFilter;
      page: number;
      pageSize: number;
      query: string;
      userId: string;
    }>): Promise<KnowledgeSourceListResponse> {
      const bases = await accessibleBases(input.userId);
      const accessibleBaseIds = bases.map(({ id }) => id);
      if (input.baseId && !accessibleBaseIds.includes(input.baseId)) {
        return {
          pagination: {
            page: 1,
            pageSize: input.pageSize,
            query: input.query,
            totalItems: 0,
            totalPages: 0
          },
          sources: []
        };
      }
      const visibility: Prisma.KnowledgeSourceWhereInput = input.filter === "trash"
        ? { ownerUserId: input.userId, trashedAt: { not: null } }
        : {
            deletionRequestedAt: null,
            OR: [
              { ownerUserId: input.userId },
              {
                baseMemberships: {
                  some: { knowledgeBaseId: { in: accessibleBaseIds }, removedAt: null }
                }
              }
            ],
            trashedAt: null
          };
      const ownership: Prisma.KnowledgeSourceWhereInput = input.filter === "yours"
        ? { ownerUserId: input.userId }
        : input.filter === "shared"
          ? { ownerUserId: { not: input.userId } }
          : {};
      const search: Prisma.KnowledgeSourceWhereInput = input.query
        ? {
            OR: [
              { description: { contains: input.query, mode: "insensitive" } },
              { name: { contains: input.query, mode: "insensitive" } },
              { tags: { has: input.query } },
              { currentVersion: { is: { fileName: { contains: input.query, mode: "insensitive" } } } }
            ]
          }
        : {};
      const baseScope: Prisma.KnowledgeSourceWhereInput = input.baseId
        ? {
            baseMemberships: {
              some: { knowledgeBaseId: input.baseId, removedAt: null }
            }
          }
        : {};
      const where: Prisma.KnowledgeSourceWhereInput = {
        AND: [visibility, ownership, search, baseScope]
      };
      const { page, rows, totalItems, totalPages } = await client.$transaction(async (tx) => {
        const totalItems = await tx.knowledgeSource.count({ where });
        const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize);
        const page = Math.min(input.page, Math.max(1, totalPages));
        const rows = await tx.knowledgeSource.findMany({
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          select: sourceSelect(accessibleBaseIds, false),
          skip: (page - 1) * input.pageSize,
          take: input.pageSize,
          where
        });
        return { page, rows, totalItems, totalPages };
      });
      return {
        pagination: {
          page,
          pageSize: input.pageSize,
          query: input.query,
          totalItems,
          totalPages
        },
        sources: (rows as SourceRow[]).map((row) => safeSummary(row, input.userId))
      };
    },

    async moveMembership(
      userId: string,
      sourceId: string,
      fromBaseId: string,
      toBaseId: string
    ): Promise<KnowledgeSourceMembershipResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const sources = await tx.$queryRaw<Array<{
          currentVersionId: string | null;
          deletionRequestedAt: Date | null;
          ownerUserId: string;
          pendingVersionId: string | null;
          trashedAt: Date | null;
        }>>`
          SELECT
            "ownerUserId", "currentVersionId", "pendingVersionId",
            "trashedAt", "deletionRequestedAt"
          FROM "KnowledgeSource"
          WHERE "id" = ${sourceId}
          FOR UPDATE
        `;
        const source = sources[0];
        if (
          source?.ownerUserId !== userId ||
          source.trashedAt ||
          source.deletionRequestedAt
        ) {
          return { kind: "not_found" } as const;
        }
        const bases = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          deletionRequestedAt: Date | null;
          id: string;
          profileRevisionId: string | null;
          trashedAt: Date | null;
        }>>(Prisma.sql`
          SELECT
            base."id", base."archivedAt", base."trashedAt",
            base."deletionRequestedAt", generation."profileRevisionId"
          FROM "KnowledgeBase" AS base
          LEFT JOIN "KnowledgeIndexGeneration" AS generation
            ON generation."knowledgeBaseId" = base."id"
           AND generation."id" = base."activeIndexGenerationId"
          WHERE base."id" IN (${Prisma.join([fromBaseId, toBaseId])})
            AND base."ownerUserId" = ${userId}
          ORDER BY base."id"
          FOR UPDATE OF base
        `);
        const fromBase = bases.find(({ id }) => id === fromBaseId);
        const toBase = bases.find(({ id }) => id === toBaseId);
        if (
          !fromBase || !toBase || toBase.archivedAt ||
          fromBase.trashedAt || toBase.trashedAt ||
          fromBase.deletionRequestedAt || toBase.deletionRequestedAt ||
          !toBase.profileRevisionId
        ) {
          return { kind: "not_found" } as const;
        }
        const [fromMembership, toMembership] = await Promise.all([
          tx.knowledgeBaseSource.findUnique({
            select: { removedAt: true },
            where: { knowledgeBaseId_sourceId: { knowledgeBaseId: fromBaseId, sourceId } }
          }),
          tx.knowledgeBaseSource.findUnique({
            select: { removedAt: true },
            where: { knowledgeBaseId_sourceId: { knowledgeBaseId: toBaseId, sourceId } }
          })
        ]);
        if (!fromMembership) return { kind: "not_found" } as const;
        const alreadyMoved = fromMembership.removedAt !== null && toMembership?.removedAt === null;
        if (alreadyMoved) {
          await ensureQueuedArtifacts(tx, {
            now: new Date(),
            ownerUserId: userId,
            profileRevisionIds: [toBase.profileRevisionId],
            sourceId,
            sourceVersionIds: [...new Set([
              source.currentVersionId,
              source.pendingVersionId
            ].filter((value): value is string => Boolean(value)))]
          });
          return { kind: "ok" } as const;
        }
        if (fromMembership.removedAt) return { kind: "not_found" } as const;
        if (!toMembership) {
          await tx.knowledgeBaseSource.create({
            data: { knowledgeBaseId: toBaseId, ownerUserId: userId, sourceId }
          });
          await tx.knowledgeBase.update({
            data: { version: { increment: 1 } },
            where: { id: toBaseId }
          });
        } else if (toMembership.removedAt) {
          await tx.knowledgeBaseSource.update({
            data: { removedAt: null },
            where: { knowledgeBaseId_sourceId: { knowledgeBaseId: toBaseId, sourceId } }
          });
          await tx.knowledgeBase.update({
            data: { version: { increment: 1 } },
            where: { id: toBaseId }
          });
        }
        await tx.knowledgeBaseSource.update({
          data: { removedAt: new Date() },
          where: { knowledgeBaseId_sourceId: { knowledgeBaseId: fromBaseId, sourceId } }
        });
        await tx.knowledgeBase.update({
          data: { version: { increment: 1 } },
          where: { id: fromBaseId }
        });
        await ensureQueuedArtifacts(tx, {
          now: new Date(),
          ownerUserId: userId,
          profileRevisionIds: [toBase.profileRevisionId],
          sourceId,
          sourceVersionIds: [...new Set([
            source.currentVersionId,
            source.pendingVersionId
          ].filter((value): value is string => Boolean(value)))]
        });
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async removeMembership(
      userId: string,
      sourceId: string,
      baseId: string
    ): Promise<KnowledgeSourceMembershipResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const sources = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "KnowledgeSource"
          WHERE "id" = ${sourceId}
            AND "ownerUserId" = ${userId}
            AND "trashedAt" IS NULL
            AND "deletionRequestedAt" IS NULL
          FOR UPDATE
        `;
        const bases = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "KnowledgeBase"
          WHERE "id" = ${baseId}
            AND "ownerUserId" = ${userId}
            AND "trashedAt" IS NULL
            AND "deletionRequestedAt" IS NULL
          FOR UPDATE
        `;
        if (!sources[0] || !bases[0]) return { kind: "not_found" } as const;
        const membership = await tx.knowledgeBaseSource.findUnique({
          select: { removedAt: true },
          where: { knowledgeBaseId_sourceId: { knowledgeBaseId: baseId, sourceId } }
        });
        if (!membership) return { kind: "not_found" } as const;
        if (membership.removedAt) return { kind: "ok" } as const;
        await tx.knowledgeBaseSource.update({
          data: { removedAt: new Date() },
          where: { knowledgeBaseId_sourceId: { knowledgeBaseId: baseId, sourceId } }
        });
        await tx.knowledgeBase.update({
          data: { version: { increment: 1 } },
          where: { id: baseId }
        });
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async reprocess(
      userId: string,
      sourceId: string,
      now: Date
    ): Promise<KnowledgeSourceReprocessResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          currentVersionId: string | null;
          deletionRequestedAt: Date | null;
          ownerUserId: string;
          pendingVersionId: string | null;
          trashedAt: Date | null;
        }>>`
          SELECT
            "ownerUserId", "currentVersionId", "pendingVersionId",
            "trashedAt", "deletionRequestedAt"
          FROM "KnowledgeSource"
          WHERE "id" = ${sourceId}
          FOR UPDATE
        `;
        const source = rows[0];
        if (
          source?.ownerUserId !== userId ||
          source.trashedAt ||
          source.deletionRequestedAt
        ) return { kind: "not_found" } as const;
        const sourceVersionId = source.pendingVersionId ?? source.currentVersionId;
        if (!sourceVersionId) return { kind: "not_retryable" } as const;
        const version = await tx.knowledgeSourceVersion.findUnique({
          select: { originalStorageKey: true },
          where: { id: sourceVersionId }
        });
        if (!version?.originalStorageKey) return { kind: "not_retryable" } as const;
        const profileRevisionIds = await requiredProfileRevisionIds(tx, sourceId, userId);
        if (profileRevisionIds.length === 0) return { kind: "profile_unavailable" } as const;
        const created = await ensureQueuedArtifacts(tx, {
          now,
          ownerUserId: userId,
          profileRevisionIds,
          sourceId,
          sourceVersionIds: [sourceVersionId]
        });
        const artifacts = await tx.knowledgeSourceIndexArtifact.findMany({
          select: {
            id: true,
            normalizedTextStorageKey: true,
            state: true
          },
          where: {
            profileRevisionId: { in: profileRevisionIds },
            sourceVersionId
          }
        });
        const failed = artifacts.filter(({ state }) => state === "failed");
        for (const artifact of failed) {
          await tx.knowledgeSourceIndexArtifact.update({
            data: {
              attemptCount: 0,
              claimToken: null,
              claimedAt: null,
              errorCode: null,
              nextAttemptAt: now,
              normalizedTextStorageKey: artifact.normalizedTextStorageKey ??
                knowledgeSourceNormalizedTextStorageKey({
                  artifactId: artifact.id,
                  ownerUserId: userId,
                  sourceId,
                  sourceVersionId
                }),
              processingStage: "queued",
              processingStartedAt: null,
              readyAt: null,
              state: "pending",
              updatedAt: now
            },
            where: { id: artifact.id }
          });
        }
        if (created > 0 || failed.length > 0) return { kind: "ok" } as const;
        if (artifacts.some(({ state }) => state === "pending" || state === "processing")) {
          return { kind: "active_ingest" } as const;
        }
        return { kind: "not_retryable" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async update(
      userId: string,
      sourceId: string,
      input: KnowledgeSourceUpdateInput
    ): Promise<KnowledgeSourceWriteResult> {
      const updated = await client.knowledgeSource.updateMany({
        data: {
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          version: { increment: 1 }
        },
        where: {
          deletionRequestedAt: null,
          id: sourceId,
          ownerUserId: userId,
          trashedAt: null,
          version: input.expectedVersion
        }
      });
      if (updated.count === 1) return { kind: "ok" };
      const exists = await client.knowledgeSource.count({
        where: { id: sourceId, ownerUserId: userId }
      });
      return exists ? { kind: "version_conflict" } : { kind: "not_found" };
    }
  };
}

export type PrismaKnowledgeSourceLibraryRepository = ReturnType<
  typeof createPrismaKnowledgeSourceLibraryRepository
>;

import { Prisma, type PrismaClient } from "@prisma/client";
import { SKILL_BUNDLE_MAX_BYTES, type SkillDraft, type SkillFileSummary, type SkillValidationError, type SkillSharingStatus } from "../../contracts/skills";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { createSkillBundle, renderSkillMarkdown, skillBundleDigest } from "./bundle";
import type {
  SkillRunMaterialization,
  SkillRunResolver
} from "./runMaterialization";
import { revokeOwnedProjectResourcePublication } from "../projects/prismaRepository";
import { ensureSkillShareRequest, skillRevisionSummary, skillShareRequestSummary } from "./shareRequests";
import { createSkillCatalogRepository } from "./catalogRepository";

export type SkillRevisionRow = {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  revisionNumber: number;
  skillId: string;
  frontmatterJson?: Prisma.JsonValue | null;
  bundleDigest?: string;
  bundleByteSize?: number;
  fileCount?: number;
  hasExecutables?: boolean;
  files?: SkillFileSummary[];
};

export type SkillAudienceEntry =
  | { id: string; kind: "installation" }
  | { id: string; kind: "project" }
  | { id: string; kind: "workspace"; name: string; workspaceId: string };

export type SkillListEntry = {
  archived: boolean;
  enabled?: boolean;
  description: string;
  id: string;
  installationScope: boolean;
  instructionCharacterCount: number;
  instructionApproxTokens?: number;
  fileCount?: number;
  hasExecutables?: boolean;
  memberWorkspaceNames: string[];
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  updatedAt: Date;
  version: number;
};

export type SkillDetailEntry = SkillListEntry & {
  assistantUsageCount: number;
  audiences: SkillAudienceEntry[];
  revision: SkillRevisionRow;
  sharing?: SkillSharingStatus;
  workspaceUsageCount: number;
};

export type SkillListPage = {
  entries: SkillListEntry[];
  nextCursor: { id: string; updatedAt: Date } | null;
};

export type SkillWriteResult =
  | { kind: "ok"; skillId: string }
  | { kind: "invalid"; issue: SkillValidationError }
  | { kind: "archived" | "not_found" | "version_conflict" };

export async function lockSkillRevisionWrites(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Import resolves by owner/name before it knows a skill ID. Editors acquire
  // the same owner lock before locking a definition or allocating a revision.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-import:${userId}`}, 0))::text`;
}

export async function retrySkillRevisionWrite<T>(write: () => Promise<T>, onConflict: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      const target = error.meta?.target;
      const revisionCollision = error.code === "P2002" &&
        (target === "SkillRevision_skillId_revisionNumber_key" ||
          (Array.isArray(target) && target.length === 2 && target.includes("skillId") && target.includes("revisionNumber")));
      const retryable = revisionCollision || error.code === "P2034" ||
        (error.code === "P2010" && (error.meta?.code === "40001" || error.meta?.code === "40P01"));
      if (!retryable) throw error;
      // Serializable readers can retain a snapshot from before the advisory
      // lock was granted. Restart the transaction, including its version guard.
      if (attempt >= 2) return onConflict();
    }
  }
}

export type SkillPublicationResult =
  | { id: string; kind: "ok" }
  | { kind: "forbidden" | "invalid" | "not_found" };

export type SkillRevokePublicationResult =
  | "dependency_conflict"
  | "not_found"
  | "ok";

function revisionRow(revision: {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  revisionNumber: number;
  skillId: string;
}): SkillRevisionRow {
  return { ...revision };
}

function accessiblePublicationWhere(userId: string): Prisma.SkillPublicationWhereInput {
  return {
    OR: [
      { scope: "installation" },
      {
        group: {
          archivedAt: null,
          users: { some: { userId } }
        },
        scope: "group"
      }
    ]
  };
}

export function skillAccessWhere(userId: string): Prisma.SkillDefinitionWhereInput {
  return {
    OR: [
      { ownerUserId: userId },
      {
        archivedAt: null,
        sharedRevisionId: { not: null },
        publications: { some: accessiblePublicationWhere(userId) }
      }
    ]
  };
}

function searchWhere(userId: string, query: string): Prisma.SkillDefinitionWhereInput {
  const text = { contains: query, mode: Prisma.QueryMode.insensitive };
  return {
    OR: [
      { ownerUserId: userId, OR: [{ currentRevision: { description: text } }, { currentRevision: { name: text } }] },
      { ownerUserId: { not: userId }, OR: [{ sharedRevision: { description: text } }, { sharedRevision: { name: text } }] },
      { owner: { displayName: text } },
      {
        ownerUserId: userId,
        publications: {
          some: {
            group: { name: text },
            scope: "group"
          }
        }
      },
      {
        publications: {
          some: {
            group: {
              archivedAt: null,
              name: text,
              users: { some: { userId } }
            },
            scope: "group"
          }
        }
      }
    ]
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function removalBreaksAssistantPublication(
  tx: Prisma.TransactionClient,
  skillId: string,
  publicationId: string
): Promise<boolean> {
  const remaining = await tx.skillPublication.findMany({
    select: { groupId: true, scope: true },
    where: { id: { not: publicationId }, skillId }
  });
  const assistantPublications = await tx.assistantPublication.findMany({
    select: { groupId: true, scope: true },
    where: {
      assistant: {
        skillLinks: { some: { skillId } }
      }
    }
  });
  const installationRemains = remaining.some((publication) =>
    publication.scope === "installation");
  return assistantPublications.some((publication) => {
    if (publication.scope === "installation") return !installationRemains;
    return !installationRemains && !remaining.some((candidate) =>
      candidate.scope === "group" && candidate.groupId === publication.groupId);
  });
}

export function createPrismaSkillRepository(client: PrismaClient) {
  async function listForUser(
    userId: string,
    input: Readonly<{
      cursor?: { id: string; updatedAt: Date };
      limit: number;
      query?: string;
    }>
  ): Promise<SkillListPage> {
    const definitions = await client.skillDefinition.findMany({
      include: {
        currentRevision: true,
        sharedRevision: true,
        preferences: { where: { userId }, select: { enabled: true } },
        owner: { select: { displayName: true } },
        projectBindings: { select: { id: true } },
        publications: {
          include: { group: { select: { name: true } } },
          where: accessiblePublicationWhere(userId)
        }
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit + 1,
      where: {
        AND: [
          { currentRevisionId: { not: null }, deletedAt: null },
          skillAccessWhere(userId),
          ...(input.cursor ? [{
            OR: [
              { updatedAt: { lt: input.cursor.updatedAt } },
              { id: { gt: input.cursor.id }, updatedAt: input.cursor.updatedAt }
            ]
          }] : []),
          ...(input.query ? [searchWhere(userId, input.query)] : [])
        ]
      }
    });
    const hasNextPage = definitions.length > input.limit;
    const page = definitions.slice(0, input.limit);
    const entries = page.flatMap((definition): SkillListEntry[] => {
      const revision = definition.ownerUserId === userId ? definition.currentRevision : definition.sharedRevision;
      if (!revision) return [];
      const owned = definition.ownerUserId === userId;
      return [{
        archived: definition.archivedAt !== null,
        enabled: definition.preferences[0]?.enabled ?? owned,
        description: revision.description,
        id: definition.id,
        installationScope: definition.publications.some((publication) =>
          publication.scope === "installation"),
        instructionCharacterCount: revision.instructions.length,
        instructionApproxTokens: estimateApproxTokens(revision.instructions),
        fileCount: revision.fileCount,
        hasExecutables: revision.hasExecutables,
        memberWorkspaceNames: uniqueSorted(definition.publications.flatMap((publication) =>
          publication.scope === "group" && publication.group
            ? [publication.group.name]
            : [])),
        name: revision.name,
        owned,
        ownerDisplayName: definition.owner.displayName,
        updatedAt: definition.updatedAt,
        version: definition.version
      }];
    });
    const last = hasNextPage ? page.at(-1) : undefined;
    return {
      entries,
      nextCursor: last ? { id: last.id, updatedAt: last.updatedAt } : null
    };
  }

  async function getForUser(userId: string, skillId: string): Promise<SkillDetailEntry | null> {
    const definition = await client.skillDefinition.findFirst({
      include: {
        currentRevision: { include: { files: { orderBy: { path: "asc" } } } },
        sharedRevision: { include: { files: { orderBy: { path: "asc" } } } },
        preferences: { where: { userId }, select: { enabled: true } },
        shareRequests: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, include: { revision: { select: { revisionNumber: true } } } },
        owner: { select: { displayName: true } },
        projectBindings: { select: { id: true } },
        publications: {
          include: {
            group: {
              select: {
                archivedAt: true,
                id: true,
                name: true,
                users: { select: { userId: true }, where: { userId } }
              }
            }
          }
        }
      },
      where: { deletedAt: null, id: skillId }
    });
    if (!definition?.currentRevision) return null;
    const owned = definition.ownerUserId === userId;
    const accessiblePublications = definition.publications.filter((publication) =>
      publication.scope === "installation" || (
        publication.scope === "group" &&
        publication.group?.archivedAt === null &&
        publication.group.users.length > 0
      ));
    if (!owned && (!definition.sharedRevision || definition.archivedAt !== null || accessiblePublications.length === 0)) {
      return null;
    }
    const visiblePublications = owned ? definition.publications : accessiblePublications;
    const audiences = visiblePublications.flatMap((publication): SkillAudienceEntry[] => {
      if (publication.scope === "installation") {
        return [{ id: publication.id, kind: "installation" }];
      }
      return publication.group ? [{
        id: publication.id,
        kind: "workspace",
        name: publication.group.name,
        workspaceId: publication.group.id
      }] : [];
    });
    if (owned) {
      audiences.push(...definition.projectBindings.map((binding) => ({
        id: `project:${binding.id}`,
        kind: "project" as const
      })));
    }
    audiences.sort((left, right) => {
      const leftName = left.kind === "workspace" ? left.name : left.kind;
      const rightName = right.kind === "workspace" ? right.name : right.kind;
      return leftName.localeCompare(rightName) || left.id.localeCompare(right.id);
    });
    const revision = owned ? definition.currentRevision : definition.sharedRevision!;
    const assistantUsageCount = await client.assistantDefinition.count({
      where: { skillLinks: { some: { skillId } } }
    });
    return {
      archived: definition.archivedAt !== null,
      enabled: definition.preferences[0]?.enabled ?? owned,
      assistantUsageCount,
      audiences,
      description: revision.description,
      id: definition.id,
      installationScope: accessiblePublications.some((publication) =>
        publication.scope === "installation"),
      instructionCharacterCount: revision.instructions.length,
      instructionApproxTokens: estimateApproxTokens(revision.instructions),
      fileCount: revision.fileCount,
      hasExecutables: revision.hasExecutables,
      memberWorkspaceNames: uniqueSorted(accessiblePublications.flatMap((publication) =>
        publication.scope === "group" && publication.group
          ? [publication.group.name]
          : [])),
      name: revision.name,
      owned,
      ownerDisplayName: definition.owner.displayName,
      revision: revisionRow(revision),
      ...(owned ? { sharing: {
        currentRevision: skillRevisionSummary(definition.currentRevision),
        sharedRevision: definition.sharedRevision ? skillRevisionSummary(definition.sharedRevision) : null,
        request: definition.shareRequests[0] ? skillShareRequestSummary(definition.shareRequests[0]) : null,
        canRequest: !definition.archivedAt && definition.currentRevisionId !== definition.sharedRevisionId,
        canWithdraw: !definition.archivedAt && definition.shareRequests[0]?.state === "pending"
      } } : {}),
      updatedAt: definition.updatedAt,
      version: definition.version,
      workspaceUsageCount: audiences.filter((audience) => audience.kind === "workspace").length
    };
  }

  const repository = {
    listEnabledForRun: createSkillCatalogRepository(client).listEnabledForRun,
    loadedBeforeForMessages: createSkillCatalogRepository(client).loadedBeforeForMessages,
    async create(userId: string, draft: SkillDraft): Promise<string> {
      const bundle = createSkillBundle(draft);
      return client.$transaction(async (tx) => {
        const definition = await tx.skillDefinition.create({
          data: { ownerUserId: userId }
        });
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
            schemaVersion: 2,
            bundleDigest: bundle.bundleDigest,
            bundleByteSize: bundle.bundleByteSize,
            revisionNumber: 1,
            skillId: definition.id
          }
        });
        await tx.skillDefinition.update({
          data: { currentRevisionId: revision.id },
          where: { id: definition.id }
        });
        return definition.id;
      });
    },

    async delete(userId: string, skillId: string): Promise<"not_found" | "ok"> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await client.$transaction(async (tx) => {
            const [skill] = await tx.$queryRaw<Array<{
              deletedAt: Date | null;
              id: string;
            }>>`
              SELECT "id", "deletedAt"
              FROM "SkillDefinition"
              WHERE "id" = ${skillId}
                AND "ownerUserId" = ${userId}
              FOR UPDATE
            `;
            if (!skill || skill.deletedAt) return "not_found" as const;
            await tx.skillPublication.deleteMany({ where: { skillId } });
            await tx.skillShareRequest.updateMany({ where: { skillId, state: "pending" }, data: { state: "withdrawn" } });
            await tx.assistantSkill.deleteMany({ where: { skillId } });
            await tx.skillDefinition.update({
              data: { deletedAt: new Date(), version: { increment: 1 } },
              where: { id: skillId }
            });
            return "ok" as const;
          });
        } catch (error) {
          const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2034" || (error.code === "P2010" &&
              (error.meta?.code === "40001" || error.meta?.code === "40P01")));
          if (!retryable || attempt >= 2) throw error;
        }
      }
    },

    getForUser,
    listForUser,

    async listPublishableWorkspaces(userId: string): Promise<Array<{ id: string; name: string }>> {
      const memberships = await client.userGroup.findMany({
        select: { group: { select: { id: true, name: true } } },
        where: { group: { archivedAt: null }, userId }
      });
      return memberships.map((membership) => membership.group)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async publish(input: {
      actorIsAdmin: boolean;
      groupId: string | null;
      scope: "group" | "installation";
      skillId: string;
      userId: string;
    }): Promise<SkillPublicationResult> {
      return client.$transaction(async (tx) => {
        const [skill] = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          currentRevisionId: string | null;
          deletedAt: Date | null;
        }>>`
          SELECT "archivedAt", "currentRevisionId", "deletedAt"
          FROM "SkillDefinition"
          WHERE "id" = ${input.skillId}
            AND "ownerUserId" = ${input.userId}
          FOR UPDATE
        `;
        if (!skill) return { kind: "not_found" as const };
        if (skill.archivedAt || skill.deletedAt || !skill.currentRevisionId) {
          return { kind: "invalid" as const };
        }
        if (input.scope === "installation" && !input.actorIsAdmin) {
          return { kind: "forbidden" as const };
        }
        // Read after the definition lock: an audience committed while this
        // transaction waited must not silently replace the frozen request.
        const { _count: audienceCount } = await tx.skillDefinition.findUniqueOrThrow({
          where: { id: input.skillId }, select: { _count: { select: { publications: true, projectBindings: true } } }
        });
        const firstAudience = audienceCount.publications + audienceCount.projectBindings === 0;
        if (input.scope === "group") {
          if (!input.groupId) return { kind: "invalid" as const };
          const memberships = await tx.$queryRaw<Array<{ groupId: string }>>`
            SELECT membership."groupId"
            FROM "UserGroup" AS membership
            INNER JOIN "Group" AS member_group
              ON member_group."id" = membership."groupId"
            WHERE membership."groupId" = ${input.groupId}
              AND membership."userId" = ${input.userId}
              AND member_group."archivedAt" IS NULL
            FOR SHARE OF membership, member_group
          `;
          if (!memberships[0]) return { kind: "forbidden" as const };
          const publication = await tx.skillPublication.upsert({
            create: {
              groupId: input.groupId,
              publishedByUserId: input.userId,
              scope: "group",
              skillId: input.skillId
            },
            update: { publishedByUserId: input.userId },
            where: {
              skillId_groupId: { groupId: input.groupId, skillId: input.skillId }
            }
          });
          await ensureSkillShareRequest(tx, { userId: input.userId, skillId: input.skillId, firstAudience });
          return { id: publication.id, kind: "ok" as const };
        }
        const existing = await tx.skillPublication.findFirst({
          select: { id: true },
          where: { scope: "installation", skillId: input.skillId }
        });
        const publication = existing
          ? await tx.skillPublication.update({
              data: { publishedByUserId: input.userId },
              where: { id: existing.id }
            })
          : await tx.skillPublication.create({
              data: {
                publishedByUserId: input.userId,
                scope: "installation",
                skillId: input.skillId
              }
            });
        await ensureSkillShareRequest(tx, { userId: input.userId, skillId: input.skillId, firstAudience });
        return { id: publication.id, kind: "ok" as const };
      });
    },

    async resolveForRun(userId: string, skillIds: readonly string[]) {
      const definitions = await client.skillDefinition.findMany({
        include: { currentRevision: { include: { files: { select: { path: true, byteSize: true, kind: true, executable: true } } } },
          sharedRevision: { include: { files: { select: { path: true, byteSize: true, kind: true, executable: true } } } } },
        where: {
          AND: [
            { archivedAt: null, currentRevisionId: { not: null }, deletedAt: null },
            { id: { in: [...skillIds] } },
            skillAccessWhere(userId)
          ]
        }
      });
      const available = new Map(definitions.flatMap((definition) => {
        const revision = definition.ownerUserId === userId ? definition.currentRevision : definition.sharedRevision;
        return revision ? [[definition.id, revision] as const] : [];
      }));
      const skills: SkillRunMaterialization[] = [];
      for (const skillId of skillIds) {
        const revision = available.get(skillId);
        if (!revision) {
          return {
            code: "skill_not_available" as const,
            ok: false as const,
            status: 404 as const
          };
        }
        skills.push({
          instructions: revision.instructions,
          description: revision.description || revision.name,
          fileCount: revision.fileCount,
          hasExecutables: revision.hasExecutables,
          files: revision.files.map((file) => ({ ...file, kind: file.kind === "text" ? "text" : "binary" })),
          name: revision.name,
          revisionId: revision.id,
          skillId
        });
      }
      return { ok: true as const, skills };
    },

    async resolveForProject(projectId: string, skillIds: readonly string[]) {
      const bindings = await client.projectSkillBinding.findMany({
        include: { skill: { include: { sharedRevision: { include: { files: { select: { path: true, byteSize: true, kind: true, executable: true } } } } } } },
        where: {
          projectId,
          skillId: { in: [...skillIds] },
          skill: { archivedAt: null, sharedRevisionId: { not: null }, deletedAt: null }
        }
      });
      const available = new Map(bindings.flatMap((binding) =>
        binding.skill.sharedRevision
          ? [[binding.skillId, binding.skill.sharedRevision] as const]
          : []));
      const skills: SkillRunMaterialization[] = [];
      for (const skillId of skillIds) {
        const revision = available.get(skillId);
        if (!revision) return { code: "skill_not_available" as const, ok: false as const, status: 404 as const };
        skills.push({
          instructions: revision.instructions,
          description: revision.description || revision.name,
          fileCount: revision.fileCount,
          hasExecutables: revision.hasExecutables,
          files: revision.files.map((file) => ({ ...file, kind: file.kind === "text" ? "text" : "binary" })),
          name: revision.name,
          revisionId: revision.id,
          skillId
        });
      }
      return { ok: true as const, skills };
    },

    async revise(
      userId: string,
      skillId: string,
      expectedVersion: number,
      draft: SkillDraft
    ): Promise<SkillWriteResult> {
      return retrySkillRevisionWrite<SkillWriteResult>(() => client.$transaction(async (tx) => {
        await lockSkillRevisionWrites(tx, userId);
        const [locked] = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          deletedAt: Date | null;
          ownerUserId: string;
          version: number;
        }>>`
          SELECT "archivedAt", "deletedAt", "ownerUserId", "version"
          FROM "SkillDefinition"
          WHERE "id" = ${skillId}
          FOR UPDATE
        `;
        if (!locked || locked.ownerUserId !== userId || locked.deletedAt) {
          return { kind: "not_found" as const };
        }
        if (locked.archivedAt) return { kind: "archived" as const };
        if (locked.version !== expectedVersion) return { kind: "version_conflict" as const };
        const latest = await tx.skillRevision.aggregate({
          _max: { revisionNumber: true },
          where: { skillId }
        });
        const previous = await tx.skillDefinition.findUniqueOrThrow({
          where: { id: skillId }, include: { currentRevision: { include: { files: true } } }
        });
        const files = previous.currentRevision?.files ?? [];
        const frontmatterJson = previous.currentRevision?.frontmatterJson ?? null;
        const bundleByteSize = Buffer.byteLength(renderSkillMarkdown({ ...draft, frontmatterJson })) +
          files.reduce((sum, file) => sum + file.byteSize, 0);
        if (bundleByteSize > SKILL_BUNDLE_MAX_BYTES) return { kind: "invalid" as const,
          issue: { code: "skill_limit_exceeded", field: "bundleBytes", actual: bundleByteSize, limit: SKILL_BUNDLE_MAX_BYTES } };
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
            schemaVersion: 2,
            bundleDigest: skillBundleDigest({ ...draft, files, frontmatterJson }),
            bundleByteSize,
            fileCount: files.length,
            hasExecutables: files.some((file) => file.executable),
            frontmatterJson: frontmatterJson === null ? Prisma.DbNull : frontmatterJson,
            revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
            skillId
          }
        });
        if (files.length) await tx.skillRevisionFile.createMany({ data: files.map((file) => ({
          ...file, revisionId: revision.id
        })) });
        await tx.skillDefinition.update({
          data: { currentRevisionId: revision.id, version: { increment: 1 } },
          where: { id: skillId }
        });
        return { kind: "ok" as const, skillId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), () => ({ kind: "version_conflict" }));
    },

    async revokePublication(input: {
      actorIsAdmin: boolean;
      publicationId: string;
      skillId: string;
      userId: string;
    }): Promise<SkillRevokePublicationResult> {
      if (input.publicationId.startsWith("project:")) {
        const bindingId = input.publicationId.slice("project:".length);
        if (!bindingId) return "not_found";
        return await revokeOwnedProjectResourcePublication(client, {
          bindingId,
          resourceId: input.skillId,
          type: "skill",
          userId: input.userId
        }) ? "ok" : "not_found";
      }
      return client.$transaction(async (tx) => {
        const [skill] = await tx.$queryRaw<Array<{
          deletedAt: Date | null;
          ownerUserId: string;
        }>>`
          SELECT "deletedAt", "ownerUserId"
          FROM "SkillDefinition"
          WHERE "id" = ${input.skillId}
          FOR UPDATE
        `;
        if (!skill || skill.deletedAt || (!input.actorIsAdmin && skill.ownerUserId !== input.userId)) {
          return "not_found" as const;
        }
        const publication = await tx.skillPublication.findFirst({
          select: { id: true },
          where: { id: input.publicationId, skillId: input.skillId }
        });
        if (!publication) return "not_found" as const;
        if (await removalBreaksAssistantPublication(
          tx,
          input.skillId,
          input.publicationId
        )) {
          return "dependency_conflict" as const;
        }
        const deleted = await tx.skillPublication.deleteMany({
          where: { id: publication.id, skillId: input.skillId }
        });
        return deleted.count === 1 ? "ok" as const : "not_found" as const;
      });
    },

    async setArchived(
      userId: string,
      skillId: string,
      expectedVersion: number,
      archived: boolean
    ): Promise<SkillWriteResult> {
      return client.$transaction(async (tx) => {
        const [skill] = await tx.$queryRaw<Array<{
          deletedAt: Date | null;
          version: number;
        }>>`
          SELECT "deletedAt", "version"
          FROM "SkillDefinition"
          WHERE "id" = ${skillId}
            AND "ownerUserId" = ${userId}
          FOR UPDATE
        `;
        if (!skill || skill.deletedAt) return { kind: "not_found" as const };
        if (skill.version !== expectedVersion) return { kind: "version_conflict" as const };
        if (archived) await tx.skillShareRequest.updateMany({ where: { skillId, state: "pending" }, data: { state: "withdrawn" } });
        await tx.skillDefinition.update({
          data: {
            archivedAt: archived ? new Date() : null,
            version: { increment: 1 }
          },
          where: { id: skillId }
        });
        return { kind: "ok" as const, skillId };
      });
    }
  };

  return repository satisfies SkillRunResolver & typeof repository;
}

// Keep the Project resolver additive for callers/test doubles that only
// implement the historical personal Skill repository contract.
export type PrismaSkillRepository = Omit<ReturnType<typeof createPrismaSkillRepository>, "resolveForProject"> & {
  resolveForProject?: SkillRunResolver["resolveForProject"];
};

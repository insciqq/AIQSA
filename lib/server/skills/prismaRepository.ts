import { Prisma, type PrismaClient } from "@prisma/client";
import type { SkillDraft } from "../../contracts/skills";
import type {
  SkillRunMaterialization,
  SkillRunResolver
} from "./runMaterialization";

export type SkillRevisionRow = {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  revisionNumber: number;
  skillId: string;
};

export type SkillAudienceEntry =
  | { id: string; kind: "installation" }
  | { id: string; kind: "workspace"; name: string; workspaceId: string };

export type SkillListEntry = {
  archived: boolean;
  description: string;
  id: string;
  installationScope: boolean;
  instructionCharacterCount: number;
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
  workspaceUsageCount: number;
};

export type SkillListPage = {
  entries: SkillListEntry[];
  nextCursor: { id: string; updatedAt: Date } | null;
};

export type SkillWriteResult =
  | { kind: "ok"; skillId: string }
  | { kind: "archived" | "not_found" | "version_conflict" };

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

function accessWhere(userId: string): Prisma.SkillDefinitionWhereInput {
  return {
    OR: [
      { ownerUserId: userId },
      {
        archivedAt: null,
        publications: { some: accessiblePublicationWhere(userId) }
      }
    ]
  };
}

function searchWhere(userId: string, query: string): Prisma.SkillDefinitionWhereInput {
  const text = { contains: query, mode: Prisma.QueryMode.insensitive };
  return {
    OR: [
      { currentRevision: { description: text } },
      { currentRevision: { name: text } },
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
      revision: {
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
        owner: { select: { displayName: true } },
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
          accessWhere(userId),
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
      const revision = definition.currentRevision;
      if (!revision) return [];
      const owned = definition.ownerUserId === userId;
      return [{
        archived: definition.archivedAt !== null,
        description: revision.description,
        id: definition.id,
        installationScope: definition.publications.some((publication) =>
          publication.scope === "installation"),
        instructionCharacterCount: revision.instructions.length,
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
        currentRevision: true,
        owner: { select: { displayName: true } },
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
    if (!owned && (definition.archivedAt !== null || accessiblePublications.length === 0)) {
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
    }).sort((left, right) => {
      const leftName = left.kind === "installation" ? "" : left.name;
      const rightName = right.kind === "installation" ? "" : right.name;
      return leftName.localeCompare(rightName) || left.id.localeCompare(right.id);
    });
    const revision = definition.currentRevision;
    const assistantUsageCount = await client.assistantDefinition.count({
      where: {
        OR: [
          { currentRevision: { skillLinks: { some: { skillId } } } },
          {
            publications: {
              some: { revision: { skillLinks: { some: { skillId } } } }
            }
          }
        ]
      }
    });
    return {
      archived: definition.archivedAt !== null,
      assistantUsageCount,
      audiences,
      description: revision.description,
      id: definition.id,
      installationScope: accessiblePublications.some((publication) =>
        publication.scope === "installation"),
      instructionCharacterCount: revision.instructions.length,
      memberWorkspaceNames: uniqueSorted(accessiblePublications.flatMap((publication) =>
        publication.scope === "group" && publication.group
          ? [publication.group.name]
          : [])),
      name: revision.name,
      owned,
      ownerDisplayName: definition.owner.displayName,
      revision: revisionRow(revision),
      updatedAt: definition.updatedAt,
      version: definition.version,
      workspaceUsageCount: audiences.filter((audience) => audience.kind === "workspace").length
    };
  }

  const repository = {
    async create(userId: string, draft: SkillDraft): Promise<string> {
      return client.$transaction(async (tx) => {
        const definition = await tx.skillDefinition.create({
          data: { ownerUserId: userId }
        });
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
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
      return client.$transaction(async (tx) => {
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
        await tx.assistantRevisionSkill.deleteMany({ where: { skillId } });
        await tx.skillDefinition.update({
          data: { deletedAt: new Date(), version: { increment: 1 } },
          where: { id: skillId }
        });
        return "ok" as const;
      });
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
        return { id: publication.id, kind: "ok" as const };
      });
    },

    async resolveForRun(userId: string, skillIds: readonly string[]) {
      const definitions = await client.skillDefinition.findMany({
        include: { currentRevision: true },
        where: {
          AND: [
            { archivedAt: null, currentRevisionId: { not: null }, deletedAt: null },
            { id: { in: [...skillIds] } },
            accessWhere(userId)
          ]
        }
      });
      const available = new Map(definitions.flatMap((definition) =>
        definition.currentRevision
          ? [[definition.id, definition.currentRevision] as const]
          : []));
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
      return client.$transaction(async (tx) => {
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
        const revision = await tx.skillRevision.create({
          data: {
            authorUserId: userId,
            ...draft,
            revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
            skillId
          }
        });
        await tx.skillDefinition.update({
          data: { currentRevisionId: revision.id, version: { increment: 1 } },
          where: { id: skillId }
        });
        return { kind: "ok" as const, skillId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async revokePublication(input: {
      actorIsAdmin: boolean;
      publicationId: string;
      skillId: string;
      userId: string;
    }): Promise<SkillRevokePublicationResult> {
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

export type PrismaSkillRepository = ReturnType<typeof createPrismaSkillRepository>;

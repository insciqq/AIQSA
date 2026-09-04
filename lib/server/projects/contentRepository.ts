import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeProjectDefaults,
  type ProjectChatSummaryWire,
  type ProjectFolderWire,
  type ProjectWorkspaceResponseWire
} from "../../contracts/projects";
import { defaultChatTitle } from "../chats/titlePolicy";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { resolveProjectAccess } from "./access";
import {
  loadProjectChatDefaultAuthority,
  projectChatDefaultsProjection
} from "./chatDefaults";
import { projectChatSelect, projectChatWire } from "./chatProjection";
import { notifyProjectEvent } from "./events";
import type { ProjectRepositoryResult } from "./prismaRepository";
import { workspaceAvailabilityService as defaultWorkspaceAvailabilityService } from "../workspace/defaultServices";
import type { WorkspaceAvailabilityService } from "../workspace/availability";

function folderWire(folder: { id: string; name: string; parentId: string | null; sortOrder: number }): ProjectFolderWire {
  return folder;
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
}

function audit(input: {
  actorDisplayName: string;
  actorUserId: string;
  eventType: string;
  metadata: Prisma.InputJsonObject;
  projectId: string;
}) {
  return {
    actorDisplayName: input.actorDisplayName,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    metadata: input.metadata,
    projectId: input.projectId
  };
}

function knownConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003", "P2004", "P2025", "P2034"].includes(error.code);
}

async function publishProjectResult<Value>(
  projectId: string,
  operation: Promise<ProjectRepositoryResult<Value | undefined>>
): Promise<ProjectRepositoryResult<Value>> {
  const result = await operation;
  if (result.kind === "ok") {
    if (result.value === undefined) return { kind: "not_found" };
    notifyProjectEvent(projectId);
    return { kind: "ok", value: result.value };
  }
  return result;
}

export function createPrismaProjectContentRepository(
  prisma: PrismaClient,
  options: Readonly<{ workspaceAvailability?: WorkspaceAvailabilityService }> = {}
) {
  const workspaceAvailability = options.workspaceAvailability ??
    defaultWorkspaceAvailabilityService;
  return {
    async listWorkspace(userId: string, projectId: string): Promise<ProjectWorkspaceResponseWire | null> {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      const access = await resolveProjectAccess(prisma, { projectId, userId });
      if (!access) return null;
      const [chats, folders, authority] = await prisma.$transaction(async (tx) => Promise.all([
        tx.chat.findMany({
          orderBy: [{ archived: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
          select: projectChatSelect,
          where: { permanentDeletionAt: null, projectId }
        }),
        tx.projectFolder.findMany({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          select: { id: true, name: true, parentId: true, sortOrder: true },
          where: { projectId }
        }),
        loadProjectChatDefaultAuthority(tx, projectId)
      ]), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return {
        chats: chats.map((chat) => projectChatWire(chat, authority, {
          availability: workspaceAvailability,
          snapshot: workspaceSnapshot
        })),
        folders: folders.map(folderWire)
      };
    },

    async createChat(input: {
      actorDisplayName: string;
      folderId?: string | null;
      projectId: string;
      title?: string | null;
      userId: string;
      workspaceEnabled?: boolean;
    }): Promise<ProjectRepositoryResult<ProjectChatSummaryWire>> {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "CONTRIBUTOR",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const project = await tx.project.findUnique({
            select: { defaults: true },
            where: { id: input.projectId }
          });
          if (!project) return { kind: "not_found" as const };
          if (input.folderId) {
            const folder = await tx.projectFolder.findUnique({
              where: { projectId_id: { id: input.folderId, projectId: input.projectId } }
            });
            if (!folder) return { kind: "target_not_found" as const, reason: "project_folder_not_found" };
          }
          const decoded = decodeProjectDefaults(project.defaults);
          if (!decoded.ok) {
            return { kind: "conflict" as const, reason: "project_configuration_unavailable" };
          }
          const defaults = decoded.defaults;
          const authority = await loadProjectChatDefaultAuthority(tx, input.projectId);
          const safeDefaults = projectChatDefaultsProjection(authority, {
            defaultKnowledgePlan: defaults.knowledgePlan,
            defaultModelId: defaults.providerModelId
          });
          const chat = await tx.chat.create({
            data: {
              createdByDisplayName: input.actorDisplayName,
              createdByUserId: input.userId,
              defaultKnowledgePlan: safeDefaults.defaultKnowledgePlan as Prisma.InputJsonValue,
              defaultProviderModelId: safeDefaults.defaultModelId,
              memoryMode: "EXCLUDED",
              projectFolderId: input.folderId ?? null,
              projectId: input.projectId,
              title: input.title?.trim().slice(0, 80) || defaultChatTitle,
              userId: null,
              ...(input.workspaceEnabled === undefined
                ? {}
                : { workspaceEnabled: input.workspaceEnabled })
            },
            select: projectChatSelect
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_chat_created",
              metadata: { chatId: chat.id },
              projectId: input.projectId
            })
          });
          return {
            kind: "ok" as const,
            value: projectChatWire(chat, authority, {
              availability: workspaceAvailability,
              snapshot: workspaceSnapshot
            })
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_chat_create_conflict" };
        throw error;
      }
    },

    async createFolder(input: {
      actorDisplayName: string;
      name: string;
      parentId?: string | null;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectFolderWire>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (input.parentId) {
            const parent = await tx.projectFolder.findUnique({
              where: { projectId_id: { id: input.parentId, projectId: input.projectId } }
            });
            if (!parent) return { kind: "target_not_found" as const, reason: "project_folder_not_found" };
          }
          const aggregate = await tx.projectFolder.aggregate({
            _max: { sortOrder: true },
            where: { projectId: input.projectId }
          });
          const folder = await tx.projectFolder.create({
            data: {
              createdByUserId: input.userId,
              name: input.name,
              parentId: input.parentId ?? null,
              projectId: input.projectId,
              sortOrder: (aggregate._max.sortOrder ?? 0) + 10
            },
            select: { id: true, name: true, parentId: true, sortOrder: true }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_folder_created",
              metadata: { folderId: folder.id },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: folderWire(folder) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_folder_conflict" };
        throw error;
      }
    },

    async updateFolder(input: {
      actorDisplayName: string;
      folderId: string;
      name?: string;
      parentId?: string | null;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectFolderWire>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const current = await tx.projectFolder.findUnique({
            where: { projectId_id: { id: input.folderId, projectId: input.projectId } }
          });
          if (!current) return { kind: "target_not_found" as const, reason: "project_folder_not_found" };
          if (input.parentId === input.folderId) {
            return { kind: "conflict" as const, reason: "project_folder_cycle" };
          }
          if (input.parentId) {
            const descendants = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              WITH RECURSIVE descendants AS (
                SELECT "id" FROM "ProjectFolder"
                WHERE "projectId" = ${input.projectId} AND "parentId" = ${input.folderId}
                UNION ALL
                SELECT child."id" FROM "ProjectFolder" child
                JOIN descendants parent ON child."parentId" = parent."id"
                WHERE child."projectId" = ${input.projectId}
              )
              SELECT "id" FROM descendants WHERE "id" = ${input.parentId} LIMIT 1
            `);
            const parent = await tx.projectFolder.findUnique({
              where: { projectId_id: { id: input.parentId, projectId: input.projectId } }
            });
            if (!parent) return { kind: "target_not_found" as const, reason: "project_folder_not_found" };
            if (descendants[0]) return { kind: "conflict" as const, reason: "project_folder_cycle" };
          }
          const folder = await tx.projectFolder.update({
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.parentId !== undefined ? { parentId: input.parentId } : {})
            },
            select: { id: true, name: true, parentId: true, sortOrder: true },
            where: { projectId_id: { id: input.folderId, projectId: input.projectId } }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_folder_updated",
              metadata: { folderId: folder.id },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: folderWire(folder) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_folder_conflict" };
        throw error;
      }
    },

    async deleteFolder(input: {
      actorDisplayName: string;
      folderId: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const folder = await tx.projectFolder.findUnique({
            where: { projectId_id: { id: input.folderId, projectId: input.projectId } }
          });
          if (!folder) return { kind: "target_not_found" as const, reason: "project_folder_not_found" };
          // Deleting a folder is an atomic move, never a destructive subtree
          // delete. Children and chats inherit the deleted folder's parent.
          await tx.projectFolder.updateMany({
            data: { parentId: folder.parentId },
            where: { parentId: input.folderId, projectId: input.projectId }
          });
          await tx.chat.updateMany({
            data: { projectFolderId: folder.parentId },
            where: { projectFolderId: input.folderId, projectId: input.projectId }
          });
          await tx.projectFolder.delete({
            where: { projectId_id: { id: input.folderId, projectId: input.projectId } }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_folder_deleted",
              metadata: { folderId: input.folderId },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: input.folderId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_folder_conflict" };
        throw error;
      }
    },

    async setChatArchived(input: {
      actorDisplayName: string;
      archived: boolean;
      chatId: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectChatSummaryWire>> {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      try {
        return await publishProjectResult(input.projectId, prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const chatRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "Chat"
            WHERE "id" = ${input.chatId} AND "projectId" = ${input.projectId}
              AND "permanentDeletionAt" IS NULL
            FOR UPDATE
          `);
          if (!chatRows[0]) return { kind: "target_not_found" as const, reason: "project_chat_not_found" };
          const activeRun = await tx.modelRun.findFirst({
            where: {
              chatId: input.chatId,
              status: { in: ["preparing", "streaming", "queued", "in_progress"] }
            }
          });
          if (activeRun) throw new ActiveRunConflictError();
          const chat = await tx.chat.update({
            data: { archived: input.archived },
            select: projectChatSelect,
            where: { id: input.chatId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: input.archived ? "project_chat_archived" : "project_chat_restored",
              metadata: { chatId: input.chatId },
              projectId: input.projectId
            })
          });
          const authority = await loadProjectChatDefaultAuthority(tx, input.projectId);
          return {
            kind: "ok" as const,
            value: projectChatWire(chat, authority, {
              availability: workspaceAvailability,
              snapshot: workspaceSnapshot
            })
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (error instanceof ActiveRunConflictError) {
          return { kind: "conflict", reason: "active_run_in_progress" };
        }
        if (knownConflict(error)) return { kind: "conflict", reason: "project_chat_conflict" };
        throw error;
      }
    }
  };
}

export type ReturnTypeOfProjectContentRepository = ReturnType<typeof createPrismaProjectContentRepository>;

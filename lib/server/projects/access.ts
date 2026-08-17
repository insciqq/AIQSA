import type { Prisma, PrismaClient, ProjectStatus } from "@prisma/client";
import {
  highestProjectRole,
  projectRoleAtLeast,
  type ProjectRole
} from "../../domain/projects";

export type ProjectAccessClient = Pick<PrismaClient, "chat" | "project" | "user"> | Prisma.TransactionClient;

export type ProjectAccess = Readonly<{
  accessRevision: number;
  directRole: ProjectRole | null;
  effectiveRole: ProjectRole;
  groupGrants: readonly Readonly<{
    groupId: string;
    groupName: string;
    role: ProjectRole;
  }>[];
  instructionsRevision: number;
  memoryRevision: number;
  policyRevision: number;
  projectId: string;
  status: ProjectStatus;
}>;

const projectAccessSelect = {
  accessRevision: true,
  grants: {
    select: {
      group: { select: { id: true, name: true } },
      groupId: true,
      role: true,
      userId: true
    }
  },
  id: true,
  instructionsRevision: true,
  memoryRevision: true,
  policyRevision: true,
  status: true
} satisfies Prisma.ProjectSelect;

export async function resolveProjectAccess(
  client: ProjectAccessClient,
  input: Readonly<{
    allowDeleting?: boolean;
    minimumRole?: ProjectRole;
    projectId: string;
    requireActive?: boolean;
    userId: string;
  }>
): Promise<ProjectAccess | null> {
  const user = await client.user.findFirst({
    select: {
      groups: {
        select: { groupId: true },
        where: { group: { archivedAt: null } }
      },
      id: true
    },
    where: { id: input.userId, status: "active" }
  });
  if (!user) return null;
  const activeGroupIds = user.groups.map(({ groupId }) => groupId);
  const project = await client.project.findUnique({
    select: projectAccessSelect,
    where: { id: input.projectId }
  });
  if (!project || (project.status === "DELETING" && !input.allowDeleting)) {
    return null;
  }
  if (input.requireActive && project.status !== "ACTIVE") return null;

  const direct = project.grants.find((grant) => grant.userId === input.userId) ?? null;
  const activeGroupSet = new Set(activeGroupIds);
  const groupGrants = project.grants.flatMap((grant) =>
    grant.groupId && grant.group && activeGroupSet.has(grant.groupId)
      ? [{ groupId: grant.groupId, groupName: grant.group.name, role: grant.role }]
      : []
  );
  const effectiveRole = highestProjectRole([
    ...(direct ? [direct.role] : []),
    ...groupGrants.map(({ role }) => role)
  ]);
  if (!effectiveRole || (input.minimumRole && !projectRoleAtLeast(effectiveRole, input.minimumRole))) {
    return null;
  }
  return {
    accessRevision: project.accessRevision,
    directRole: direct?.role ?? null,
    effectiveRole,
    groupGrants,
    instructionsRevision: project.instructionsRevision,
    memoryRevision: project.memoryRevision,
    policyRevision: project.policyRevision,
    projectId: project.id,
    status: project.status
  };
}

export type ChatAccess =
  | Readonly<{ kind: "personal"; project: null; userId: string }>
  | Readonly<{ kind: "project"; project: ProjectAccess; userId: null }>;

export async function resolveChatAccess(
  client: ProjectAccessClient,
  input: Readonly<{
    minimumProjectRole?: ProjectRole;
    requireMutable?: boolean;
    chatId: string;
    userId: string;
  }>
): Promise<ChatAccess | null> {
  const chat = await client.chat.findUnique({
    select: { archived: true, permanentDeletionAt: true, projectId: true, userId: true },
    where: { id: input.chatId }
  });
  if (!chat || chat.permanentDeletionAt) return null;
  if (chat.userId !== null) {
    return chat.userId === input.userId
      ? { kind: "personal", project: null, userId: input.userId }
      : null;
  }
  if (!chat.projectId) return null;
  const project = await resolveProjectAccess(client, {
    minimumRole: input.minimumProjectRole ?? "VIEWER",
    projectId: chat.projectId,
    requireActive: input.requireMutable === true,
    userId: input.userId
  });
  return project ? { kind: "project", project, userId: null } : null;
}

import {
  Prisma,
  PrismaClient,
  type ProjectRole as PrismaProjectRole
} from "@prisma/client";
import {
  DEFAULT_PROJECT_POLICY,
  EMPTY_PROJECT_DEFAULTS,
  type ProjectActivityResponseWire,
  type ProjectAuditEventWire,
  type ProjectDefaultsWire,
  type ProjectDetailWire,
  type ProjectGrantWire,
  type ProjectPolicyWire,
  type ProjectResourceTypeWire,
  type ProjectResourceWire,
  type ProjectSummaryWire
} from "../../contracts/projects";
import {
  PROJECT_ROLE_CAPABILITIES,
  highestProjectRole,
  projectRoleAtLeast,
  type ProjectRole
} from "../../domain/projects";
import { canAccessModel, canAccessSearchStrategy } from "../auth/entitlements";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { createPrismaAssistantRepository } from "../assistants/prismaRepository";
import { resolveEffectiveMcpGrant } from "../mcp/access";
import { resolveProjectAccess } from "./access";

export type ProjectRepositoryResult<Value> =
  | Readonly<{ kind: "conflict"; reason: string }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok"; value: Value }>;

export type ProjectRepository = ReturnType<typeof createPrismaProjectRepository>;

const projectListInclude = {
  _count: { select: { chats: true } },
  grants: {
    include: {
      group: { select: { archivedAt: true, id: true, name: true } },
      user: { select: { id: true, status: true } }
    }
  }
} satisfies Prisma.ProjectInclude;

type ProjectListRow = Prisma.ProjectGetPayload<{ include: typeof projectListInclude }>;

const projectDetailInclude = {
  _count: { select: { chats: true } },
  assistantBindings: {
    include: {
      assistant: { select: { archivedAt: true } },
      revision: { select: { id: true, name: true } }
    }
  },
  grants: {
    include: {
      group: { select: { archivedAt: true, id: true, name: true } },
      user: { select: { displayName: true, email: true, id: true, status: true } }
    },
    orderBy: { createdAt: "asc" as const }
  },
  knowledgeBaseBindings: {
    include: { knowledgeBase: { select: { archivedAt: true, id: true, name: true } } }
  },
  mcpBindings: {
    include: {
      server: {
        select: { activeRevisionId: true, archivedAt: true, displayName: true, enabled: true, id: true }
      }
    }
  },
  modelBindings: {
    include: {
      providerModel: {
        select: {
          connectionId: true,
          displayName: true,
          enabled: true,
          id: true,
          modelClass: true,
          modelId: true
        }
      }
    }
  },
  searchBindings: {
    include: {
      searchOption: { select: { archivedAt: true, displayName: true, enabled: true, id: true, optionId: true } }
    }
  }
} satisfies Prisma.ProjectInclude;

type ProjectDetailRow = Prisma.ProjectGetPayload<{ include: typeof projectDetailInclude }>;

function iso(value: Date): string {
  return value.toISOString();
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function storedDefaults(value: Prisma.JsonValue): ProjectDefaultsWire {
  const raw = jsonObject(value);
  return {
    assistantId: typeof raw.assistantId === "string" ? raw.assistantId : null,
    controlValues:
      typeof raw.controlValues === "object" && raw.controlValues !== null && !Array.isArray(raw.controlValues)
        ? raw.controlValues as Record<string, boolean | string>
        : EMPTY_PROJECT_DEFAULTS.controlValues,
    knowledgePlan:
      typeof raw.knowledgePlan === "object" && raw.knowledgePlan !== null
        ? raw.knowledgePlan as ProjectDefaultsWire["knowledgePlan"]
        : EMPTY_PROJECT_DEFAULTS.knowledgePlan,
    mcpMode: raw.mcpMode === "auto" || raw.mcpMode === "load_all" ? raw.mcpMode : "off",
    providerModelId: typeof raw.providerModelId === "string" ? raw.providerModelId : null,
    searchPlan:
      typeof raw.searchPlan === "object" && raw.searchPlan !== null
        ? raw.searchPlan as ProjectDefaultsWire["searchPlan"]
        : EMPTY_PROJECT_DEFAULTS.searchPlan
  };
}

function storedPolicy(value: Prisma.JsonValue): ProjectPolicyWire {
  const raw = jsonObject(value);
  return {
    externalToolsEnabled:
      typeof raw.externalToolsEnabled === "boolean"
        ? raw.externalToolsEnabled
        : DEFAULT_PROJECT_POLICY.externalToolsEnabled
  };
}

function rolesFor(row: ProjectListRow, userId: string, activeGroupIds: ReadonlySet<string>) {
  const directRole = row.grants.find((grant) => grant.userId === userId)?.role ?? null;
  const grantedThrough = row.grants.flatMap((grant) =>
    grant.groupId && grant.group && !grant.group.archivedAt && activeGroupIds.has(grant.groupId)
      ? [{ groupId: grant.groupId, groupName: grant.group.name, role: grant.role }]
      : []
  );
  return {
    directRole,
    effectiveRole: highestProjectRole([
      ...(directRole ? [directRole] : []),
      ...grantedThrough.map(({ role }) => role)
    ]),
    grantedThrough
  };
}

function summary(
  row: ProjectListRow,
  input: { activeGroupIds: ReadonlySet<string>; userId: string }
): ProjectSummaryWire | null {
  const roles = rolesFor(row, input.userId, input.activeGroupIds);
  if (!roles.effectiveRole) return null;
  const audienceCount = row.grants.filter((grant) =>
    (grant.userId !== null && grant.user?.status === "active") ||
    (grant.groupId !== null && grant.group?.archivedAt === null)
  ).length;
  return {
    accessRevision: row.accessRevision,
    audienceCount,
    chatCount: row._count.chats,
    description: row.description,
    directRole: roles.directRole,
    effectiveRole: roles.effectiveRole,
    grantedThrough: roles.grantedThrough,
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: iso(row.updatedAt)
  };
}

function grantWire(grant: ProjectDetailRow["grants"][number]): ProjectGrantWire {
  return {
    createdAt: iso(grant.createdAt),
    group: grant.group
      ? {
          archived: grant.group.archivedAt !== null,
          id: grant.group.id,
          name: grant.group.name
        }
      : null,
    id: grant.id,
    role: grant.role,
    user: grant.user
      ? {
          displayName: grant.user.displayName,
          email: grant.user.email,
          id: grant.user.id,
          status: grant.user.status
        }
      : null
  };
}

function resources(row: ProjectDetailRow): ProjectResourceWire[] {
  return [
    ...row.modelBindings.map((binding) => ({
      available: binding.providerModel.enabled && binding.providerModel.modelClass === "answer",
      id: `model:${binding.providerModelId}`,
      label: binding.providerModel.displayName,
      modelId: binding.providerModel.modelId,
      provider: binding.providerModel.connectionId,
      reason: binding.providerModel.enabled && binding.providerModel.modelClass === "answer"
        ? null
        : "resource_unavailable",
      resourceId: binding.providerModelId,
      type: "model" as const
    })),
    ...row.searchBindings.map((binding) => ({
      available: binding.searchOption.enabled && binding.searchOption.archivedAt === null,
      id: `search:${binding.searchOptionId}`,
      label: binding.searchOption.displayName,
      reason: binding.searchOption.enabled && binding.searchOption.archivedAt === null
        ? null
        : "resource_unavailable",
      resourceId: binding.searchOption.optionId,
      type: "search" as const
    })),
    ...row.mcpBindings.map((binding) => ({
      available: binding.server.enabled && binding.server.archivedAt === null && Boolean(binding.server.activeRevisionId),
      id: `mcp:${binding.serverId}`,
      label: binding.server.displayName,
      reason: binding.server.enabled && binding.server.archivedAt === null && binding.server.activeRevisionId
        ? null
        : "resource_unavailable",
      resourceId: binding.serverId,
      type: "mcp" as const
    })),
    ...row.knowledgeBaseBindings.map((binding) => ({
      available: binding.knowledgeBase.archivedAt === null,
      id: binding.id,
      label: binding.knowledgeBase.name,
      reason: binding.knowledgeBase.archivedAt === null ? null : "resource_archived",
      resourceId: binding.knowledgeBaseId,
      type: "knowledge" as const
    })),
    ...row.assistantBindings.map((binding) => ({
      available: binding.assistant.archivedAt === null,
      id: binding.id,
      label: binding.revision.name,
      reason: binding.assistant.archivedAt === null ? null : "resource_archived",
      resourceId: binding.assistantId,
      revisionId: binding.revisionId,
      type: "assistant" as const
    }))
  ];
}

function detail(
  row: ProjectDetailRow,
  access: NonNullable<Awaited<ReturnType<typeof resolveProjectAccess>>>
): ProjectDetailWire {
  const base: ProjectSummaryWire = {
    accessRevision: row.accessRevision,
    audienceCount: row.grants.filter((grant) =>
      (grant.user !== null && grant.user.status === "active") ||
      (grant.group !== null && grant.group.archivedAt === null)
    ).length,
    chatCount: row._count.chats,
    description: row.description,
    directRole: access.directRole,
    effectiveRole: access.effectiveRole,
    grantedThrough: access.groupGrants,
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: iso(row.updatedAt)
  };
  return {
    ...base,
    capabilities: PROJECT_ROLE_CAPABILITIES[access.effectiveRole],
    createdAt: iso(row.createdAt),
    defaults: storedDefaults(row.defaults),
    grants: row.grants.map(grantWire),
    instructions: row.instructions,
    instructionsRevision: row.instructionsRevision,
    memoryEnabled: row.memoryEnabled,
    memoryRevision: row.memoryRevision,
    policy: storedPolicy(row.policy),
    policyRevision: row.policyRevision,
    publicSharingEnabled: row.publicSharingEnabled,
    resources: resources(row)
  };
}

function auditMetadata(value: Prisma.JsonValue): ProjectAuditEventWire["metadata"] {
  const raw = jsonObject(value);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean | number | string | null] =>
      entry[1] === null || ["boolean", "number", "string"].includes(typeof entry[1])
    )
  );
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
}

function audit(input: {
  actorDisplayName: string;
  actorUserId: string;
  eventType: string;
  metadata?: Prisma.InputJsonObject;
  projectId: string;
}): Prisma.ProjectAuditEventUncheckedCreateInput {
  return {
    actorDisplayName: input.actorDisplayName,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
    projectId: input.projectId
  };
}

function canManageGrant(
  actorRole: ProjectRole,
  oldRole: ProjectRole | null,
  newRole: ProjectRole | null
): boolean {
  if (!projectRoleAtLeast(actorRole, "MANAGER")) return false;
  if (actorRole === "OWNER") return true;
  return ![oldRole, newRole].some((role) => role === "MANAGER" || role === "OWNER");
}

function knownConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003", "P2004", "P2025", "P2034"].includes(error.code);
}

export function createPrismaProjectRepository(prisma: PrismaClient) {
  async function getDetail(userId: string, projectId: string): Promise<ProjectDetailWire | null> {
    const access = await resolveProjectAccess(prisma, { projectId, userId });
    if (!access) return null;
    const row = await prisma.project.findUnique({ include: projectDetailInclude, where: { id: projectId } });
    return row ? detail(row, access) : null;
  }

  return {
    async list(userId: string): Promise<ProjectSummaryWire[] | null> {
      const user = await prisma.user.findFirst({
        select: {
          groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
          id: true
        },
        where: { id: userId, status: "active" }
      });
      if (!user) return null;
      const activeGroupIds = new Set(user.groups.map(({ groupId }) => groupId));
      const rows = await prisma.project.findMany({
        include: projectListInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        where: {
          grants: {
            some: {
              OR: [
                { userId },
                ...(activeGroupIds.size > 0 ? [{ groupId: { in: [...activeGroupIds] } }] : [])
              ]
            }
          },
          status: { not: "DELETING" }
        }
      });
      return rows.flatMap((row) => {
        const value = summary(row, { activeGroupIds, userId });
        return value ? [value] : [];
      });
    },

    getDetail,

    async create(input: {
      actorDisplayName: string;
      description: string;
      name: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectDetailWire>> {
      try {
        const projectId = await prisma.$transaction(async (tx) => {
          const user = await tx.user.findFirst({
            select: { id: true },
            where: { id: input.userId, status: "active" }
          });
          if (!user) return null;
          const project = await tx.project.create({
            data: {
              createdByDisplayName: input.actorDisplayName,
              createdByUserId: input.userId,
              defaults: EMPTY_PROJECT_DEFAULTS as unknown as Prisma.InputJsonValue,
              description: input.description,
              name: input.name,
              policy: DEFAULT_PROJECT_POLICY as unknown as Prisma.InputJsonValue
            },
            select: { id: true }
          });
          await tx.projectGrant.create({
            data: {
              createdByUserId: input.userId,
              projectId: project.id,
              role: "OWNER",
              userId: input.userId
            }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "project_created",
              projectId: project.id
            })
          });
          return project.id;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (!projectId) return { kind: "not_found" };
        const value = await getDetail(input.userId, projectId);
        return value ? { kind: "ok", value } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_create_conflict" };
        throw error;
      }
    },

    async update(input: {
      actorDisplayName: string;
      defaults?: ProjectDefaultsWire;
      description?: string;
      expectedAccessRevision?: number;
      expectedInstructionsRevision?: number;
      expectedMemoryRevision?: number;
      expectedPolicyRevision?: number;
      instructions?: string;
      memoryEnabled?: boolean;
      name?: string;
      policy?: ProjectPolicyWire;
      projectId: string;
      publicSharingEnabled?: boolean;
      status?: "ACTIVE" | "ARCHIVED";
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectDetailWire>> {
      try {
        const changed = await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const current = await tx.project.findUnique({ where: { id: input.projectId } });
          if (!current || current.status === "DELETING") return { kind: "not_found" as const };
          if (current.status === "ARCHIVED" && [
            input.defaults,
            input.description,
            input.instructions,
            input.memoryEnabled,
            input.name,
            input.policy,
            input.publicSharingEnabled
          ].some((value) => value !== undefined)) {
            return { kind: "conflict" as const, reason: "project_archived" };
          }
          if (
            input.expectedAccessRevision !== undefined &&
            input.expectedAccessRevision !== current.accessRevision
          ) return { kind: "conflict" as const, reason: "access_revision_conflict" };
          if (
            input.expectedInstructionsRevision !== undefined &&
            input.expectedInstructionsRevision !== current.instructionsRevision
          ) return { kind: "conflict" as const, reason: "instructions_revision_conflict" };
          if (
            input.expectedMemoryRevision !== undefined &&
            input.expectedMemoryRevision !== current.memoryRevision
          ) return { kind: "conflict" as const, reason: "memory_revision_conflict" };
          if (
            input.expectedPolicyRevision !== undefined &&
            input.expectedPolicyRevision !== current.policyRevision
          ) return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          if (input.defaults !== undefined) {
            const [models, searches, knowledge, assistants, mcpServers] = await Promise.all([
              tx.projectModelBinding.findMany({ select: { providerModelId: true }, where: { projectId: input.projectId } }),
              tx.projectSearchBinding.findMany({ include: { searchOption: { select: { id: true, optionId: true } } }, where: { projectId: input.projectId } }),
              tx.projectKnowledgeBaseBinding.findMany({ select: { knowledgeBaseId: true }, where: { projectId: input.projectId } }),
              tx.projectAssistantBinding.findMany({ select: { assistantId: true }, where: { projectId: input.projectId } }),
              tx.projectMcpBinding.count({ where: { projectId: input.projectId } })
            ]);
            const modelIds = new Set(models.map(({ providerModelId }) => providerModelId));
            const searchIds = new Set(searches.flatMap(({ searchOption }) => [searchOption.id, searchOption.optionId]));
            const knowledgeIds = new Set(knowledge.map(({ knowledgeBaseId }) => knowledgeBaseId));
            const assistantIds = new Set(assistants.map(({ assistantId }) => assistantId));
            if (
              (input.defaults.providerModelId !== null && !modelIds.has(input.defaults.providerModelId)) ||
              input.defaults.knowledgePlan.baseIds.some((id) => !knowledgeIds.has(id)) ||
              input.defaults.searchPlan.optionIds.some((id) => !searchIds.has(id)) ||
              (input.defaults.assistantId !== null && !assistantIds.has(input.defaults.assistantId)) ||
              (input.defaults.mcpMode !== "off" && mcpServers === 0)
            ) return { kind: "conflict" as const, reason: "project_default_resource_unavailable" };
          }
          const effectivePolicy = input.policy ?? storedPolicy(current.policy);
          const effectiveDefaults = input.defaults ?? storedDefaults(current.defaults);
          if (
            !effectivePolicy.externalToolsEnabled &&
            (effectiveDefaults.searchPlan.optionIds.length > 0 || effectiveDefaults.mcpMode !== "off")
          ) return { kind: "conflict" as const, reason: "project_external_tools_disabled" };
          if (
            (input.status !== undefined || input.publicSharingEnabled !== undefined) &&
            access.effectiveRole !== "OWNER"
          ) return { kind: "conflict" as const, reason: "owner_role_required" };

          const data: Prisma.ProjectUpdateInput = {};
          const events: Array<{ eventType: string; metadata?: Prisma.InputJsonObject }> = [];
          if (input.name !== undefined && input.name !== current.name) {
            data.name = input.name;
            events.push({ eventType: "project_renamed" });
          }
          if (input.description !== undefined) data.description = input.description;
          if (input.instructions !== undefined && input.instructions !== current.instructions) {
            data.instructions = input.instructions;
            data.instructionsRevision = { increment: 1 };
            events.push({ eventType: "instructions_updated", metadata: { fromRevision: current.instructionsRevision } });
          }
          if (input.policy !== undefined) {
            data.policy = input.policy as unknown as Prisma.InputJsonValue;
            data.policyRevision = { increment: 1 };
            events.push({ eventType: "policy_updated", metadata: { fromRevision: current.policyRevision } });
          }
          if (input.defaults !== undefined) {
            data.defaults = input.defaults as unknown as Prisma.InputJsonValue;
            if (input.policy === undefined) data.policyRevision = { increment: 1 };
            events.push({ eventType: "defaults_updated", metadata: { fromRevision: current.policyRevision } });
          }
          if (input.memoryEnabled !== undefined && input.memoryEnabled !== current.memoryEnabled) {
            data.memoryEnabled = input.memoryEnabled;
            data.memoryRevision = { increment: 1 };
            events.push({ eventType: "memory_policy_updated", metadata: { enabled: input.memoryEnabled } });
          }
          if (input.publicSharingEnabled !== undefined && input.publicSharingEnabled !== current.publicSharingEnabled) {
            data.publicSharingEnabled = input.publicSharingEnabled;
            if (input.policy === undefined && input.defaults === undefined) {
              data.policyRevision = { increment: 1 };
            }
            events.push({ eventType: input.publicSharingEnabled ? "public_sharing_enabled" : "public_sharing_disabled" });
            if (!input.publicSharingEnabled) {
              await tx.sharedChatSnapshot.updateMany({
                data: { revokedAt: new Date() },
                where: { projectId: input.projectId, revokedAt: null }
              });
            }
          }
          if (input.status !== undefined && input.status !== current.status) {
            data.status = input.status;
            data.archivedAt = input.status === "ARCHIVED" ? new Date() : null;
            data.accessRevision = { increment: 1 };
            events.push({ eventType: input.status === "ARCHIVED" ? "project_archived" : "project_restored" });
          }
          if (Object.keys(data).length > 0) {
            await tx.project.update({ data, where: { id: input.projectId } });
          }
          if (events.length > 0) {
            await tx.projectAuditEvent.createMany({
              data: events.map((event) => audit({
                actorDisplayName: input.actorDisplayName,
                actorUserId: input.userId,
                eventType: event.eventType,
                metadata: event.metadata,
                projectId: input.projectId
              }))
            });
          }
          return { kind: "ok" as const };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (changed.kind !== "ok") return changed;
        const value = await getDetail(input.userId, input.projectId);
        return value ? { kind: "ok", value } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_update_conflict" };
        throw error;
      }
    },

    async listGrants(userId: string, projectId: string): Promise<ProjectGrantWire[] | null> {
      const value = await getDetail(userId, projectId);
      return value ? [...value.grants] : null;
    },

    async addGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      groupId?: string;
      projectId: string;
      role: ProjectRole;
      userId: string;
      targetUserId?: string;
    }): Promise<ProjectRepositoryResult<ProjectGrantWire>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          if (!canManageGrant(access.effectiveRole, null, input.role) || (input.groupId && input.role === "OWNER")) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (input.targetUserId) {
            const target = await tx.user.findFirst({ where: { id: input.targetUserId, status: "active" } });
            if (!target) return { kind: "not_found" as const };
          } else if (input.groupId) {
            const target = await tx.group.findFirst({ where: { archivedAt: null, id: input.groupId } });
            if (!target) return { kind: "not_found" as const };
          } else {
            return { kind: "conflict" as const, reason: "grant_subject_invalid" };
          }
          const created = await tx.projectGrant.create({
            data: {
              createdByUserId: input.userId,
              groupId: input.groupId,
              projectId: input.projectId,
              role: input.role,
              userId: input.targetUserId
            },
            include: projectDetailInclude.grants.include
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: input.groupId ? "group_grant_added" : "user_grant_added",
              metadata: {
                role: input.role,
                subjectId: input.groupId ?? input.targetUserId ?? null
              },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: grantWire(created) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async updateGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      grantId: string;
      projectId: string;
      role: ProjectRole;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectGrantWire>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          const current = await tx.projectGrant.findFirst({
            where: { id: input.grantId, projectId: input.projectId }
          });
          if (!current) return { kind: "not_found" as const };
          if (!canManageGrant(access.effectiveRole, current.role, input.role) || (current.groupId && input.role === "OWNER")) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (current.role === "OWNER" && input.role !== "OWNER") {
            const ownerCount = await tx.projectGrant.count({
              where: {
                projectId: input.projectId,
                role: "OWNER",
                user: { status: "active" },
                userId: { not: null }
              }
            });
            if (ownerCount <= 1) return { kind: "conflict" as const, reason: "last_owner_required" };
          }
          const updated = await tx.projectGrant.update({
            data: { role: input.role as PrismaProjectRole },
            include: projectDetailInclude.grants.include,
            where: { id: input.grantId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: current.groupId ? "group_grant_changed" : "user_grant_changed",
              metadata: { fromRole: current.role, grantId: current.id, toRole: input.role },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: grantWire(updated) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async removeGrant(input: {
      actorDisplayName: string;
      expectedAccessRevision: number;
      grantId: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.accessRevision !== input.expectedAccessRevision) {
            return { kind: "conflict" as const, reason: "access_revision_conflict" };
          }
          const current = await tx.projectGrant.findFirst({
            where: { id: input.grantId, projectId: input.projectId }
          });
          if (!current) return { kind: "not_found" as const };
          if (!canManageGrant(access.effectiveRole, current.role, null)) {
            return { kind: "conflict" as const, reason: "grant_role_not_permitted" };
          }
          if (current.role === "OWNER") {
            const ownerCount = await tx.projectGrant.count({
              where: {
                projectId: input.projectId,
                role: "OWNER",
                user: { status: "active" },
                userId: { not: null }
              }
            });
            if (ownerCount <= 1) return { kind: "conflict" as const, reason: "last_owner_required" };
          }
          await tx.projectGrant.delete({ where: { id: current.id } });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: current.groupId ? "group_grant_removed" : "user_grant_removed",
              metadata: { grantId: current.id, role: current.role },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: current.id } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "grant_conflict" };
        throw error;
      }
    },

    async listResources(userId: string, projectId: string): Promise<ProjectResourceWire[] | null> {
      const value = await getDetail(userId, projectId);
      return value ? [...value.resources] : null;
    },

    async addResource(input: {
      actorDisplayName: string;
      expectedPolicyRevision: number;
      projectId: string;
      resourceId: string;
      revisionId?: string;
      type: ProjectResourceTypeWire;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectResourceWire[]>> {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.policyRevision !== input.expectedPolicyRevision) {
            return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          }
          let eventType = "resource_attached";
          if (input.type === "model") {
            const target = await tx.providerModel.findFirst({
              select: { connectionId: true, id: true },
              where: { enabled: true, id: input.resourceId, modelClass: "answer" }
            });
            if (!target) return { kind: "not_found" as const };
            const entitlements = await loadEntitlementsForUser(input.userId, tx);
            if (!canAccessModel(entitlements, target.connectionId, target.id)) {
              return { kind: "not_found" as const };
            }
            await tx.projectModelBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, providerModelId: input.resourceId }
            });
          } else if (input.type === "search") {
            const target = await tx.searchOption.findFirst({
              select: { id: true, optionId: true },
              where: {
                archivedAt: null,
                enabled: true,
                OR: [{ id: input.resourceId }, { optionId: input.resourceId }]
              }
            });
            if (!target) return { kind: "not_found" as const };
            const entitlements = await loadEntitlementsForUser(input.userId, tx);
            if (!canAccessSearchStrategy(entitlements, target.optionId)) {
              return { kind: "not_found" as const };
            }
            await tx.projectSearchBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, searchOptionId: target.id }
            });
          } else if (input.type === "mcp") {
            const target = await tx.mcpServer.findFirst({
              where: { activeRevisionId: { not: null }, archivedAt: null, enabled: true, id: input.resourceId }
            });
            if (!target) return { kind: "not_found" as const };
            const memberships = await tx.userGroup.findMany({
              select: { groupId: true },
              where: { group: { archivedAt: null }, userId: input.userId }
            });
            const groupIds = memberships.map(({ groupId }) => groupId);
            const grants = await tx.mcpGrant.findMany({
              select: { canUse: true, groupId: true, personalSlotKeys: true, userId: true },
              where: {
                OR: [
                  { userId: input.userId },
                  ...(groupIds.length > 0 ? [{ groupId: { in: groupIds } }] : [])
                ],
                serverId: input.resourceId
              }
            });
            const mcpAccess = resolveEffectiveMcpGrant({
              direct: grants.find((grant) => grant.userId === input.userId) ?? null,
              groups: grants.filter((grant) => grant.groupId !== null)
            });
            if (!mcpAccess.canUse) return { kind: "not_found" as const };
            await tx.projectMcpBinding.create({
              data: { addedByUserId: input.userId, projectId: input.projectId, serverId: input.resourceId }
            });
          } else if (input.type === "knowledge") {
            const target = await tx.knowledgeBase.findFirst({
              where: {
                archivedAt: null,
                id: input.resourceId,
                OR: [
                  { ownerUserId: input.userId },
                  {
                    publications: {
                      some: {
                        OR: [
                          { scope: "installation" },
                          ...(await tx.userGroup.findMany({
                            select: { groupId: true },
                            where: { group: { archivedAt: null }, userId: input.userId }
                          })).map(({ groupId }) => ({ groupId, scope: "group" as const }))
                        ]
                      }
                    }
                  }
                ]
              }
            });
            if (!target) return { kind: "not_found" as const };
            await tx.projectKnowledgeBaseBinding.create({
              data: { addedByUserId: input.userId, knowledgeBaseId: input.resourceId, projectId: input.projectId }
            });
          } else {
            const resolution = await createPrismaAssistantRepository(
              tx as unknown as PrismaClient
            ).resolveForRun(input.userId, input.resourceId);
            if (!resolution.ok || (input.revisionId && input.revisionId !== resolution.assistant.revisionId)) {
              return { kind: "not_found" as const };
            }
            const revisionId = resolution.assistant.revisionId;
            const existing = await tx.projectAssistantBinding.findUnique({
              where: { projectId_assistantId: { assistantId: input.resourceId, projectId: input.projectId } }
            });
            if (existing) {
              await tx.projectAssistantBinding.update({
                data: { addedByUserId: input.userId, revisionId },
                where: { id: existing.id }
              });
              eventType = "resource_revision_updated";
            } else {
              await tx.projectAssistantBinding.create({
                data: {
                  addedByUserId: input.userId,
                  assistantId: input.resourceId,
                  projectId: input.projectId,
                  revisionId
                }
              });
            }
          }
          await tx.project.update({
            data: { policyRevision: { increment: 1 } },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType,
              metadata: { resourceId: input.resourceId, resourceType: input.type },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (outcome.kind !== "ok") return outcome;
        const values = await this.listResources(input.userId, input.projectId);
        return values ? { kind: "ok", value: values } : { kind: "not_found" };
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "resource_binding_conflict" };
        throw error;
      }
    },

    async removeResource(input: {
      actorDisplayName: string;
      bindingId: string;
      expectedPolicyRevision: number;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          if (access.policyRevision !== input.expectedPolicyRevision) {
            return { kind: "conflict" as const, reason: "policy_revision_conflict" };
          }
          let removed: { resourceId: string; type: ProjectResourceTypeWire } | null = null;
          const prefixed = /^(model|search|mcp):(.+)$/.exec(input.bindingId);
          if (prefixed?.[1] === "model") {
            const result = await tx.projectModelBinding.deleteMany({
              where: { projectId: input.projectId, providerModelId: prefixed[2] }
            });
            if (result.count) removed = { resourceId: prefixed[2], type: "model" };
          } else if (prefixed?.[1] === "search") {
            const result = await tx.projectSearchBinding.deleteMany({
              where: { projectId: input.projectId, searchOptionId: prefixed[2] }
            });
            if (result.count) removed = { resourceId: prefixed[2], type: "search" };
          } else if (prefixed?.[1] === "mcp") {
            const result = await tx.projectMcpBinding.deleteMany({
              where: { projectId: input.projectId, serverId: prefixed[2] }
            });
            if (result.count) removed = { resourceId: prefixed[2], type: "mcp" };
          } else {
            const knowledge = await tx.projectKnowledgeBaseBinding.findFirst({
              where: { id: input.bindingId, projectId: input.projectId }
            });
            if (knowledge) {
              await tx.projectKnowledgeBaseBinding.delete({ where: { id: knowledge.id } });
              removed = { resourceId: knowledge.knowledgeBaseId, type: "knowledge" };
            } else {
              const assistant = await tx.projectAssistantBinding.findFirst({
                where: { id: input.bindingId, projectId: input.projectId }
              });
              if (assistant) {
                await tx.projectAssistantBinding.delete({ where: { id: assistant.id } });
                removed = { resourceId: assistant.assistantId, type: "assistant" };
              }
            }
          }
          if (!removed) return { kind: "not_found" as const };
          await tx.project.update({
            data: { policyRevision: { increment: 1 } },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "resource_detached",
              metadata: { resourceId: removed.resourceId, resourceType: removed.type },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: input.bindingId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "resource_binding_conflict" };
        throw error;
      }
    },

    async activity(input: {
      before?: string;
      limit: number;
      projectId: string;
      userId: string;
    }): Promise<ProjectActivityResponseWire | null> {
      const access = await resolveProjectAccess(prisma, {
        minimumRole: "VIEWER",
        projectId: input.projectId,
        userId: input.userId
      });
      if (!access) return null;
      const cursor = input.before
        ? await prisma.projectAuditEvent.findFirst({
            select: { createdAt: true, id: true },
            where: { id: input.before, projectId: input.projectId }
          })
        : null;
      if (input.before && !cursor) return null;
      const rows = await prisma.projectAuditEvent.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        where: {
          projectId: input.projectId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              }
            : {})
        }
      });
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      return {
        events: page.map((event) => ({
          actorDisplayName: event.actorDisplayName,
          createdAt: iso(event.createdAt),
          eventType: event.eventType,
          id: event.id,
          metadata: auditMetadata(event.metadata)
        })),
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null
      };
    },

    async delete(input: {
      actorDisplayName: string;
      projectId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<{ id: string }>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            allowDeleting: true,
            minimumRole: "OWNER",
            projectId: input.projectId,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          await tx.project.update({
            data: { deletionRequestedAt: new Date(), status: "DELETING" },
            where: { id: input.projectId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "deletion_requested",
              projectId: input.projectId
            })
          });
          await tx.sharedChatSnapshot.updateMany({
            data: { revokedAt: new Date() },
            where: { projectId: input.projectId, revokedAt: null }
          });
          const attachments = await tx.attachment.findMany({
            select: { storageKey: true },
            where: { projectId: input.projectId }
          });
          if (attachments.length > 0) {
            await tx.attachmentDeletionJob.createMany({
              data: attachments.map(({ storageKey }) => ({ storageKey })),
              skipDuplicates: true
            });
          }
          // Project run and Memory evidence is immutable while the Project
          // exists, but an explicit owner-authorized erasure removes the
          // aggregate as a whole. Clear restrictive evidence/current-version
          // edges before the Project cascade removes the remaining rows.
          await tx.projectRunBinding.deleteMany({ where: { projectId: input.projectId } });
          await tx.projectMemoryProposal.deleteMany({ where: { projectId: input.projectId } });
          await tx.projectMemoryFact.updateMany({
            data: { currentVersionId: null, state: "FORGOTTEN" },
            where: { projectId: input.projectId }
          });
          await tx.project.delete({ where: { id: input.projectId } });
          return { kind: "ok" as const, value: { id: input.projectId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "project_delete_conflict" };
        throw error;
      }
    }
  };
}

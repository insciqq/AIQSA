import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  type ProjectMemoryFactWire,
  type ProjectMemoryProposalWire,
  type ProjectMemoryResponseWire
} from "../../contracts/projects";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { resolveProjectAccess } from "./access";
import type { ProjectRepositoryResult } from "./prismaRepository";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function audit(input: {
  actorDisplayName: string;
  actorUserId: string;
  eventType: string;
  metadata?: Prisma.InputJsonObject;
  projectId: string;
}) {
  return {
    actorDisplayName: input.actorDisplayName,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
    projectId: input.projectId
  };
}

function knownConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003", "P2004", "P2025", "P2034"].includes(error.code);
}

function factWire(fact: {
  createdAt: Date;
  createdByDisplayName: string;
  currentVersion: { createdAt: Date; id: string; text: string; validUntil: Date | null; versionNumber: number } | null;
  id: string;
  state: "ACTIVE" | "FORGOTTEN";
  updatedAt: Date;
}): ProjectMemoryFactWire | null {
  if (!fact.currentVersion) return null;
  return {
    createdAt: fact.createdAt.toISOString(),
    createdByDisplayName: fact.createdByDisplayName,
    factId: fact.id,
    state: fact.state,
    text: fact.currentVersion.text,
    updatedAt: fact.updatedAt.toISOString(),
    validUntil: fact.currentVersion.validUntil?.toISOString() ?? null,
    versionId: fact.currentVersion.id,
    versionNumber: fact.currentVersion.versionNumber
  };
}

function proposalWire(proposal: {
  createdAt: Date;
  id: string;
  proposedByDisplayName: string;
  proposedText: string;
  resultingFactId: string | null;
  reviewedAt: Date | null;
  sourceMessageId: string | null;
  sourceSnapshot: Prisma.JsonValue;
  state: "PENDING" | "APPROVED" | "REJECTED";
}): ProjectMemoryProposalWire {
  const snapshot = typeof proposal.sourceSnapshot === "object" &&
    proposal.sourceSnapshot !== null && !Array.isArray(proposal.sourceSnapshot)
    ? proposal.sourceSnapshot
    : null;
  const sourceRole: "assistant" | "user" | null = snapshot?.role === "assistant" || snapshot?.role === "user"
    ? snapshot.role
    : null;
  const source = snapshot &&
    typeof snapshot.createdAt === "string" &&
    typeof snapshot.messageId === "string" &&
    sourceRole !== null &&
    typeof snapshot.text === "string"
    ? {
        authorDisplayName: typeof snapshot.authorDisplayName === "string"
          ? snapshot.authorDisplayName
          : null,
        createdAt: snapshot.createdAt,
        messageId: snapshot.messageId,
        role: sourceRole,
        text: snapshot.text
      }
    : null;
  return {
    createdAt: proposal.createdAt.toISOString(),
    id: proposal.id,
    proposedByDisplayName: proposal.proposedByDisplayName,
    proposedText: proposal.proposedText,
    resultingFactId: proposal.resultingFactId,
    reviewedAt: proposal.reviewedAt?.toISOString() ?? null,
    source,
    sourceMessageId: proposal.sourceMessageId,
    state: proposal.state
  };
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
}

type ProjectMemorySource = Readonly<{
  messageId: string | null;
  role: string | null;
  snapshot: Prisma.InputJsonObject;
}>;

async function projectMemorySource(
  tx: Prisma.TransactionClient,
  projectId: string,
  messageId: string | null
): Promise<ProjectMemorySource | null> {
  if (!messageId) return { messageId: null, role: null, snapshot: {} };
  const row = await tx.message.findFirst({
    select: {
      authorDisplayName: true,
      content: true,
      createdAt: true,
      id: true,
      role: true
    },
    where: { chat: { projectId }, id: messageId }
  });
  if (!row) return null;
  const content = typeof row.content === "object" && row.content !== null && !Array.isArray(row.content)
    ? textFromContentBlocks(row.content as { blocks?: unknown[] }).slice(0, 4_000)
    : "";
  return {
    messageId: row.id,
    role: row.role,
    snapshot: {
      ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
      createdAt: row.createdAt.toISOString(),
      messageId: row.id,
      role: row.role,
      text: content
    }
  };
}

export function createPrismaProjectMemoryRepository(prisma: PrismaClient) {
  const factInclude = {
    currentVersion: { select: { createdAt: true, id: true, text: true, validUntil: true, versionNumber: true } }
  } satisfies Prisma.ProjectMemoryFactInclude;
  const proposalSelect = {
    createdAt: true,
    id: true,
    proposedByDisplayName: true,
    proposedText: true,
    resultingFactId: true,
    reviewedAt: true,
    sourceMessageId: true,
    sourceSnapshot: true,
    state: true
  } satisfies Prisma.ProjectMemoryProposalSelect;

  async function list(userId: string, projectId: string): Promise<ProjectMemoryResponseWire | null> {
    const access = await resolveProjectAccess(prisma, { projectId, userId });
    if (!access) return null;
    const project = await prisma.project.findUnique({
      select: { memoryEnabled: true, memoryRevision: true },
      where: { id: projectId }
    });
    if (!project) return null;
    const [facts, proposals] = await Promise.all([
      prisma.projectMemoryFact.findMany({
        include: factInclude,
        orderBy: { updatedAt: "desc" },
        where: { projectId, state: { not: "FORGOTTEN" } }
      }),
      access.effectiveRole === "MANAGER" || access.effectiveRole === "OWNER"
        ? prisma.projectMemoryProposal.findMany({
            orderBy: { createdAt: "desc" },
            select: proposalSelect,
            where: { projectId, state: "PENDING" }
          })
        : Promise.resolve([])
    ]);
    return {
      enabled: project.memoryEnabled,
      facts: facts.flatMap((fact) => {
        const value = factWire(fact);
        return value ? [value] : [];
      }),
      proposals: proposals.map(proposalWire),
      revision: project.memoryRevision
    };
  }

  async function createFact(input: {
    actorDisplayName: string;
    projectId: string;
    sourceMessageId?: string | null;
    text: string;
    validUntil?: Date | null;
    userId: string;
  }): Promise<ProjectRepositoryResult<ProjectMemoryFactWire>> {
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
        const project = await tx.project.findUnique({ select: { memoryEnabled: true }, where: { id: input.projectId } });
        if (!project?.memoryEnabled) return { kind: "conflict" as const, reason: "project_memory_disabled" };
        const source = await projectMemorySource(tx, input.projectId, input.sourceMessageId ?? null);
        if (!source) return { kind: "not_found" as const };
        const factId = randomUUID();
        const versionId = randomUUID();
        await tx.projectMemoryFact.create({
          data: {
            createdByDisplayName: input.actorDisplayName,
            createdByUserId: input.userId,
            id: factId,
            projectId: input.projectId
          }
        });
        await tx.projectMemoryFactVersion.create({
          data: {
            createdByDisplayName: input.actorDisplayName,
            createdByUserId: input.userId,
            factId,
            id: versionId,
            normalizedText: normalizeText(input.text),
            projectId: input.projectId,
            sourceMessageId: source.messageId,
            sourceSnapshot: source.snapshot,
            text: input.text,
            validUntil: input.validUntil ?? null,
            versionNumber: 1
          }
        });
        await tx.projectMemoryFact.update({
          data: { currentVersionId: versionId },
          where: { projectId_id: { id: factId, projectId: input.projectId } }
        });
        await tx.project.update({ data: { memoryRevision: { increment: 1 } }, where: { id: input.projectId } });
        await tx.projectAuditEvent.create({
          data: audit({
            actorDisplayName: input.actorDisplayName,
            actorUserId: input.userId,
            eventType: "memory_fact_created",
            metadata: { factId, revision: 1 },
            projectId: input.projectId
          })
        });
        const fact = await tx.projectMemoryFact.findUniqueOrThrow({ include: factInclude, where: { projectId_id: { id: factId, projectId: input.projectId } } });
        const value = factWire(fact);
        return value ? { kind: "ok" as const, value } : { kind: "conflict" as const, reason: "memory_fact_invalid" };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (knownConflict(error)) return { kind: "conflict", reason: "memory_fact_conflict" };
      throw error;
    }
  }

  return {
    list,
    createFact,
    async propose(input: {
      actorDisplayName: string;
      projectId: string;
      sourceMessageId?: string | null;
      text: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectMemoryProposalWire>> {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockProject(tx, input.projectId);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "CONTRIBUTOR",
            projectId: input.projectId,
            requireActive: true,
            userId: input.userId
          });
          if (!access) return { kind: "not_found" as const };
          const source = await projectMemorySource(tx, input.projectId, input.sourceMessageId ?? null);
          if (!source?.messageId || source.role !== "user") {
            return { kind: "not_found" as const };
          }
          const project = await tx.project.findUnique({ select: { memoryEnabled: true }, where: { id: input.projectId } });
          if (!project?.memoryEnabled) return { kind: "conflict" as const, reason: "project_memory_disabled" };
          const proposal = await tx.projectMemoryProposal.create({
            data: {
              proposedByDisplayName: input.actorDisplayName,
              proposedByUserId: input.userId,
              proposedText: input.text,
              normalizedText: normalizeText(input.text),
              projectId: input.projectId,
              sourceMessageId: source.messageId,
              sourceSnapshot: source.snapshot
            },
            select: proposalSelect
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "memory_proposal_created",
              metadata: { proposalId: proposal.id },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: proposalWire(proposal) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "memory_proposal_conflict" };
        throw error;
      }
    },
    async reviewProposal(input: {
      actorDisplayName: string;
      approve: boolean;
      projectId: string;
      proposalId: string;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectMemoryProposalWire>> {
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
          const proposal = await tx.projectMemoryProposal.findFirst({
            select: {
              id: true,
              proposedByDisplayName: true,
              proposedByUserId: true,
              proposedText: true,
              sourceMessageId: true,
              sourceSnapshot: true,
              state: true
            },
            where: { id: input.proposalId, projectId: input.projectId }
          });
          if (!proposal) return { kind: "not_found" as const };
          if (proposal.state !== "PENDING") return { kind: "conflict" as const, reason: "memory_proposal_already_reviewed" };
          let resultingFactId: string | null = null;
          if (input.approve) {
            const existingVersion = await tx.projectMemoryFactVersion.findFirst({
              select: { fact: { select: { id: true, state: true } } },
              where: {
                fact: { projectId: input.projectId, state: "ACTIVE" },
                normalizedText: normalizeText(proposal.proposedText),
                projectId: input.projectId
              }
            });
            const existing = existingVersion?.fact ?? null;
            if (existing) {
              resultingFactId = existing.id;
            } else {
              const created = await createFactInTransaction(tx, {
                actorDisplayName: proposal.proposedByDisplayName,
                actorUserId: proposal.proposedByUserId,
                projectId: input.projectId,
                sourceMessageId: proposal.sourceMessageId,
                sourceSnapshot: proposal.sourceSnapshot as Prisma.InputJsonValue,
                text: proposal.proposedText
              });
              resultingFactId = created;
            }
            await tx.project.update({ data: { memoryRevision: { increment: 1 } }, where: { id: input.projectId } });
          }
          const updated = await tx.projectMemoryProposal.update({
            data: {
              resultingFactId,
              reviewedAt: new Date(),
              reviewedByDisplayName: input.actorDisplayName,
              reviewedByUserId: input.userId,
              state: input.approve ? "APPROVED" : "REJECTED"
            },
            select: proposalSelect,
            where: { id: input.proposalId }
          });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: input.approve ? "memory_proposal_approved" : "memory_proposal_rejected",
              metadata: { proposalId: input.proposalId, resultingFactId },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: proposalWire(updated) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "memory_proposal_conflict" };
        throw error;
      }
    },
    async editFact(input: {
      actorDisplayName: string;
      factId: string;
      projectId: string;
      sourceMessageId?: string | null;
      text: string;
      validUntil?: Date | null;
      userId: string;
    }): Promise<ProjectRepositoryResult<ProjectMemoryFactWire>> {
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
          const source = await projectMemorySource(tx, input.projectId, input.sourceMessageId ?? null);
          if (!source) return { kind: "not_found" as const };
          const current = await tx.projectMemoryFact.findUnique({
            include: factInclude,
            where: { projectId_id: { id: input.factId, projectId: input.projectId } }
          });
          if (!current || current.state === "FORGOTTEN" || !current.currentVersion) return { kind: "not_found" as const };
          const versionNumber = current.currentVersion.versionNumber + 1;
          const versionId = randomUUID();
          await tx.projectMemoryFactVersion.create({
            data: {
              createdByDisplayName: input.actorDisplayName,
              createdByUserId: input.userId,
              factId: input.factId,
              id: versionId,
              normalizedText: normalizeText(input.text),
              projectId: input.projectId,
              sourceMessageId: source.messageId,
              sourceSnapshot: source.snapshot,
              text: input.text,
              validUntil: input.validUntil === undefined
                ? current.currentVersion.validUntil
                : input.validUntil,
              versionNumber
            }
          });
          await tx.projectMemoryFact.update({
            data: { currentVersionId: versionId, state: "ACTIVE" },
            where: { projectId_id: { id: input.factId, projectId: input.projectId } }
          });
          await tx.project.update({ data: { memoryRevision: { increment: 1 } }, where: { id: input.projectId } });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "memory_fact_edited",
              metadata: { factId: input.factId, versionNumber },
              projectId: input.projectId
            })
          });
          const fact = await tx.projectMemoryFact.findUniqueOrThrow({ include: factInclude, where: { projectId_id: { id: input.factId, projectId: input.projectId } } });
          const value = factWire(fact);
          return value ? { kind: "ok" as const, value } : { kind: "conflict" as const, reason: "memory_fact_invalid" };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "memory_fact_conflict" };
        throw error;
      }
    },
    async forgetFact(input: {
      actorDisplayName: string;
      factId: string;
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
          const updated = await tx.projectMemoryFact.updateMany({
            data: { currentVersionId: null, state: "FORGOTTEN" },
            where: { id: input.factId, projectId: input.projectId, state: "ACTIVE" }
          });
          if (updated.count !== 1) return { kind: "not_found" as const };
          await tx.project.update({ data: { memoryRevision: { increment: 1 } }, where: { id: input.projectId } });
          await tx.projectAuditEvent.create({
            data: audit({
              actorDisplayName: input.actorDisplayName,
              actorUserId: input.userId,
              eventType: "memory_fact_forgotten",
              metadata: { factId: input.factId },
              projectId: input.projectId
            })
          });
          return { kind: "ok" as const, value: { id: input.factId } };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (knownConflict(error)) return { kind: "conflict", reason: "memory_fact_conflict" };
        throw error;
      }
    }
  };
}

async function createFactInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    actorDisplayName: string;
    actorUserId: string | null;
    projectId: string;
    sourceMessageId: string | null;
    sourceSnapshot: Prisma.InputJsonValue;
    text: string;
  }
): Promise<string> {
  const factId = randomUUID();
  const versionId = randomUUID();
  await tx.projectMemoryFact.create({
    data: {
      createdByDisplayName: input.actorDisplayName,
      createdByUserId: input.actorUserId,
      id: factId,
      projectId: input.projectId
    }
  });
  await tx.projectMemoryFactVersion.create({
    data: {
      createdByDisplayName: input.actorDisplayName,
      createdByUserId: input.actorUserId,
      factId,
      id: versionId,
      normalizedText: normalizeText(input.text),
      projectId: input.projectId,
      sourceMessageId: input.sourceMessageId,
      sourceSnapshot: input.sourceSnapshot,
      text: input.text,
      versionNumber: 1
    }
  });
  await tx.projectMemoryFact.update({
    data: { currentVersionId: versionId },
    where: { projectId_id: { id: factId, projectId: input.projectId } }
  });
  return factId;
}

export type ReturnTypeOfProjectMemoryRepository = ReturnType<typeof createPrismaProjectMemoryRepository>;

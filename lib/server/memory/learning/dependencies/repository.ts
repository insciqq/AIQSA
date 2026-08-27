import { Prisma } from "@prisma/client";
import { textFromContentBlocks } from "../../../../domain/modelRunEvents";
import { projectMemoryHistorySafeText } from "../../history/safety";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTransaction } from "../../persistence/transaction";
import type { MemoryFactCandidateDependency } from "../extraction/contract";

export function memoryFactDependenciesPredicate(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`
): Prisma.Sql {
  return Prisma.sql`aiqsa_memory_fact_dependencies_valid(
    ${userId},
    ${factVersionId}
  )`;
}

async function validateMessageDependency(
  tx: MemoryTransaction,
  userId: string,
  dependency: MemoryFactCandidateDependency
): Promise<void> {
  if (dependency.source.messageId === null ||
    dependency.source.contentHash === null ||
    dependency.source.messageUpdatedAt === null ||
    dependency.source.projectionVersion === null) {
    throw new Error("memory_dependency_source_invalid");
  }
  const message = await tx.message.findFirst({
    select: { content: true, updatedAt: true },
    where: {
      chat: {
        memoryMode: "NORMAL",
        permanentDeletionAt: null,
        projectId: null,
        userId
      },
      id: dependency.source.messageId,
      role: { in: ["user", "assistant"] },
      status: "complete"
    }
  });
  if (!message || message.updatedAt.toISOString() !==
    dependency.source.messageUpdatedAt) {
    throw new Error("memory_dependency_source_stale");
  }
  const projected = projectMemoryHistorySafeText(textFromContentBlocks(
    message.content as { blocks?: unknown[] }
  ));
  if (!projected.eligible || !projected.providerSafeText ||
    memorySha256(projected.providerSafeText) !== dependency.source.contentHash) {
    throw new Error("memory_dependency_source_stale");
  }
  const [valid] = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT aiqsa_memory_message_dependency_valid(
      ${userId},
      ${dependency.source.messageId},
      ${new Date(dependency.source.messageUpdatedAt)}::timestamp(3)
    ) AS valid
  `);
  if (valid?.valid !== true) throw new Error("memory_dependency_source_stale");
}

async function validateFactDependency(
  tx: MemoryTransaction,
  userId: string,
  targetFactVersionId: string,
  dependency: MemoryFactCandidateDependency
): Promise<void> {
  const sourceFactVersionId = dependency.source.factVersionId;
  if (!sourceFactVersionId || sourceFactVersionId === targetFactVersionId) {
    throw new Error("memory_dependency_source_invalid");
  }
  const [valid] = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT (
      aiqsa_memory_dependency_source_version_valid(
        ${userId},
        ${sourceFactVersionId}
      )
      AND aiqsa_memory_fact_dependencies_valid(
        ${userId},
        ${sourceFactVersionId}
      )
    ) AS valid
  `);
  if (valid?.valid !== true) throw new Error("memory_dependency_source_stale");
}

export async function memoryFactDependenciesAreValid(
  tx: MemoryTransaction,
  userId: string,
  targetFactVersionId: string,
  dependencies: readonly MemoryFactCandidateDependency[]
): Promise<boolean> {
  try {
    for (const dependency of dependencies) {
      if (dependency.source.messageId !== null) {
        await validateMessageDependency(tx, userId, dependency);
      } else {
        await validateFactDependency(
          tx,
          userId,
          targetFactVersionId,
          dependency
        );
      }
    }
    return true;
  } catch (error) {
    if (error instanceof Error && (
      error.message === "memory_dependency_source_invalid" ||
      error.message === "memory_dependency_source_stale"
    )) return false;
    throw error;
  }
}

export async function persistMemoryFactDependencies(
  tx: MemoryTransaction,
  userId: string,
  targetFactVersionId: string,
  dependencies: readonly MemoryFactCandidateDependency[]
): Promise<void> {
  const ordered = [...dependencies].sort((left, right) =>
    `${left.dependencyKind}:${left.ref}`.localeCompare(
      `${right.dependencyKind}:${right.ref}`
    ));
  if (!await memoryFactDependenciesAreValid(
    tx,
    userId,
    targetFactVersionId,
    ordered
  )) {
    throw new Error("memory_dependency_source_stale");
  }
  if (ordered.length === 0) return;
  const records = ordered.map((dependency) => ({
    dependencyKind: dependency.dependencyKind,
    id: memorySha256({
      dependencyKind: dependency.dependencyKind,
      domain: "aiqsa.memory.fact-source-dependency",
      sourceFactVersionId: dependency.source.factVersionId,
      sourceMessageId: dependency.source.messageId,
      targetFactVersionId,
      userId,
      version: 1
    }),
    sourceFactVersionId: dependency.source.factVersionId,
    sourceMessageContentHash: dependency.source.contentHash,
    sourceMessageId: dependency.source.messageId,
    sourceMessageUpdatedAt: dependency.source.messageUpdatedAt
      ? new Date(dependency.source.messageUpdatedAt)
      : null,
    sourceProjectionVersion: dependency.source.projectionVersion,
    targetFactVersionId,
    userId
  }));
  await tx.memoryFactVersionSourceDependency.createMany({
    data: records,
    skipDuplicates: true
  });
  const ids = await tx.memoryFactVersionSourceDependency.findMany({
    select: { id: true },
    where: {
      id: { in: records.map(({ id }) => id) },
      targetFactVersionId,
      userId
    }
  });
  if (ids.length !== records.length) {
    throw new Error("memory_dependency_commit_incomplete");
  }
}

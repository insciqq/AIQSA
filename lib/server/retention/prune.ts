import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@/lib/server/uploads/storage";

export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const DEFAULT_ORPHAN_ATTACHMENT_RETENTION_DAYS = 7;
export const DEFAULT_AUTH_RETENTION_DAYS = 30;
export const DEFAULT_KNOWLEDGE_PAYLOAD_RETENTION_DAYS = 30;
export const DEFAULT_PRUNE_BATCH_SIZE = 1000;
export const DEFAULT_DELETION_JOB_LEASE_MINUTES = 15;

export const TERMINAL_MODEL_RUN_STATUSES = ["cancelled", "complete", "error"] as const;

export type ModelRunEventPruneCandidate = {
  createdAt: Date;
  modelRunStatus: string;
};

export type AttachmentPruneCandidate = {
  createdAt: Date;
  messageId: string | null;
};

export type AttachmentDeletionClaim = {
  claimToken: string;
  id: string;
  storageKey: string;
};

export type AttachmentInspection = {
  matched: number;
  shared: number;
};

export type AttachmentStageResult = {
  jobsStaged: number;
  matched: number;
  rowsDeleted: number;
  sharedRowsDeleted: number;
};

export type KnowledgePayloadInspection = {
  matched: number;
  objects: number;
};

export type KnowledgePayloadStageResult = {
  jobsStaged: number;
  matched: number;
  objectsReleased: number;
  sharedObjects: number;
  versionsPurged: number;
};

export type RetentionRepository = {
  claimAttachmentDeletionJobs(input: {
    claimableBefore: Date;
    limit: number;
    now: Date;
  }): Promise<AttachmentDeletionClaim[]>;
  completeAttachmentDeletionJob(input: { claimToken: string; id: string }): Promise<boolean>;
  deleteAuthFlowTokens(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deleteAuthSessions(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deleteModelRunEvents(ids: string[]): Promise<number>;
  findClaimableAttachmentDeletionJobIds(input: {
    claimableBefore: Date;
    limit: number;
  }): Promise<string[]>;
  findPrunableAuthFlowTokenIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableAuthSessionIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableModelRunEventIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  inspectOrphanedAttachments(input: { cutoff: Date; limit: number }): Promise<AttachmentInspection>;
  inspectStaleKnowledgePayloads(input: {
    cutoff: Date;
    limit: number;
  }): Promise<KnowledgePayloadInspection>;
  releaseAttachmentDeletionJob(input: {
    claimToken: string;
    errorCode: "object_delete_failed";
    id: string;
    now: Date;
  }): Promise<boolean>;
  stageOrphanedAttachments(input: {
    cutoff: Date;
    limit: number;
  }): Promise<AttachmentStageResult>;
  stageStaleKnowledgePayloads(input: {
    cutoff: Date;
    limit: number;
    now: Date;
  }): Promise<KnowledgePayloadStageResult>;
};

export type PruneRetentionOptions = {
  authRetentionDays?: number;
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  dryRun?: boolean;
  eventRetentionDays?: number;
  knowledgePayloadRetentionDays?: number;
  now?: Date;
  orphanAttachmentRetentionDays?: number;
  repository: RetentionRepository;
  storage: Pick<StorageAdapter, "deleteObject">;
};

type RetentionCount = {
  deleted: number;
  matched: number;
};

export type PruneRetentionSummary = {
  attachmentDeletionJobs: {
    claimed: number;
    completed: number;
    failedJobs: {
      code: "object_delete_failed";
      id: string;
    }[];
    matched: number;
    objectsDeleted: number;
  };
  authCutoff: string;
  authFlowTokens: RetentionCount;
  authSessions: RetentionCount;
  dryRun: boolean;
  eventCutoff: string;
  knowledgePayloadCutoff: string;
  knowledgePayloads: {
    jobsStaged: number;
    matched: number;
    objects: number;
    objectsReleased: number;
    sharedObjects: number;
    versionsPurged: number;
  };
  modelRunEvents: RetentionCount;
  orphanAttachmentCutoff: string;
  orphanedAttachments: {
    jobsStaged: number;
    matched: number;
    rowsDeleted: number;
    shared: number;
  };
};

type LockedAttachment = {
  createdAt: Date;
  id: string;
  messageId: string | null;
};

function cutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function deletionJobClaimableBefore(now: Date, leaseMinutes: number): Date {
  return new Date(now.getTime() - leaseMinutes * 60 * 1000);
}

function prunableAuthSessionWhere(cutoff: Date): Prisma.AuthSessionWhereInput {
  return {
    OR: [
      {
        revokedAt: {
          lt: cutoff
        }
      },
      {
        expiresAt: {
          lt: cutoff
        },
        revokedAt: null
      }
    ]
  };
}

function prunableAuthFlowTokenWhere(cutoff: Date): Prisma.AuthFlowTokenWhereInput {
  return {
    OR: [
      {
        consumedAt: {
          lt: cutoff
        }
      },
      {
        consumedAt: null,
        expiresAt: {
          lt: cutoff
        }
      }
    ]
  };
}

function staleKnowledgePayloadWhere(cutoff: Date): Prisma.KnowledgeDocumentVersionWhereInput {
  return {
    currentFor: null,
    ingestCompletedAt: { lt: cutoff },
    ingestState: "failed",
    originalStorageKey: { not: null },
    payloadPurgedAt: null,
    visibleFromRevision: null
  };
}

export function shouldPruneModelRunEvent(candidate: ModelRunEventPruneCandidate, cutoff: Date): boolean {
  return (
    candidate.createdAt < cutoff &&
    TERMINAL_MODEL_RUN_STATUSES.includes(candidate.modelRunStatus as (typeof TERMINAL_MODEL_RUN_STATUSES)[number])
  );
}

export function shouldPruneOrphanedAttachment(candidate: AttachmentPruneCandidate, cutoff: Date): boolean {
  return candidate.messageId === null && candidate.createdAt < cutoff;
}

export function createPrismaRetentionRepository(prisma: PrismaClient): RetentionRepository {
  return {
    async claimAttachmentDeletionJobs({ claimableBefore, limit, now }) {
      const claimToken = randomUUID();
      const rows = await prisma.$transaction((tx) =>
        tx.$queryRaw<Array<{ id: string; storageKey: string }>>`
          WITH candidates AS (
            SELECT job."id"
            FROM "AttachmentDeletionJob" AS job
            WHERE (job."claimedAt" IS NULL OR job."claimedAt" < ${claimableBefore})
              AND NOT EXISTS (
                SELECT 1 FROM "Attachment" AS attachment
                WHERE attachment."storageKey" = job."storageKey"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeDocumentVersion" AS version
                WHERE version."originalStorageKey" = job."storageKey"
                  OR version."normalizedTextStorageKey" = job."storageKey"
              )
            ORDER BY job."createdAt", job."id"
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE "AttachmentDeletionJob" AS job
          SET
            "attemptCount" = job."attemptCount" + 1,
            "claimedAt" = ${now},
            "claimToken" = ${claimToken},
            "lastAttemptAt" = ${now},
            "lastErrorCode" = NULL,
            "updatedAt" = ${now}
          FROM candidates
          WHERE job."id" = candidates."id"
          RETURNING job."id", job."storageKey"
        `
      );

      return rows.map((row) => ({
        claimToken,
        id: row.id,
        storageKey: row.storageKey
      }));
    },
    async completeAttachmentDeletionJob(input) {
      const deleted = await prisma.attachmentDeletionJob.deleteMany({
        where: {
          claimToken: input.claimToken,
          id: input.id
        }
      });

      return deleted.count === 1;
    },
    async deleteAuthFlowTokens({ cutoff, ids }) {
      if (ids.length === 0) {
        return 0;
      }

      const deleted = await prisma.authFlowToken.deleteMany({
        where: {
          ...prunableAuthFlowTokenWhere(cutoff),
          id: {
            in: ids
          }
        }
      });

      return deleted.count;
    },
    async deleteAuthSessions({ cutoff, ids }) {
      if (ids.length === 0) {
        return 0;
      }

      const deleted = await prisma.authSession.deleteMany({
        where: {
          ...prunableAuthSessionWhere(cutoff),
          id: {
            in: ids
          }
        }
      });

      return deleted.count;
    },
    async deleteModelRunEvents(ids) {
      if (ids.length === 0) {
        return 0;
      }

      const result = await prisma.modelRunEvent.deleteMany({
        where: {
          id: {
            in: ids
          },
          modelRun: {
            status: {
              in: [...TERMINAL_MODEL_RUN_STATUSES]
            }
          }
        }
      });

      return result.count;
    },
    async findClaimableAttachmentDeletionJobIds({ claimableBefore, limit }) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT job."id"
        FROM "AttachmentDeletionJob" AS job
        WHERE (job."claimedAt" IS NULL OR job."claimedAt" < ${claimableBefore})
          AND NOT EXISTS (
            SELECT 1 FROM "Attachment" AS attachment
            WHERE attachment."storageKey" = job."storageKey"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeDocumentVersion" AS version
            WHERE version."originalStorageKey" = job."storageKey"
              OR version."normalizedTextStorageKey" = job."storageKey"
          )
        ORDER BY job."createdAt", job."id"
        LIMIT ${limit}
      `;

      return rows.map((row) => row.id);
    },
    async findPrunableAuthFlowTokenIds({ cutoff, limit }) {
      const rows = await prisma.authFlowToken.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: prunableAuthFlowTokenWhere(cutoff)
      });

      return rows.map((row) => row.id);
    },
    async findPrunableAuthSessionIds({ cutoff, limit }) {
      const rows = await prisma.authSession.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: prunableAuthSessionWhere(cutoff)
      });

      return rows.map((row) => row.id);
    },
    async findPrunableModelRunEventIds({ cutoff, limit }) {
      const rows = await prisma.modelRunEvent.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: {
          createdAt: {
            lt: cutoff
          },
          modelRun: {
            status: {
              in: [...TERMINAL_MODEL_RUN_STATUSES]
            }
          }
        }
      });

      return rows.map((row) => row.id);
    },
    async inspectOrphanedAttachments({ cutoff, limit }) {
      const candidates = await prisma.attachment.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          storageKey: true
        },
        take: limit,
        where: {
          createdAt: {
            lt: cutoff
          },
          messageId: null
        }
      });

      if (candidates.length === 0) {
        return { matched: 0, shared: 0 };
      }

      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      const storageKeys = [...new Set(candidates.map((candidate) => candidate.storageKey))];
      const references = await prisma.attachment.findMany({
        select: {
          id: true,
          storageKey: true
        },
        where: {
          storageKey: {
            in: storageKeys
          }
        }
      });
      const sharedKeys = new Set(
        references.filter((reference) => !candidateIds.has(reference.id)).map((reference) => reference.storageKey)
      );
      const knowledgeReferences = await prisma.knowledgeDocumentVersion.findMany({
        select: { normalizedTextStorageKey: true, originalStorageKey: true },
        where: {
          OR: [
            { normalizedTextStorageKey: { in: storageKeys } },
            { originalStorageKey: { in: storageKeys } }
          ]
        }
      });
      for (const reference of knowledgeReferences) {
        if (reference.originalStorageKey) sharedKeys.add(reference.originalStorageKey);
        if (reference.normalizedTextStorageKey) sharedKeys.add(reference.normalizedTextStorageKey);
      }

      return {
        matched: candidates.length,
        shared: candidates.filter((candidate) => sharedKeys.has(candidate.storageKey)).length
      };
    },
    async inspectStaleKnowledgePayloads({ cutoff, limit }) {
      const candidates = await prisma.knowledgeDocumentVersion.findMany({
        orderBy: [{ ingestCompletedAt: "asc" }, { id: "asc" }],
        select: { normalizedTextStorageKey: true, originalStorageKey: true },
        take: limit,
        where: staleKnowledgePayloadWhere(cutoff)
      });
      return {
        matched: candidates.length,
        objects: new Set(candidates.flatMap((candidate) => [
          ...(candidate.originalStorageKey ? [candidate.originalStorageKey] : []),
          ...(candidate.normalizedTextStorageKey ? [candidate.normalizedTextStorageKey] : [])
        ])).size
      };
    },
    async releaseAttachmentDeletionJob(input) {
      const released = await prisma.attachmentDeletionJob.updateMany({
        data: {
          claimedAt: null,
          claimToken: null,
          lastAttemptAt: input.now,
          lastErrorCode: input.errorCode
        },
        where: {
          claimToken: input.claimToken,
          id: input.id
        }
      });

      return released.count === 1;
    },
    async stageOrphanedAttachments({ cutoff, limit }) {
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.attachment.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            storageKey: true
          },
          take: limit,
          where: {
            createdAt: {
              lt: cutoff
            },
            messageId: null
          }
        });
        const candidatesByStorageKey = new Map<string, Set<string>>();

        for (const candidate of candidates) {
          const ids = candidatesByStorageKey.get(candidate.storageKey) ?? new Set<string>();
          ids.add(candidate.id);
          candidatesByStorageKey.set(candidate.storageKey, ids);
        }

        let jobsStaged = 0;
        let rowsDeleted = 0;
        let sharedRowsDeleted = 0;
        for (const storageKey of [...candidatesByStorageKey.keys()].sort()) {
          await tx.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 260))::text AS "lock"
          `;
          const references = await tx.$queryRaw<LockedAttachment[]>`
            SELECT "id", "messageId", "createdAt"
            FROM "Attachment"
            WHERE "storageKey" = ${storageKey}
            ORDER BY "id"
            FOR UPDATE
          `;
          const candidateIds = candidatesByStorageKey.get(storageKey) ?? new Set<string>();
          const deletableIds = references
            .filter(
              (reference) =>
                candidateIds.has(reference.id) &&
                reference.messageId === null &&
                reference.createdAt < cutoff
            )
            .map((reference) => reference.id);

          if (deletableIds.length === 0) {
            continue;
          }

          const remainingReferenceCount = references.length - deletableIds.length;
          const knowledgeReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "KnowledgeDocumentVersion"
            WHERE "originalStorageKey" = ${storageKey}
              OR "normalizedTextStorageKey" = ${storageKey}
            FOR SHARE
          `;
          if (remainingReferenceCount === 0 && knowledgeReferences.length === 0) {
            const existing = await tx.attachmentDeletionJob.findUnique({
              select: { id: true },
              where: { storageKey }
            });
            if (!existing) {
              await tx.attachmentDeletionJob.create({
                data: { storageKey }
              });
              jobsStaged += 1;
            }
          } else {
            sharedRowsDeleted += deletableIds.length;
          }

          const deleted = await tx.attachment.deleteMany({
            where: {
              createdAt: {
                lt: cutoff
              },
              id: {
                in: deletableIds
              },
              messageId: null
            }
          });
          rowsDeleted += deleted.count;
        }

        return {
          jobsStaged,
          matched: candidates.length,
          rowsDeleted,
          sharedRowsDeleted
        };
      });
    },
    async stageStaleKnowledgePayloads({ cutoff, limit, now }) {
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.knowledgeDocumentVersion.findMany({
          orderBy: [{ ingestCompletedAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            normalizedTextStorageKey: true,
            originalStorageKey: true
          },
          take: limit,
          where: staleKnowledgePayloadWhere(cutoff)
        });
        let jobsStaged = 0;
        let objectsReleased = 0;
        let sharedObjects = 0;
        let versionsPurged = 0;

        const candidateStorageKeys = [...new Set(candidates.flatMap((candidate) => [
          ...(candidate.originalStorageKey ? [candidate.originalStorageKey] : []),
          ...(candidate.normalizedTextStorageKey ? [candidate.normalizedTextStorageKey] : [])
        ]))].sort();
        for (const storageKey of candidateStorageKeys) {
          await tx.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 260))::text AS "lock"
          `;
        }

        for (const candidate of candidates) {
          const rows = await tx.$queryRaw<Array<{
            normalizedTextStorageKey: string | null;
            originalStorageKey: string | null;
          }>>`
            SELECT "originalStorageKey", "normalizedTextStorageKey"
            FROM "KnowledgeDocumentVersion"
            WHERE "id" = ${candidate.id}
              AND "ingestState" = 'failed'::"KnowledgeDocumentIngestState"
              AND "ingestCompletedAt" < ${cutoff}
              AND "visibleFromRevision" IS NULL
              AND "payloadPurgedAt" IS NULL
              AND "originalStorageKey" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeDocument" AS document
                WHERE document."currentVersionId" = "KnowledgeDocumentVersion"."id"
              )
            FOR UPDATE
          `;
          const version = rows[0];
          if (!version?.originalStorageKey) continue;
          const storageKeys = [...new Set([
            version.originalStorageKey,
            ...(version.normalizedTextStorageKey ? [version.normalizedTextStorageKey] : [])
          ])].sort();

          await tx.usageEvent.deleteMany({
            where: { knowledgeDocumentVersionId: candidate.id }
          });
          await tx.knowledgeChunk.deleteMany({
            where: { documentVersionId: candidate.id }
          });

          for (const storageKey of storageKeys) {
            const attachmentReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "Attachment"
              WHERE "storageKey" = ${storageKey}
              FOR SHARE
            `;
            const knowledgeReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "KnowledgeDocumentVersion"
              WHERE "id" <> ${candidate.id}
                AND ("originalStorageKey" = ${storageKey}
                  OR "normalizedTextStorageKey" = ${storageKey})
              FOR SHARE
            `;
            if (attachmentReferences.length === 0 && knowledgeReferences.length === 0) {
              const existing = await tx.attachmentDeletionJob.findUnique({
                select: { id: true },
                where: { storageKey }
              });
              if (!existing) {
                await tx.attachmentDeletionJob.create({ data: { storageKey } });
                jobsStaged += 1;
              }
            } else {
              sharedObjects += 1;
            }
            objectsReleased += 1;
          }

          await tx.knowledgeDocumentVersion.update({
            data: {
              ingestChunkCount: null,
              ingestEmbeddedChunkCount: 0,
              normalizedTextByteSize: null,
              normalizedTextChecksum: null,
              normalizedTextStorageKey: null,
              originalStorageKey: null,
              payloadPurgedAt: now
            },
            where: { id: candidate.id }
          });
          versionsPurged += 1;
        }

        return {
          jobsStaged,
          matched: candidates.length,
          objectsReleased,
          sharedObjects,
          versionsPurged
        };
      });
    }
  };
}

function emptySummary(input: {
  authCutoff: Date;
  authFlowTokenIds: string[];
  authSessionIds: string[];
  deletionJobIds: string[];
  dryRun: boolean;
  eventCutoff: Date;
  eventIds: string[];
  knowledgePayloadCutoff: Date;
  knowledgePayloadInspection: KnowledgePayloadInspection;
  orphanAttachmentCutoff: Date;
  orphanInspection: AttachmentInspection;
}): PruneRetentionSummary {
  return {
    attachmentDeletionJobs: {
      claimed: 0,
      completed: 0,
      failedJobs: [],
      matched: input.deletionJobIds.length,
      objectsDeleted: 0
    },
    authCutoff: input.authCutoff.toISOString(),
    authFlowTokens: {
      deleted: 0,
      matched: input.authFlowTokenIds.length
    },
    authSessions: {
      deleted: 0,
      matched: input.authSessionIds.length
    },
    dryRun: input.dryRun,
    eventCutoff: input.eventCutoff.toISOString(),
    knowledgePayloadCutoff: input.knowledgePayloadCutoff.toISOString(),
    knowledgePayloads: {
      jobsStaged: 0,
      matched: input.knowledgePayloadInspection.matched,
      objects: input.knowledgePayloadInspection.objects,
      objectsReleased: 0,
      sharedObjects: 0,
      versionsPurged: 0
    },
    modelRunEvents: {
      deleted: 0,
      matched: input.eventIds.length
    },
    orphanAttachmentCutoff: input.orphanAttachmentCutoff.toISOString(),
    orphanedAttachments: {
      jobsStaged: 0,
      matched: input.orphanInspection.matched,
      rowsDeleted: 0,
      shared: input.orphanInspection.shared
    }
  };
}

export async function pruneRetention(options: PruneRetentionOptions): Promise<PruneRetentionSummary> {
  const now = options.now ?? new Date();
  const batchSize = positiveInteger(options.batchSize, DEFAULT_PRUNE_BATCH_SIZE);
  const eventRetentionDays = positiveInteger(options.eventRetentionDays, DEFAULT_EVENT_RETENTION_DAYS);
  const orphanAttachmentRetentionDays = positiveInteger(
    options.orphanAttachmentRetentionDays,
    DEFAULT_ORPHAN_ATTACHMENT_RETENTION_DAYS
  );
  const authRetentionDays = positiveInteger(options.authRetentionDays, DEFAULT_AUTH_RETENTION_DAYS);
  const knowledgePayloadRetentionDays = positiveInteger(
    options.knowledgePayloadRetentionDays,
    DEFAULT_KNOWLEDGE_PAYLOAD_RETENTION_DAYS
  );
  const deletionJobLeaseMinutes = positiveInteger(
    options.deletionJobLeaseMinutes,
    DEFAULT_DELETION_JOB_LEASE_MINUTES
  );
  const dryRun = options.dryRun ?? true;
  const eventCutoff = cutoffDate(now, eventRetentionDays);
  const orphanAttachmentCutoff = cutoffDate(now, orphanAttachmentRetentionDays);
  const authCutoff = cutoffDate(now, authRetentionDays);
  const knowledgePayloadCutoff = cutoffDate(now, knowledgePayloadRetentionDays);
  const claimableBefore = deletionJobClaimableBefore(now, deletionJobLeaseMinutes);
  const [
    eventIds,
    orphanInspection,
    knowledgePayloadInspection,
    authSessionIds,
    authFlowTokenIds,
    initialDeletionJobIds
  ] = await Promise.all([
    options.repository.findPrunableModelRunEventIds({ cutoff: eventCutoff, limit: batchSize }),
    options.repository.inspectOrphanedAttachments({ cutoff: orphanAttachmentCutoff, limit: batchSize }),
    options.repository.inspectStaleKnowledgePayloads({ cutoff: knowledgePayloadCutoff, limit: batchSize }),
    options.repository.findPrunableAuthSessionIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableAuthFlowTokenIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findClaimableAttachmentDeletionJobIds({ claimableBefore, limit: batchSize })
  ]);
  const summary = emptySummary({
    authCutoff,
    authFlowTokenIds,
    authSessionIds,
    deletionJobIds: initialDeletionJobIds,
    dryRun,
    eventCutoff,
    eventIds,
    knowledgePayloadCutoff,
    knowledgePayloadInspection,
    orphanAttachmentCutoff,
    orphanInspection
  });

  if (dryRun) {
    return summary;
  }

  const [deletedEvents, deletedSessions, deletedFlowTokens] = await Promise.all([
    options.repository.deleteModelRunEvents(eventIds),
    options.repository.deleteAuthSessions({ cutoff: authCutoff, ids: authSessionIds }),
    options.repository.deleteAuthFlowTokens({ cutoff: authCutoff, ids: authFlowTokenIds })
  ]);
  // Both stages can touch the same private object key. Keep them sequential so
  // advisory-lock ordering cannot deadlock and the second stage observes the
  // first stage's released reference before deciding whether to queue deletion.
  const stagedAttachments = await options.repository.stageOrphanedAttachments({
    cutoff: orphanAttachmentCutoff,
    limit: batchSize
  });
  const stagedKnowledgePayloads = await options.repository.stageStaleKnowledgePayloads({
    cutoff: knowledgePayloadCutoff,
    limit: batchSize,
    now
  });
  const claimableDeletionJobIds = await options.repository.findClaimableAttachmentDeletionJobIds({
    claimableBefore,
    limit: batchSize
  });
  const claims = await options.repository.claimAttachmentDeletionJobs({
    claimableBefore,
    limit: batchSize,
    now
  });

  summary.modelRunEvents.deleted = deletedEvents;
  summary.authSessions.deleted = deletedSessions;
  summary.authFlowTokens.deleted = deletedFlowTokens;
  summary.knowledgePayloads = {
    jobsStaged: stagedKnowledgePayloads.jobsStaged,
    matched: stagedKnowledgePayloads.matched,
    objects: knowledgePayloadInspection.objects,
    objectsReleased: stagedKnowledgePayloads.objectsReleased,
    sharedObjects: stagedKnowledgePayloads.sharedObjects,
    versionsPurged: stagedKnowledgePayloads.versionsPurged
  };
  summary.orphanedAttachments = {
    jobsStaged: stagedAttachments.jobsStaged,
    matched: stagedAttachments.matched,
    rowsDeleted: stagedAttachments.rowsDeleted,
    shared: stagedAttachments.sharedRowsDeleted
  };
  summary.attachmentDeletionJobs.matched = claimableDeletionJobIds.length;
  summary.attachmentDeletionJobs.claimed = claims.length;

  for (const claim of claims) {
    try {
      await options.storage.deleteObject(claim.storageKey);
      summary.attachmentDeletionJobs.objectsDeleted += 1;
      if (
        await options.repository.completeAttachmentDeletionJob({
          claimToken: claim.claimToken,
          id: claim.id
        })
      ) {
        summary.attachmentDeletionJobs.completed += 1;
      }
    } catch {
      summary.attachmentDeletionJobs.failedJobs.push({
        code: "object_delete_failed",
        id: claim.id
      });
      await options.repository.releaseAttachmentDeletionJob({
        claimToken: claim.claimToken,
        errorCode: "object_delete_failed",
        id: claim.id,
        now
      });
    }
  }

  return summary;
}

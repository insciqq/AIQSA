import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeKnowledgeCitationHandle,
  decodeKnowledgePlan,
  explicitKnowledgeSelection
} from "../../contracts/knowledge";
import { prisma } from "../prisma";
import {
  loadKnowledgeEvidencePackage
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";

export const DEFAULT_KNOWLEDGE_DELETION_BATCH_SIZE = 25;
export const DEFAULT_KNOWLEDGE_DELETION_LEASE_MINUTES = 15;

export type KnowledgeDeletionClaim = Readonly<{
  claimToken: string;
  id: string;
  ownerUserId: string;
  targetId: string;
  targetType: "BASE" | "SOURCE";
}>;

export type KnowledgeDeletionDrainSummary = Readonly<{
  blocked: number;
  claimed: number;
  completed: number;
  failed: number;
  waitingForObjects: number;
}>;

type KnowledgeRunRow = Readonly<{
  baseEvidence: unknown;
  chatId: string;
  id: string;
  modelRunId: string;
  modelRunToolCallId: string;
  results: unknown;
}>;

type ProcessResult = "blocked" | "completed" | "waiting_for_objects";

type KnowledgeDeletionStorageObject = Readonly<{
  multipartUploadId?: string | null;
  storageKey: string;
}>;

class KnowledgeDeletionInvariantError extends Error {
  constructor() {
    super("knowledge_deletion_invariant_failed");
    this.name = "KnowledgeDeletionInvariantError";
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function tombstoneResults(
  value: unknown,
  matches: (entry: Record<string, unknown>) => boolean
): Readonly<{ changed: boolean; results: unknown[] }> {
  if (!Array.isArray(value)) return { changed: false, results: [] };
  let changed = false;
  const results = value.map((entry) => {
    if (!isRecord(entry) || !matches(entry)) return entry;
    const handle = decodeKnowledgeCitationHandle(entry.handle)?.handle ?? null;
    changed = true;
    return handle ? { deleted: true, handle } : { deleted: true };
  });
  return { changed, results };
}

function providerTextForTombstonedResults(results: readonly unknown[]): string {
  const passages = results.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.handle !== "string") return [];
    if (entry.deleted === true) return [`[${entry.handle}] Deleted Knowledge source.`];
    const page = Number.isSafeInteger(entry.page) ? ` page ${String(entry.page)}` : "";
    const text = typeof entry.includedText === "string" ? entry.includedText : "";
    return [`[${entry.handle}]${page}${text ? `\n${text}` : ""}`];
  });
  return passages.length > 0
    ? ["Knowledge passages:", ...passages].join("\n\n")
    : "Knowledge citation evidence was deleted.";
}

function withoutBaseEvidence(value: unknown, knowledgeBaseId: string): unknown[] {
  const retained = Array.isArray(value)
    ? value.filter((entry) => !isRecord(entry) || entry.knowledgeBaseId !== knowledgeBaseId)
    : [];
  return retained.length > 0 ? retained : [{ deleted: true }];
}

function redactIdentifier(value: unknown, identifier: string): unknown {
  if (value === identifier) return "deleted_knowledge_base";
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== identifier)
      .map((entry) => redactIdentifier(entry, identifier));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (entry === identifier && /(?:knowledge)?baseid$/iu.test(key)) return [];
    return [[key, redactIdentifier(entry, identifier)]];
  }));
}

function scrubRunNormalizedRequest(value: unknown, knowledgeBaseId: string): unknown {
  const redacted = redactIdentifier(value, knowledgeBaseId);
  if (!isRecord(value) || !Object.hasOwn(value, "knowledgePlan") || !isRecord(redacted)) {
    return redacted;
  }
  return {
    ...redacted,
    knowledgePlan: selectionWithoutResource(value.knowledgePlan, knowledgeBaseId, "base")
  };
}

async function tombstoneEvidenceItems(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    documentVersionIds?: readonly string[];
    resourceId: string;
    resourceType: "base" | "source";
  }>
): Promise<void> {
  const where: Prisma.KnowledgeEvidenceItemWhereInput = input.resourceType === "base"
    ? { knowledgeBaseId: input.resourceId }
    : {
        OR: [
          { sourceId: input.resourceId },
          ...((input.documentVersionIds?.length ?? 0) > 0
            ? [{ documentVersionId: { in: [...input.documentVersionIds!] } }]
            : [])
        ]
      };
  const rows = await tx.knowledgeEvidenceItem.findMany({
    select: { id: true, retrievalSessionId: true },
    where
  });
  if (rows.length === 0) return;
  await tx.knowledgeRunEvidence.deleteMany({
    where: { evidenceItemId: { in: rows.map(({ id }) => id) } }
  });
  await tx.knowledgeEvidenceItem.updateMany({
    data: {
      baseName: null,
      contentHash: null,
      contextBoundaries: Prisma.DbNull,
      documentId: null,
      documentVersionId: null,
      evidenceKey: null,
      excerpt: null,
      excerptBytes: null,
      fileName: null,
      headingPath: [],
      knowledgeBaseId: null,
      locator: Prisma.DbNull,
      page: null,
      passageId: null,
      sectionId: null,
      sourceArtifactId: null,
      sourceId: null,
      sourceName: null,
      sourceTextBytes: null,
      sourceVersionId: null,
      sourceVersionNumber: null,
      state: "deleted",
      textTruncated: null
    },
    where
  });
  for (const retrievalSessionId of uniqueStrings(
    rows.map((row) => row.retrievalSessionId)
  )) {
    const session = await tx.knowledgeRetrievalSession.findUnique({
      select: {
        acceptedAt: true,
        degradedFlags: true,
        modelRun: { select: { userId: true } },
        modelRunId: true,
        scopeSnapshot: true
      },
      where: { id: retrievalSessionId }
    });
    if (!session) continue;
    const redacted = redactIdentifier(session.scopeSnapshot, input.resourceId);
    const scopeSnapshot = isRecord(redacted) && isRecord(session.scopeSnapshot) &&
      Object.hasOwn(session.scopeSnapshot, "selection")
      ? {
          ...redacted,
          selection: selectionWithoutResource(
            session.scopeSnapshot.selection,
            input.resourceId,
            input.resourceType
          )
        }
      : redacted;
    await tx.knowledgeRetrievalSession.update({
      data: {
        degradedFlags: [...new Set([...session.degradedFlags, "evidence_deleted"])].sort(),
        scopeSnapshot: json(scopeSnapshot)
      },
      where: { id: retrievalSessionId }
    });
    if (!session.acceptedAt) continue;
    const evidence = await loadKnowledgeEvidencePackage(tx, {
      runId: session.modelRunId,
      userId: session.modelRun.userId
    });
    if (!evidence) throw new KnowledgeDeletionInvariantError();
    await tx.knowledgeRetrievalSession.update({
      data: { receiptHash: knowledgeEvidenceReceiptHash(evidence) },
      where: { id: retrievalSessionId }
    });
  }
}

async function tombstoneKnowledgeRuns(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    documentVersionIds?: readonly string[];
    knowledgeBaseId?: string;
  }>
): Promise<string[]> {
  const rows = input.knowledgeBaseId
    ? await tx.$queryRaw<KnowledgeRunRow[]>(Prisma.sql`
        SELECT
          knowledge_run."id",
          knowledge_run."modelRunId",
          knowledge_run."modelRunToolCallId",
          knowledge_run."baseEvidence",
          knowledge_run."results",
          model_run."chatId"
        FROM "KnowledgeRun" AS knowledge_run
        INNER JOIN "ModelRun" AS model_run ON model_run."id" = knowledge_run."modelRunId"
        WHERE jsonb_typeof(knowledge_run."results") = 'array'
          AND (
            EXISTS (
              SELECT 1
              FROM jsonb_array_elements(knowledge_run."results") AS result
              WHERE result->>'knowledgeBaseId' = ${input.knowledgeBaseId}
            ) OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(knowledge_run."baseEvidence") AS evidence
              WHERE evidence->>'knowledgeBaseId' = ${input.knowledgeBaseId}
            )
          )
        FOR UPDATE OF knowledge_run
      `)
    : input.documentVersionIds && input.documentVersionIds.length > 0
      ? await tx.$queryRaw<KnowledgeRunRow[]>(Prisma.sql`
          SELECT
            knowledge_run."id",
            knowledge_run."modelRunId",
            knowledge_run."modelRunToolCallId",
            knowledge_run."baseEvidence",
            knowledge_run."results",
            model_run."chatId"
          FROM "KnowledgeRun" AS knowledge_run
          INNER JOIN "ModelRun" AS model_run ON model_run."id" = knowledge_run."modelRunId"
          WHERE jsonb_typeof(knowledge_run."results") = 'array'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(knowledge_run."results") AS result
              WHERE result->>'documentVersionId' IN (${Prisma.join(input.documentVersionIds)})
            )
          FOR UPDATE OF knowledge_run
        `)
      : [];

  const versionIds = new Set(input.documentVersionIds ?? []);
  for (const row of rows) {
    const tombstoned = tombstoneResults(row.results, (entry) => input.knowledgeBaseId
      ? entry.knowledgeBaseId === input.knowledgeBaseId
      : typeof entry.documentVersionId === "string" && versionIds.has(entry.documentVersionId));
    if (!input.knowledgeBaseId && !tombstoned.changed) continue;
    await tx.knowledgeRun.update({
      data: {
        baseEvidence: json(input.knowledgeBaseId
          ? withoutBaseEvidence(row.baseEvidence, input.knowledgeBaseId)
          : row.baseEvidence),
        postRerankOrder: Prisma.JsonNull,
        preRerankOrder: Prisma.JsonNull,
        rerankerBinding: Prisma.JsonNull,
        ...(tombstoned.changed
          ? {
              providerText: providerTextForTombstonedResults(tombstoned.results),
              results: json(tombstoned.results)
            }
          : {})
      },
      where: { id: row.id }
    });
    await tx.modelRunToolCall.updateMany({
      data: { result: Prisma.DbNull },
      where: { id: row.modelRunToolCallId, modelRunId: row.modelRunId }
    });
  }

  const chatIds = uniqueStrings(rows.map((row) => row.chatId));
  if (chatIds.length > 0) {
    await tx.sharedChatSnapshot.updateMany({
      data: { revokedAt: new Date() },
      where: { chatId: { in: chatIds }, revokedAt: null }
    });
  }
  return uniqueStrings(rows.map((row) => row.modelRunId));
}

function selectionWithoutResource(
  value: unknown,
  resourceId: string,
  resourceType: "base" | "source"
): unknown {
  const decoded = decodeKnowledgePlan(value);
  if (!decoded.ok || decoded.plan.mode === "all_my_knowledge" ||
    decoded.plan.mode === "inherited") return value;
  return explicitKnowledgeSelection({
    baseIds: resourceType === "base"
      ? decoded.plan.baseIds.filter((id) => id !== resourceId)
      : decoded.plan.baseIds,
    sourceIds: resourceType === "source"
      ? decoded.plan.sourceIds.filter((id) => id !== resourceId)
      : decoded.plan.sourceIds
  });
}

async function scrubConfigurationReferences(
  tx: Prisma.TransactionClient,
  resourceId: string,
  resourceType: "base" | "source"
): Promise<void> {
  const revisions = await tx.assistantRevision.findMany({
    select: { id: true, knowledgeSelection: true }
  });
  for (const revision of revisions) {
    const scrubbed = selectionWithoutResource(revision.knowledgeSelection, resourceId, resourceType);
    if (JSON.stringify(scrubbed) === JSON.stringify(revision.knowledgeSelection)) continue;
    await tx.assistantRevision.update({
      data: { knowledgeSelection: json(scrubbed) },
      where: { id: revision.id }
    });
  }
  const folders = await tx.folder.findMany({
    select: { defaultKnowledgePlan: true, id: true },
    where: { defaultKnowledgePlan: { not: Prisma.DbNull } }
  });
  for (const folder of folders) {
    const scrubbed = selectionWithoutResource(folder.defaultKnowledgePlan, resourceId, resourceType);
    if (JSON.stringify(scrubbed) === JSON.stringify(folder.defaultKnowledgePlan)) continue;
    await tx.folder.update({ data: { defaultKnowledgePlan: json(scrubbed) }, where: { id: folder.id } });
  }
  const chats = await tx.chat.findMany({
    select: { defaultKnowledgePlan: true, id: true },
    where: { defaultKnowledgePlan: { not: Prisma.DbNull } }
  });
  for (const chat of chats) {
    const scrubbed = selectionWithoutResource(chat.defaultKnowledgePlan, resourceId, resourceType);
    if (JSON.stringify(scrubbed) === JSON.stringify(chat.defaultKnowledgePlan)) continue;
    await tx.chat.update({ data: { defaultKnowledgePlan: json(scrubbed) }, where: { id: chat.id } });
  }
}

async function scrubModelRuns(
  tx: Prisma.TransactionClient,
  modelRunIds: readonly string[],
  knowledgeBaseId: string
): Promise<void> {
  if (modelRunIds.length === 0) return;
  const rows = await tx.modelRun.findMany({
    select: { errorPayload: true, id: true, normalizedRequest: true, toolLoopState: true },
    where: { id: { in: [...modelRunIds] } }
  });
  for (const row of rows) {
    await tx.modelRun.update({
      data: {
        ...(row.errorPayload === null
          ? {}
          : { errorPayload: json(redactIdentifier(row.errorPayload, knowledgeBaseId)) }),
        ...(row.normalizedRequest === null
          ? {}
          : { normalizedRequest: json(scrubRunNormalizedRequest(
              row.normalizedRequest,
              knowledgeBaseId
            )) }),
        ...(row.toolLoopState === null
          ? {}
          : { toolLoopState: json(redactIdentifier(row.toolLoopState, knowledgeBaseId)) })
      },
      where: { id: row.id }
    });
  }
}

async function objectIsReferenced(
  tx: Prisma.TransactionClient,
  storageKey: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ referenced: boolean }>>(Prisma.sql`
    SELECT (
      EXISTS (SELECT 1 FROM "Attachment" WHERE "storageKey" = ${storageKey}) OR
      EXISTS (
        SELECT 1 FROM "KnowledgeDocumentVersion"
        WHERE "originalStorageKey" = ${storageKey}
           OR "normalizedTextStorageKey" = ${storageKey}
      ) OR
      EXISTS (
        SELECT 1 FROM "KnowledgeSourceVersion"
        WHERE "originalStorageKey" = ${storageKey}
      ) OR
      EXISTS (
        SELECT 1 FROM "KnowledgeSourceIndexArtifact"
        WHERE "normalizedTextStorageKey" = ${storageKey}
      ) OR
      EXISTS (
        SELECT 1 FROM "KnowledgeUploadItem"
        WHERE "storageKey" = ${storageKey}
      )
    ) AS "referenced"
  `);
  return rows[0]?.referenced === true;
}

async function stageObjects(
  tx: Prisma.TransactionClient,
  knowledgeDeletionJobId: string,
  storageObjects: readonly KnowledgeDeletionStorageObject[],
  now: Date
): Promise<number> {
  let pending = 0;
  const uniqueObjects = new Map<string, KnowledgeDeletionStorageObject>();
  for (const object of storageObjects) {
    const current = uniqueObjects.get(object.storageKey);
    if (!current || !current.multipartUploadId && object.multipartUploadId) {
      uniqueObjects.set(object.storageKey, object);
    }
  }
  for (const object of [...uniqueObjects.values()].sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey))) {
    const storageKey = object.storageKey;
    const retained = await objectIsReferenced(tx, storageKey);
    await tx.knowledgeDeletionObject.upsert({
      create: {
        disposition: retained ? "RETAINED" : "PENDING",
        knowledgeDeletionJobId,
        ...(retained ? { settledAt: now } : {}),
        storageKey
      },
      update: {},
      where: { knowledgeDeletionJobId_storageKey: { knowledgeDeletionJobId, storageKey } }
    });
    if (retained) continue;
    pending += 1;
    await tx.attachmentDeletionJob.upsert({
      create: {
        multipartUploadId: object.multipartUploadId ?? null,
        storageKey
      },
      update: object.multipartUploadId
        ? { multipartUploadId: object.multipartUploadId }
        : {},
      where: { storageKey }
    });
  }
  return pending;
}

async function purgeSource(
  tx: Prisma.TransactionClient,
  claim: KnowledgeDeletionClaim,
  now: Date
): Promise<number> {
  const sources = await tx.$queryRaw<Array<{
    deletionRequestedAt: Date | null;
    ownerUserId: string;
    trashedAt: Date | null;
  }>>`
    SELECT "ownerUserId", "trashedAt", "deletionRequestedAt"
    FROM "KnowledgeSource"
    WHERE "id" = ${claim.targetId}
    FOR UPDATE
  `;
  const source = sources[0];
  if (!source || source.ownerUserId !== claim.ownerUserId ||
    !source.trashedAt || !source.deletionRequestedAt) {
    throw new KnowledgeDeletionInvariantError();
  }

  const documents = await tx.$queryRaw<Array<{ documentId: string }>>`
    SELECT "documentId"
    FROM "KnowledgeV1DocumentSourceMap"
    WHERE "sourceId" = ${claim.targetId}
    ORDER BY "documentId"
  `;
  const documentIds = uniqueStrings(documents.map((row) => row.documentId));
  const versions = documentIds.length > 0
    ? await tx.$queryRaw<Array<{
        id: string;
        normalizedTextStorageKey: string | null;
        originalStorageKey: string | null;
      }>>(Prisma.sql`
        SELECT "id", "originalStorageKey", "normalizedTextStorageKey"
        FROM "KnowledgeDocumentVersion"
        WHERE "documentId" IN (${Prisma.join(documentIds)})
        ORDER BY "id"
      `)
    : [];
  const sourceVersions = await tx.$queryRaw<Array<{
    normalizedTextStorageKey: string | null;
    originalStorageKey: string | null;
  }>>`
    SELECT version."originalStorageKey", artifact."normalizedTextStorageKey"
    FROM "KnowledgeSourceVersion" AS version
    LEFT JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."sourceVersionId" = version."id"
    WHERE version."sourceId" = ${claim.targetId}
  `;
  const documentVersionIds = uniqueStrings(versions.map((row) => row.id));
  const uploadReceipts = await tx.knowledgeUploadItem.findMany({
    select: { batchId: true, id: true },
    where: { sourceId: claim.targetId }
  });
  const uploadBatchIds = uniqueStrings(uploadReceipts.map(({ batchId }) => batchId));
  const storageKeys = uniqueStrings([
    ...versions.flatMap((row) => [row.originalStorageKey, row.normalizedTextStorageKey]),
    ...sourceVersions.flatMap((row) => [row.originalStorageKey, row.normalizedTextStorageKey])
  ]);

  await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
  await tombstoneKnowledgeRuns(tx, { documentVersionIds });
  await tombstoneEvidenceItems(tx, {
    documentVersionIds,
    resourceId: claim.targetId,
    resourceType: "source"
  });
  await tx.knowledgeBaseSnapshotSource.deleteMany({ where: { sourceId: claim.targetId } });
  if (documentVersionIds.length > 0) {
    await tx.usageEvent.updateMany({
      data: {
        knowledgeBaseId: null,
        knowledgeBatchIndex: null,
        knowledgeDocumentVersionId: null,
        knowledgeIndexGenerationId: null
      },
      where: { knowledgeDocumentVersionId: { in: documentVersionIds } }
    });
    await tx.knowledgeV1GenerationArtifactMap.deleteMany({
      where: { documentVersionId: { in: documentVersionIds } }
    });
    await tx.knowledgeGenerationDocument.deleteMany({
      where: { documentVersionId: { in: documentVersionIds } }
    });
    await tx.knowledgeChunk.deleteMany({ where: { documentVersionId: { in: documentVersionIds } } });
  }
  await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({ where: { sourceId: claim.targetId } });
  await tx.knowledgeV1DocumentSourceMap.deleteMany({ where: { sourceId: claim.targetId } });
  if (uploadReceipts.length > 0) {
    await tx.knowledgeUploadItem.deleteMany({
      where: { id: { in: uploadReceipts.map(({ id }) => id) } }
    });
  }
  if (uploadBatchIds.length > 0) {
    await tx.knowledgeUploadBatch.updateMany({
      data: { updatedAt: now },
      where: { id: { in: uploadBatchIds }, items: { some: {} } }
    });
    await tx.knowledgeUploadBatch.deleteMany({
      where: { id: { in: uploadBatchIds }, items: { none: {} } }
    });
  }
  if (documentIds.length > 0) {
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { id: { in: documentIds } }
    });
    await tx.knowledgeDocumentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await tx.knowledgeDocument.deleteMany({ where: { id: { in: documentIds } } });
  }
  await tx.knowledgeSource.update({
    data: { currentVersionId: null, pendingVersionId: null },
    where: { id: claim.targetId }
  });
  await tx.knowledgeBaseSource.deleteMany({ where: { sourceId: claim.targetId } });
  await tx.knowledgeSourceIndexArtifact.deleteMany({
    where: { sourceVersion: { sourceId: claim.targetId } }
  });
  await tx.knowledgeSourceVersion.deleteMany({ where: { sourceId: claim.targetId } });
  await scrubConfigurationReferences(tx, claim.targetId, "source");
  await tx.knowledgeSource.delete({ where: { id: claim.targetId } });
  return stageObjects(
    tx,
    claim.id,
    storageKeys.map((storageKey) => ({ storageKey })),
    now
  );
}

async function purgeBase(
  tx: Prisma.TransactionClient,
  claim: KnowledgeDeletionClaim,
  now: Date
): Promise<number> {
  const bases = await tx.$queryRaw<Array<{
    deletionRequestedAt: Date | null;
    ownerUserId: string;
    trashedAt: Date | null;
  }>>`
    SELECT "ownerUserId", "trashedAt", "deletionRequestedAt"
    FROM "KnowledgeBase"
    WHERE "id" = ${claim.targetId}
    FOR UPDATE
  `;
  const base = bases[0];
  if (!base || base.ownerUserId !== claim.ownerUserId || !base.trashedAt || !base.deletionRequestedAt) {
    throw new KnowledgeDeletionInvariantError();
  }

  const versions = await tx.knowledgeDocumentVersion.findMany({
    select: { id: true, normalizedTextStorageKey: true, originalStorageKey: true },
    where: { knowledgeBaseId: claim.targetId }
  });
  const storageKeys = uniqueStrings(versions.flatMap((row) => [
    row.originalStorageKey,
    row.normalizedTextStorageKey
  ]));
  const uploadObjects = await tx.knowledgeUploadItem.findMany({
    select: { multipartUploadId: true, storageKey: true },
    where: {
      batch: { knowledgeBaseId: claim.targetId },
      storageKey: { not: null }
    }
  });
  const boundRuns = await tx.knowledgeRunBinding.findMany({
    select: { modelRunId: true },
    where: { knowledgeBaseId: claim.targetId }
  });
  await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
  const resultRuns = await tombstoneKnowledgeRuns(tx, { knowledgeBaseId: claim.targetId });
  await tombstoneEvidenceItems(tx, {
    resourceId: claim.targetId,
    resourceType: "base"
  });
  const modelRunIds = uniqueStrings([
    ...boundRuns.map((row) => row.modelRunId),
    ...resultRuns
  ]);
  await scrubModelRuns(tx, modelRunIds, claim.targetId);
  await scrubConfigurationReferences(tx, claim.targetId, "base");

  await tx.usageEvent.updateMany({
    data: {
      knowledgeBaseId: null,
      knowledgeBatchIndex: null,
      knowledgeDocumentVersionId: null,
      knowledgeIndexGenerationId: null
    },
    where: { knowledgeBaseId: claim.targetId }
  });
  await tx.knowledgeRunBinding.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.projectKnowledgeBaseBinding.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBasePublication.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBaseSnapshotSource.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBaseSnapshot.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeV1GenerationArtifactMap.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeV1DocumentSourceMap.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeGenerationDocument.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeChunk.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeDocument.updateMany({
    data: { currentVersionId: null },
    where: { knowledgeBaseId: claim.targetId }
  });
  await tx.knowledgeDocumentVersion.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeUploadBatch.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBase.update({
    data: { activeIndexGenerationId: null },
    where: { id: claim.targetId }
  });
  await tx.knowledgeIndexGeneration.updateMany({
    data: { sourceIndexGenerationId: null },
    where: { knowledgeBaseId: claim.targetId }
  });
  await tx.knowledgeIndexGeneration.deleteMany({ where: { knowledgeBaseId: claim.targetId } });
  await tx.knowledgeBase.delete({ where: { id: claim.targetId } });
  return stageObjects(tx, claim.id, [
    ...storageKeys.map((storageKey) => ({ storageKey })),
    ...uploadObjects.flatMap((object) => object.storageKey
      ? [{ multipartUploadId: object.multipartUploadId, storageKey: object.storageKey }]
      : [])
  ], now);
}

export function createPrismaKnowledgeDeletionProcessor(client: PrismaClient = prisma) {
  async function settle(
    tx: Prisma.TransactionClient,
    knowledgeDeletionJobId: string,
    now: Date
  ): Promise<void> {
    await tx.knowledgeDeletionObject.deleteMany({
      where: { knowledgeDeletionJobId }
    });
    await tx.knowledgeDeletionJob.update({
      data: {
        claimToken: null,
        claimedAt: null,
        completedAt: now,
        leaseExpiresAt: null,
        state: "SUCCEEDED"
      },
      where: { id: knowledgeDeletionJobId }
    });
  }

  async function claim(input: Readonly<{
    leaseMinutes?: number;
    limit?: number;
    now?: Date;
  }> = {}): Promise<KnowledgeDeletionClaim[]> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? DEFAULT_KNOWLEDGE_DELETION_BATCH_SIZE;
    const leaseMinutes = input.leaseMinutes ?? DEFAULT_KNOWLEDGE_DELETION_LEASE_MINUTES;
    const leaseExpiresAt = new Date(now.getTime() + leaseMinutes * 60 * 1000);
    const claimToken = randomUUID();
    const rows = await client.$transaction((tx) => tx.$queryRaw<Array<{
      id: string;
      ownerUserId: string;
      targetId: string;
      targetType: "BASE" | "SOURCE";
    }>>(Prisma.sql`
      WITH candidates AS (
        SELECT job."id"
        FROM "KnowledgeDeletionJob" AS job
        WHERE (
          (job."state" IN ('PENDING', 'RETRY_WAIT') AND job."nextAttemptAt" <= ${now}) OR
          (job."state" = 'RUNNING' AND job."leaseExpiresAt" < ${now})
        )
        ORDER BY
          CASE job."targetType" WHEN 'SOURCE' THEN 0 ELSE 1 END,
          job."createdAt",
          job."id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "KnowledgeDeletionJob" AS job
      SET
        "state" = 'RUNNING',
        "claimToken" = ${claimToken},
        "claimedAt" = ${now},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "attemptCount" = job."attemptCount" + 1,
        "lastAttemptAt" = ${now},
        "lastErrorCode" = NULL,
        "updatedAt" = ${now}
      FROM candidates
      WHERE job."id" = candidates."id"
      RETURNING job."id", job."ownerUserId", job."targetId", job."targetType"::text
    `));
    return rows.map((row) => ({ ...row, claimToken }));
  }

  async function release(
    claim: KnowledgeDeletionClaim,
    now: Date,
    blocked: boolean
  ): Promise<void> {
    await client.knowledgeDeletionJob.updateMany({
      data: {
        claimToken: null,
        claimedAt: null,
        lastErrorCode: blocked ? "knowledge_purge_invariant" : "knowledge_purge_failed",
        leaseExpiresAt: null,
        nextAttemptAt: new Date(now.getTime() + 60_000),
        state: blocked ? "BLOCKED_REQUIRES_ADMIN" : "RETRY_WAIT"
      },
      where: { claimToken: claim.claimToken, id: claim.id, state: "RUNNING" }
    });
  }

  async function process(claim: KnowledgeDeletionClaim, now = new Date()): Promise<ProcessResult> {
    try {
      return await client.$transaction(async (tx) => {
        const job = await tx.knowledgeDeletionJob.findFirst({
          select: { id: true },
          where: { claimToken: claim.claimToken, id: claim.id, state: "RUNNING" }
        });
        if (!job) throw new KnowledgeDeletionInvariantError();
        const targetExists = claim.targetType === "SOURCE"
          ? await tx.knowledgeSource.count({ where: { id: claim.targetId } }) > 0
          : await tx.knowledgeBase.count({ where: { id: claim.targetId } }) > 0;
        if (!targetExists) {
          const [objects, pendingObjects] = await Promise.all([
            tx.knowledgeDeletionObject.count({ where: { knowledgeDeletionJobId: claim.id } }),
            tx.knowledgeDeletionObject.count({
              where: { disposition: "PENDING", knowledgeDeletionJobId: claim.id }
            })
          ]);
          if (objects === 0) throw new KnowledgeDeletionInvariantError();
          if (pendingObjects === 0) {
            await settle(tx, claim.id, now);
          } else {
            await tx.knowledgeDeletionJob.update({
              data: {
                claimToken: null,
                claimedAt: null,
                leaseExpiresAt: null,
                nextAttemptAt: new Date(now.getTime() + 5_000),
                state: "RETRY_WAIT"
              },
              where: { id: claim.id }
            });
          }
          return pendingObjects > 0 ? "waiting_for_objects" : "completed";
        }
        const pending = claim.targetType === "SOURCE"
          ? await purgeSource(tx, claim, now)
          : await purgeBase(tx, claim, now);
        if (pending === 0) {
          await settle(tx, claim.id, now);
        } else {
          await tx.knowledgeDeletionJob.update({
            data: {
              claimToken: null,
              claimedAt: null,
              leaseExpiresAt: null,
              nextAttemptAt: new Date(now.getTime() + 5_000),
              state: "RETRY_WAIT"
            },
            where: { id: claim.id }
          });
        }
        return pending > 0 ? "waiting_for_objects" : "completed";
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const blocked = error instanceof KnowledgeDeletionInvariantError;
      await release(claim, now, blocked);
      if (blocked) return "blocked";
      throw error;
    }
  }

  async function finalizeSettled(now = new Date()): Promise<number> {
    return client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string;
        state: "RETRY_WAIT" | "SUCCEEDED";
      }>>(Prisma.sql`
        SELECT job."id", job."state"::text
        FROM "KnowledgeDeletionJob" AS job
        WHERE job."state" IN ('RETRY_WAIT', 'SUCCEEDED')
          AND NOT EXISTS (
            SELECT 1
            FROM "KnowledgeDeletionObject" AS object
            WHERE object."knowledgeDeletionJobId" = job."id"
              AND object."disposition" = 'PENDING'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeBase" AS base
            WHERE job."targetType" = 'BASE' AND base."id" = job."targetId"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeSource" AS source
            WHERE job."targetType" = 'SOURCE' AND source."id" = job."targetId"
          )
        ORDER BY job."createdAt", job."id"
        FOR UPDATE OF job
      `);
      const ids = rows.map(({ id }) => id);
      const finalizableIds = rows.flatMap((row) =>
        row.state === "RETRY_WAIT" ? [row.id] : []
      );
      if (ids.length > 0) {
        await tx.knowledgeDeletionObject.deleteMany({
          where: { knowledgeDeletionJobId: { in: ids } }
        });
      }
      if (finalizableIds.length > 0) {
        await tx.knowledgeDeletionJob.updateMany({
          data: {
            completedAt: now,
            lastErrorCode: null,
            state: "SUCCEEDED"
          },
          where: { id: { in: finalizableIds }, state: "RETRY_WAIT" }
        });
      }
      return finalizableIds.length;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  return { claim, finalizeSettled, process };
}

export async function drainKnowledgeDeletionJobs(input: Readonly<{
  client?: PrismaClient;
  leaseMinutes?: number;
  limit?: number;
  now?: Date;
}> = {}): Promise<KnowledgeDeletionDrainSummary> {
  const processor = createPrismaKnowledgeDeletionProcessor(input.client ?? prisma);
  const now = input.now ?? new Date();
  const claims = await processor.claim({
    leaseMinutes: input.leaseMinutes,
    limit: input.limit,
    now
  });
  let blocked = 0;
  let completed = 0;
  let failed = 0;
  let waitingForObjects = 0;
  for (const claim of claims) {
    try {
      const result = await processor.process(claim, now);
      if (result === "blocked") blocked += 1;
      else if (result === "completed") completed += 1;
      else waitingForObjects += 1;
    } catch {
      failed += 1;
    }
  }
  completed += await processor.finalizeSettled(now);
  return { blocked, claimed: claims.length, completed, failed, waitingForObjects };
}

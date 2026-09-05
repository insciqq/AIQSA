import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeKnowledgeCitationHandle,
  decodeKnowledgePlan,
  explicitKnowledgeSelection
} from "../../contracts/knowledge";
import { prisma } from "../prisma";
import { deleteKnowledgeSearchArtifacts } from "./searchProjection";

export const DEFAULT_KNOWLEDGE_DELETION_BATCH_SIZE = 25;
export const DEFAULT_KNOWLEDGE_DELETION_LEASE_MINUTES = 15;

const knowledgeToolNames = Object.freeze([
  "analyze_structured",
  "analyze_visual",
  "discover_sources",
  "find_exact",
  "knowledge_focused_v1",
  "read_source",
  "retrieve_knowledge",
  "search_knowledge",
  "structured_analysis",
  "visual_analysis"
]);

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
  operation: string;
  providerCallId: string;
  query: string;
  readReceipt: unknown;
  retrievalSessionId: string | null;
  results: unknown;
}>;

type TombstonedKnowledgeRuns = Readonly<{
  modelRunIds: string[];
  privateValues: string[];
  providerCalls: Array<Readonly<{ modelRunId: string; providerCallId: string }>>;
  retrievalSessionIds: string[];
}>;

type KnowledgeRunSourceBindingRow = Readonly<{
  fileNameSnapshot: string | null;
  id: string;
  modelRunId: string;
  profileBindingId: string;
  sourceAlias: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceNameSnapshot: string | null;
  sourceVersionId: string;
}>;

type KnowledgeBaseSourceIdentity = Readonly<{
  modelRunId: string;
  profileBindingId: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

type TombstonedRunSourceBindings = Readonly<{
  modelRunIds: string[];
  privateValues: string[];
  sourceAliases: Array<Readonly<{ modelRunId: string; sourceAlias: string }>>;
}>;

type TombstonedEvidenceItems = Readonly<{
  evidenceItemIds: string[];
  modelRunIds: string[];
}>;

type KnowledgeEvidenceItemDeletionRow = Readonly<{
  id: string;
  retrievalSessionId: string;
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

function tombstoneEveryResult(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const handle = isRecord(entry)
      ? decodeKnowledgeCitationHandle(entry.handle)?.handle ?? null
      : null;
    return handle ? { deleted: true, handle } : { deleted: true };
  });
}

function matchesKnowledgeBaseSourceIdentity(
  entry: Record<string, unknown>,
  identity: KnowledgeBaseSourceIdentity
): boolean {
  const sourceId = typeof entry.sourceId === "string"
    ? entry.sourceId
    : entry.documentId;
  const sourceVersionId = typeof entry.sourceVersionId === "string"
    ? entry.sourceVersionId
    : entry.documentVersionId;
  return entry.knowledgeBaseId === identity.profileBindingId &&
    sourceId === identity.sourceId &&
    sourceVersionId === identity.sourceVersionId &&
    entry.sourceArtifactId === identity.sourceArtifactId;
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

function baseEvidenceAfterDeletion(
  value: unknown,
  deletedKnowledgeBaseIds: ReadonlySet<string>
): unknown[] {
  let includedUnknownTombstone = false;
  const retained = Array.isArray(value)
    ? value.flatMap((entry) => {
        if (isRecord(entry) && typeof entry.knowledgeBaseId === "string") {
          return deletedKnowledgeBaseIds.has(entry.knowledgeBaseId) ? [] : [entry];
        }
        if (includedUnknownTombstone) return [];
        includedUnknownTombstone = true;
        return [{ deleted: true }];
      })
    : [];
  return retained.length > 0 ? retained : [{ deleted: true }];
}

const deletedKnowledgeResource = "deleted_knowledge_resource";
const retiredAnalysisOperations = new Set(["structured_analysis", "visual_analysis"]);
const deletedKnowledgeReceiptHash = createHash("sha256")
  .update("aiqsa:knowledge:evidence-deleted:v1", "utf8")
  .digest("hex");
const deletedKnowledgeSessionPayload = Object.freeze({ deleted: true, version: 1 });
const privateKnowledgeFieldNames = new Set([
  "documentid",
  "documentversionid",
  "filename",
  "locator",
  "sourceartifactid",
  "sourceid",
  "sourcename",
  "sourceversionid"
]);

function collectPrivateKnowledgeValues(value: unknown, values: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectPrivateKnowledgeValues(entry, values);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (privateKnowledgeFieldNames.has(key.toLocaleLowerCase("und")) &&
      typeof entry === "string" && entry.length > 0) values.add(entry);
    collectPrivateKnowledgeValues(entry, values);
  }
}

function redactPrivateKnowledgeValues(value: unknown, values: ReadonlySet<string>): unknown {
  if (typeof value === "string" && values.has(value)) return deletedKnowledgeResource;
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry !== "string" || !values.has(entry))
      .map((entry) => redactPrivateKnowledgeValues(entry, values));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, redactPrivateKnowledgeValues(entry, values)]));
}

const removedProviderToolMessage = Symbol("removed_provider_tool_message");
const providerCallReferenceKeys = new Set(["call_id", "id", "tool_call_id", "tool_use_id"]);

function scrubProviderToolMessage(
  value: unknown,
  providerCallIds: ReadonlySet<string>
): unknown | typeof removedProviderToolMessage {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const scrubbed = scrubProviderToolMessage(entry, providerCallIds);
      return scrubbed === removedProviderToolMessage ? [] : [scrubbed];
    });
  }
  if (!isRecord(value)) return value;
  if (Object.entries(value).some(([key, entry]) =>
    providerCallReferenceKeys.has(key) && typeof entry === "string" &&
    providerCallIds.has(entry))) return removedProviderToolMessage;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const scrubbed = scrubProviderToolMessage(entry, providerCallIds);
    return scrubbed === removedProviderToolMessage ? [] : [[key, scrubbed]];
  }));
}

function scrubProviderToolMessageContainers(
  value: unknown,
  providerCallIds: ReadonlySet<string>
): unknown {
  if (providerCallIds.size === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => scrubProviderToolMessageContainers(entry, providerCallIds));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key !== "providerToolMessages" || !Array.isArray(entry)) {
      return [key, scrubProviderToolMessageContainers(entry, providerCallIds)];
    }
    return [key, entry.flatMap((message) => {
      const scrubbed = scrubProviderToolMessage(message, providerCallIds);
      return scrubbed === removedProviderToolMessage ? [] : [scrubbed];
    })];
  }));
}

function scrubRunNormalizedRequest(
  value: unknown,
  input: Readonly<{
    privateValues: ReadonlySet<string>;
    resourceId: string;
    resourceType: "base" | "source";
  }>
): unknown {
  const redacted = redactPrivateKnowledgeValues(value, input.privateValues);
  if (!isRecord(redacted)) return redacted;
  const withoutFocusedRequest = Object.fromEntries(
    Object.entries(redacted).filter(([key]) => key !== "knowledgeFocusedRequest")
  );
  if (!isRecord(value) || !Object.hasOwn(value, "knowledgePlan")) {
    return withoutFocusedRequest;
  }
  return {
    ...withoutFocusedRequest,
    knowledgePlan: selectionWithoutResource(
      value.knowledgePlan,
      input.resourceId,
      input.resourceType
    )
  };
}

async function tombstoneEvidenceItems(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    baseSourceIdentities?: readonly KnowledgeBaseSourceIdentity[];
    documentVersionIds?: readonly string[];
    modelRunIds?: readonly string[];
    purgedAt: Date;
    retrievalSessionIds?: readonly string[];
    resourceId: string;
    resourceType: "base" | "source";
  }>
): Promise<TombstonedEvidenceItems> {
  const rows: KnowledgeEvidenceItemDeletionRow[] = input.resourceType === "base"
    ? await tx.$queryRaw<KnowledgeEvidenceItemDeletionRow[]>(Prisma.sql`
        WITH affected_source AS MATERIALIZED (
          SELECT *
          FROM jsonb_to_recordset(
            ${JSON.stringify(input.baseSourceIdentities ?? [])}::jsonb
          ) AS identity(
            "modelRunId" text,
            "profileBindingId" text,
            "sourceArtifactId" text,
            "sourceId" text,
            "sourceVersionId" text
          )
        )
        SELECT evidence_item."id", evidence_item."retrievalSessionId"
        FROM "KnowledgeEvidenceItem" AS evidence_item
        INNER JOIN "KnowledgeRetrievalSession" AS retrieval_session
          ON retrieval_session."id" = evidence_item."retrievalSessionId"
        LEFT JOIN affected_source
          ON affected_source."modelRunId" = retrieval_session."modelRunId"
         AND affected_source."profileBindingId" = evidence_item."knowledgeBaseId"
         AND affected_source."sourceArtifactId" = evidence_item."sourceArtifactId"
         AND affected_source."sourceId" = evidence_item."sourceId"
         AND affected_source."sourceVersionId" = evidence_item."sourceVersionId"
        WHERE evidence_item."knowledgeBaseId" = ${input.resourceId}
           OR affected_source."modelRunId" IS NOT NULL
        ORDER BY evidence_item."id"
        FOR UPDATE OF evidence_item
      `)
    : await tx.knowledgeEvidenceItem.findMany({
        select: { id: true, retrievalSessionId: true },
        where: {
          OR: [
            { sourceId: input.resourceId },
            ...((input.documentVersionIds?.length ?? 0) > 0
              ? [{ documentVersionId: { in: [...input.documentVersionIds!] } }]
              : [])
          ]
        }
      });
  if (rows.length > 0) {
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
      where: { id: { in: rows.map(({ id }) => id) } }
    });
  }
  const scopedSessions = (input.modelRunIds?.length ?? 0) > 0
    ? await tx.knowledgeRetrievalSession.findMany({
        select: { id: true },
        where: { modelRunId: { in: [...input.modelRunIds!] } }
      })
    : [];
  const retrievalSessionIds = uniqueStrings([
    ...rows.map((row) => row.retrievalSessionId),
    ...(input.retrievalSessionIds ?? []),
    ...scopedSessions.map(({ id }) => id)
  ]);
  const modelRunIds: string[] = [];
  for (const retrievalSessionId of retrievalSessionIds) {
    const session = await tx.knowledgeRetrievalSession.findUnique({
      select: {
        acceptedAt: true,
        degradedFlags: true,
        modelRunId: true,
        scopeSnapshot: true
      },
      where: { id: retrievalSessionId }
    });
    if (!session) continue;
    modelRunIds.push(session.modelRunId);
    const redacted = redactPrivateKnowledgeValues(
      session.scopeSnapshot,
      new Set([input.resourceId])
    );
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
        originalIntent: json(deletedKnowledgeSessionPayload),
        receiptHash: session.acceptedAt ? deletedKnowledgeReceiptHash : null,
        scopeSnapshot: json(scopeSnapshot)
      },
      where: { id: retrievalSessionId }
    });
  }
  return {
    evidenceItemIds: rows.map(({ id }) => id),
    modelRunIds: uniqueStrings(modelRunIds)
  };
}

async function lockAffectedRunSourceBindings(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    resourceId: string;
    resourceType: "base" | "source";
  }>
): Promise<KnowledgeRunSourceBindingRow[]> {
  return input.resourceType === "source"
    ? await tx.$queryRaw<KnowledgeRunSourceBindingRow[]>(Prisma.sql`
        SELECT
          "id",
          "modelRunId",
          "profileBindingId",
          "sourceAlias",
          "sourceId",
          "sourceVersionId",
          "sourceArtifactId",
          "sourceNameSnapshot",
          "fileNameSnapshot"
        FROM "KnowledgeRunSourceBinding"
        WHERE "sourceId" = ${input.resourceId}
          AND "tombstonedAt" IS NULL
        ORDER BY "id"
        FOR UPDATE
      `)
    : await tx.$queryRaw<KnowledgeRunSourceBindingRow[]>(Prisma.sql`
        SELECT
          "id",
          "modelRunId",
          "profileBindingId",
          "sourceAlias",
          "sourceId",
          "sourceVersionId",
          "sourceArtifactId",
          "sourceNameSnapshot",
          "fileNameSnapshot"
        FROM "KnowledgeRunSourceBinding"
        WHERE "tombstonedAt" IS NULL
          AND jsonb_typeof("baseProvenance") = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements("baseProvenance") AS provenance
            WHERE provenance->>'knowledgeBaseId' = ${input.resourceId}
          )
        ORDER BY "id"
        FOR UPDATE
      `);
}

async function lockAffectedRunScopeModelRunIds(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    resourceId: string;
    resourceType: "base" | "source";
  }>
): Promise<string[]> {
  const rows = input.resourceType === "source"
    ? await tx.$queryRaw<Array<{ modelRunId: string }>>(Prisma.sql`
        SELECT run_scope."modelRunId"
        FROM "KnowledgeRunScope" AS run_scope
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(run_scope.selection -> 'sourceIds') = 'array'
                THEN run_scope.selection -> 'sourceIds'
              ELSE '[]'::jsonb
            END
          ) AS selected(resource_id)
          WHERE selected.resource_id = ${input.resourceId}
        )
        ORDER BY run_scope."modelRunId"
        FOR UPDATE OF run_scope
      `)
    : await tx.$queryRaw<Array<{ modelRunId: string }>>(Prisma.sql`
        SELECT run_scope."modelRunId"
        FROM "KnowledgeRunScope" AS run_scope
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(run_scope.selection -> 'baseIds') = 'array'
                THEN run_scope.selection -> 'baseIds'
              ELSE '[]'::jsonb
            END
          ) AS selected(resource_id)
          WHERE selected.resource_id = ${input.resourceId}
        )
        ORDER BY run_scope."modelRunId"
        FOR UPDATE OF run_scope
      `);
  return uniqueStrings(rows.map(({ modelRunId }) => modelRunId));
}

async function tombstoneRunSourceBindings(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    purgedAt: Date;
    rows: readonly KnowledgeRunSourceBindingRow[];
  }>
): Promise<TombstonedRunSourceBindings> {
  const rows = input.rows;
  if (rows.length === 0) return { modelRunIds: [], privateValues: [], sourceAliases: [] };
  const updated = await tx.knowledgeRunSourceBinding.updateMany({
    data: {
      accessProvenance: Prisma.DbNull,
      baseProvenance: Prisma.DbNull,
      fileNameSnapshot: null,
      readinessState: "deleted",
      sourceArtifactId: null,
      sourceId: null,
      sourceNameSnapshot: null,
      sourceVersionId: null,
      tombstonedAt: input.purgedAt
    },
    where: { id: { in: rows.map(({ id }) => id) }, tombstonedAt: null }
  });
  if (updated.count !== rows.length) throw new KnowledgeDeletionInvariantError();
  return {
    modelRunIds: uniqueStrings(rows.map(({ modelRunId }) => modelRunId)),
    privateValues: uniqueStrings(rows.flatMap((row) => [
      row.fileNameSnapshot,
      row.sourceArtifactId,
      row.sourceId,
      row.sourceNameSnapshot,
      row.sourceVersionId
    ])),
    sourceAliases: [...new Map(rows.map((row) => [
      `${row.modelRunId}\u0000${row.sourceAlias}`,
      { modelRunId: row.modelRunId, sourceAlias: row.sourceAlias }
    ])).values()].sort((left, right) =>
      left.modelRunId.localeCompare(right.modelRunId) ||
      left.sourceAlias.localeCompare(right.sourceAlias))
  };
}

async function purgeDispatchManifests(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    evidenceItemIds: readonly string[];
    modelRunIds: readonly string[];
    purgedAt: Date;
  }>
): Promise<string[]> {
  if (input.evidenceItemIds.length === 0 && input.modelRunIds.length === 0) return [];
  const manifests = await tx.knowledgeEvidenceDispatchManifest.findMany({
    orderBy: { id: "asc" },
    select: {
      excludedCount: true,
      id: true,
      itemCount: true,
      modelRunId: true,
      purgedAt: true
    },
    where: {
      OR: [
        ...(input.modelRunIds.length > 0
          ? [{ modelRunId: { in: [...input.modelRunIds] } }]
          : []),
        ...(input.evidenceItemIds.length > 0
          ? [
              { items: { some: { evidenceItemId: { in: [...input.evidenceItemIds] } } } },
              { exclusions: { some: { evidenceItemId: { in: [...input.evidenceItemIds] } } } }
            ]
          : [])
      ]
    }
  });
  const pending = manifests.filter(({ purgedAt }) => purgedAt === null);
  for (let offset = 0; offset < pending.length; offset += 4_096) {
    const batch = pending.slice(offset, offset + 4_096);
    const manifestIds = batch.map(({ id }) => id);
    const purgedItems = await tx.knowledgeEvidenceDispatchManifestItem.updateMany({
      data: {
        contextBoundaries: Prisma.DbNull,
        evidenceItemId: null,
        exactExcerpt: null,
        excerptHash: null,
        handle: null,
        renderedBlock: null,
        renderedBlockHash: null,
        representation: "purged",
        safeMetadata: Prisma.DbNull,
        sourceAlias: null,
        sourceArtifactId: null,
        sourceVersionId: null
      },
      where: { manifestId: { in: manifestIds } }
    });
    const purgedExclusions = await tx.knowledgeEvidenceDispatchManifestExclusion.updateMany({
      data: { evidenceItemId: null, handle: null, reason: "purged" },
      where: { manifestId: { in: manifestIds } }
    });
    if (purgedItems.count !== batch.reduce((count, manifest) =>
      count + manifest.itemCount, 0) ||
      purgedExclusions.count !== batch.reduce((count, manifest) =>
        count + manifest.excludedCount, 0)) {
      throw new KnowledgeDeletionInvariantError();
    }
    const purged = await tx.knowledgeEvidenceDispatchManifest.updateMany({
      data: {
        coverage: Prisma.DbNull,
        messageHash: null,
        messageText: null,
        profileRevisionIds: [],
        purgedAt: input.purgedAt
      },
      where: { id: { in: manifestIds }, purgedAt: null }
    });
    if (purged.count !== batch.length) throw new KnowledgeDeletionInvariantError();
  }
  return uniqueStrings(manifests.map(({ modelRunId }) => modelRunId));
}

async function purgeBudgetReservations(
  tx: Prisma.TransactionClient,
  modelRunIds: readonly string[],
  purgedAt: Date
): Promise<void> {
  if (modelRunIds.length === 0) return;
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      dispatchAttemptKey: null,
      failureCode: null,
      idempotencyKey: null,
      leaseExpiresAt: null,
      leaseToken: null,
      operationRequest: Prisma.DbNull,
      operationRequestHash: null,
      purgedAt,
      receiptHash: null
    },
    where: { modelRunId: { in: [...modelRunIds] }, purgedAt: null }
  });
}

async function purgeProviderAttempts(
  tx: Prisma.TransactionClient,
  modelRunIds: readonly string[],
  purgedAt: Date
): Promise<void> {
  if (modelRunIds.length === 0) return;
  const attempts = await tx.knowledgeProviderAttempt.findMany({
    orderBy: [{ modelRunId: "asc" }, { ordinal: "asc" }],
    select: {
      createdAt: true,
      dispatchedAt: true,
      id: true,
      modelRunId: true,
      purpose: true,
      state: true
    },
    where: { modelRunId: { in: [...modelRunIds] } }
  });
  for (const attempt of attempts) {
    const idempotencyKey = `purged:${createHash("sha256")
      .update(attempt.id, "utf8")
      .digest("hex")}`;
    const terminalTransition = attempt.state === "reserved"
      ? {
          failureCode: "purged",
          releasedAt: new Date(Math.max(purgedAt.getTime(), attempt.createdAt.getTime())),
          state: "released" as const
        }
      : attempt.state === "dispatched"
        ? {
            ambiguousAt: new Date(Math.max(
              purgedAt.getTime(),
              attempt.dispatchedAt?.getTime() ?? attempt.createdAt.getTime()
            )),
            failureCode: "purged",
            state: "ambiguous" as const
          }
        : {};
    const structuredAnswer = attempt.purpose === "knowledge_answer_draft_v21" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v21" ||
      attempt.purpose === "knowledge_grounded_selector_v17" ||
      attempt.purpose === "knowledge_grounded_selector_final_v17" ||
      attempt.purpose === "knowledge_grounded_selector_v18" ||
      attempt.purpose === "knowledge_grounded_selector_final_v18" ||
      attempt.purpose === "knowledge_grounded_selector_v19" ||
      attempt.purpose === "knowledge_grounded_selector_final_v19" ||
      attempt.purpose === "knowledge_grounded_selector_v20" ||
      attempt.purpose === "knowledge_grounded_selector_final_v20" ||
      attempt.purpose === "knowledge_grounded_selector_v21" ||
      attempt.purpose === "knowledge_grounded_selector_final_v21" ||
      attempt.purpose === "knowledge_coverage_auditor_v2" ||
      attempt.purpose === "knowledge_coverage_auditor_v1" ||
      attempt.purpose === "knowledge_coverage_scope_v3" ||
      attempt.purpose === "knowledge_coverage_scope_v4" ||
      attempt.purpose === "knowledge_coverage_scope_v5" ||
      attempt.purpose === "knowledge_coverage_scope_v6" ||
      attempt.purpose === "knowledge_coverage_planner_v20" ||
      attempt.purpose === "knowledge_answer_draft_v20" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v20" ||
      attempt.purpose === "knowledge_answer_draft_v19" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v19" ||
      attempt.purpose === "knowledge_answer_draft_v18" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v18" ||
      attempt.purpose === "knowledge_answer_draft_v17" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v17" ||
      attempt.purpose === "knowledge_answer_draft_v16" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v16" ||
      attempt.purpose === "knowledge_answer_draft_v15" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v15" ||
      attempt.purpose === "knowledge_answer_draft_v14" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v14" ||
      attempt.purpose === "knowledge_answer_draft_v13" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v13" ||
      attempt.purpose === "knowledge_answer_draft_v12" ||
      attempt.purpose === "knowledge_answer_draft_supplement_v12" ||
      attempt.purpose === "knowledge_answer_draft_v11" ||
      attempt.purpose === "knowledge_answer_draft_v10" ||
      attempt.purpose === "knowledge_answer_draft_v9" ||
      attempt.purpose === "knowledge_answer_draft_v8" ||
      attempt.purpose === "knowledge_answer_draft_v7" ||
      attempt.purpose === "knowledge_answer_draft_v6" ||
      attempt.purpose === "knowledge_answer_draft_v5" ||
      attempt.purpose === "knowledge_grounded_selector_v2" ||
      attempt.purpose === "knowledge_grounded_selector_v3" ||
      attempt.purpose === "knowledge_grounded_selector_v4" ||
      attempt.purpose === "knowledge_grounded_selector_v5" ||
      attempt.purpose === "knowledge_grounded_selector_v6" ||
      attempt.purpose === "knowledge_grounded_selector_v7" ||
      attempt.purpose === "knowledge_grounded_selector_v16" ||
      attempt.purpose === "knowledge_grounded_selector_final_v16" ||
      attempt.purpose === "knowledge_grounded_selector_v15" ||
      attempt.purpose === "knowledge_grounded_selector_final_v15" ||
      attempt.purpose === "knowledge_grounded_selector_v14" ||
      attempt.purpose === "knowledge_grounded_selector_final_v14" ||
      attempt.purpose === "knowledge_grounded_selector_v13" ||
      attempt.purpose === "knowledge_grounded_selector_final_v13" ||
      attempt.purpose === "knowledge_grounded_selector_v12" ||
      attempt.purpose === "knowledge_grounded_selector_final_v12" ||
      attempt.purpose === "knowledge_grounded_selector_v11" ||
      attempt.purpose === "knowledge_grounded_selector_final_v11" ||
      attempt.purpose === "knowledge_grounded_selector_v10" ||
      attempt.purpose === "knowledge_grounded_selector_final_v10" ||
      attempt.purpose === "knowledge_grounded_selector_v9" ||
      attempt.purpose === "knowledge_grounded_selector_final_v9" ||
      attempt.purpose === "knowledge_grounded_selector_v8" ||
      attempt.purpose === "knowledge_grounded_selector_final_v8";
    const settledStructuredAnswer = structuredAnswer && attempt.state === "settled";
    const updated = await tx.knowledgeProviderAttempt.updateMany({
      data: {
        ...terminalTransition,
        ...(structuredAnswer
          ? {
              acceptedRequest: json({ purged: true, version: 1 }),
              acceptedResult: settledStructuredAnswer
                ? json({ purged: true, version: 1 })
                : Prisma.DbNull,
              evidenceReceiptHash: "0".repeat(64),
              resultAcceptedAt: settledStructuredAnswer ? undefined : null,
              resultHash: settledStructuredAnswer ? "0".repeat(64) : null
            }
          : {}),
        checkpointHash: "0".repeat(64),
        idempotencyKey,
        leaseExpiresAt: null,
        leaseToken: null,
        providerResponseId: null,
        requestHash: "0".repeat(64)
      },
      where: {
        id: attempt.id,
        modelRunId: attempt.modelRunId,
        state: attempt.state
      }
    });
    if (updated.count !== 1) throw new KnowledgeDeletionInvariantError();
  }
}

async function tombstoneKnowledgeRuns(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    affectedModelRunIds?: readonly string[];
    baseSourceIdentities?: readonly KnowledgeBaseSourceIdentity[];
    documentVersionIds?: readonly string[];
    knowledgeBaseId?: string;
    privateIdentifiers?: readonly string[];
    sourceAliases?: readonly Readonly<{ modelRunId: string; sourceAlias: string }>[];
    sourceId?: string;
    sourceVersionIds?: readonly string[];
  }>
): Promise<TombstonedKnowledgeRuns> {
  const versionIds = new Set([
    ...(input.documentVersionIds ?? []),
    ...(input.sourceVersionIds ?? [])
  ]);
  const versionPredicate = versionIds.size > 0
    ? Prisma.sql`OR result->>'documentVersionId' IN (${Prisma.join([...versionIds])})`
    : Prisma.empty;
  const discoveryReceiptPredicate = (input.sourceAliases?.length ?? 0) > 0
    ? Prisma.sql`(
        knowledge_run."operation" = 'discover_sources'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(knowledge_run."readReceipt" -> 'sources') = 'array'
                THEN knowledge_run."readReceipt" -> 'sources'
              ELSE '[]'::jsonb
            END
          ) AS discovered_source
          WHERE ${Prisma.join(input.sourceAliases!.map((binding) => Prisma.sql`(
            knowledge_run."modelRunId" = ${binding.modelRunId}
            AND discovered_source ->> 'sourceAlias' = ${binding.sourceAlias}
          )`), " OR ")}
        )
      )`
    : Prisma.sql`false`;
  const affectedRunPredicate = (input.affectedModelRunIds?.length ?? 0) > 0
    ? Prisma.sql`knowledge_run."modelRunId" IN (${Prisma.join(input.affectedModelRunIds!)})`
    : Prisma.sql`false`;
  const rows = input.knowledgeBaseId
    ? await tx.$queryRaw<KnowledgeRunRow[]>(Prisma.sql`
        SELECT
          knowledge_run."id",
          knowledge_run."modelRunId",
          knowledge_run."modelRunToolCallId",
          model_run_tool_call."providerCallId",
          knowledge_run."operation",
          knowledge_run."query",
          knowledge_run."baseEvidence",
          knowledge_run."readReceipt",
          knowledge_run."retrievalSessionId",
          knowledge_run."results",
          model_run."chatId"
        FROM "KnowledgeRun" AS knowledge_run
        INNER JOIN "ModelRun" AS model_run ON model_run."id" = knowledge_run."modelRunId"
        INNER JOIN "ModelRunToolCall" AS model_run_tool_call
          ON model_run_tool_call."id" = knowledge_run."modelRunToolCallId"
         AND model_run_tool_call."modelRunId" = knowledge_run."modelRunId"
        WHERE jsonb_typeof(knowledge_run."results") = 'array'
          AND (
            ${affectedRunPredicate}
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(knowledge_run."results") AS result
              WHERE result->>'knowledgeBaseId' = ${input.knowledgeBaseId}
            ) OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(knowledge_run."baseEvidence") AS evidence
              WHERE evidence->>'knowledgeBaseId' = ${input.knowledgeBaseId}
            )
            OR ${discoveryReceiptPredicate}
          )
        FOR UPDATE OF knowledge_run
      `)
    : input.sourceId
      ? await tx.$queryRaw<KnowledgeRunRow[]>(Prisma.sql`
          SELECT
            knowledge_run."id",
            knowledge_run."modelRunId",
            knowledge_run."modelRunToolCallId",
            model_run_tool_call."providerCallId",
            knowledge_run."operation",
            knowledge_run."query",
            knowledge_run."baseEvidence",
            knowledge_run."readReceipt",
            knowledge_run."retrievalSessionId",
            knowledge_run."results",
            model_run."chatId"
          FROM "KnowledgeRun" AS knowledge_run
          INNER JOIN "ModelRun" AS model_run ON model_run."id" = knowledge_run."modelRunId"
          INNER JOIN "ModelRunToolCall" AS model_run_tool_call
            ON model_run_tool_call."id" = knowledge_run."modelRunToolCallId"
           AND model_run_tool_call."modelRunId" = knowledge_run."modelRunId"
          WHERE jsonb_typeof(knowledge_run."results") = 'array'
            AND (
              ${affectedRunPredicate}
              OR knowledge_run."readReceipt" #>> '{resolvedSource,sourceId}' = ${input.sourceId}
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(knowledge_run."results") AS result
                WHERE result->>'sourceId' = ${input.sourceId}
                   OR result->>'documentId' = ${input.sourceId}
                   ${versionPredicate}
              )
              OR ${discoveryReceiptPredicate}
            )
          FOR UPDATE OF knowledge_run
        `)
      : [];

  const privateValues = new Set(input.privateIdentifiers ?? []);
  for (const row of rows) {
    collectPrivateKnowledgeValues(row.readReceipt, privateValues);
    privateValues.add(row.query);
    const tombstoned = tombstoneResults(row.results, (entry) => input.knowledgeBaseId
      ? entry.knowledgeBaseId === input.knowledgeBaseId ||
        (input.baseSourceIdentities ?? []).some((identity) =>
          identity.modelRunId === row.modelRunId &&
          matchesKnowledgeBaseSourceIdentity(entry, identity))
      : entry.sourceId === input.sourceId || entry.documentId === input.sourceId ||
        typeof entry.documentVersionId === "string" && versionIds.has(entry.documentVersionId));
    const results = retiredAnalysisOperations.has(row.operation)
      ? tombstoneEveryResult(row.results)
      : tombstoned.results;
    const deletedBaseEvidenceIds = new Set([
      ...(input.knowledgeBaseId ? [input.knowledgeBaseId] : []),
      ...(input.baseSourceIdentities ?? []).flatMap((identity) =>
        identity.modelRunId === row.modelRunId ? [identity.profileBindingId] : [])
    ]);
    await tx.knowledgeRun.update({
      data: {
        baseEvidence: json(input.knowledgeBaseId
          ? baseEvidenceAfterDeletion(row.baseEvidence, deletedBaseEvidenceIds)
          : row.baseEvidence),
        providerText: tombstoned.changed || retiredAnalysisOperations.has(row.operation)
          ? providerTextForTombstonedResults(results)
          : providerTextForTombstonedResults([]),
        query: deletedKnowledgeResource,
        readReceipt: Prisma.DbNull,
        ...(tombstoned.changed || retiredAnalysisOperations.has(row.operation)
          ? { results: json(results) }
          : {})
      },
      where: { id: row.id }
    });
    await tx.modelRunToolCall.updateMany({
      data: { arguments: json({ deleted: true }), result: Prisma.DbNull },
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
  return {
    modelRunIds: uniqueStrings(rows.map((row) => row.modelRunId)),
    privateValues: uniqueStrings([...privateValues]),
    providerCalls: rows.map((row) => ({
      modelRunId: row.modelRunId,
      providerCallId: row.providerCallId
    })).sort((left, right) => left.modelRunId.localeCompare(right.modelRunId) ||
      left.providerCallId.localeCompare(right.providerCallId)),
    retrievalSessionIds: uniqueStrings(rows.map((row) => row.retrievalSessionId))
  };
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
  // Serialize cleanup with live edits and admission; never overwrite a newer
  // selection based on a previously read definition.
  const definitions = await tx.$queryRaw<Array<{ id: string; knowledgeSelection: Prisma.JsonValue }>>`
    SELECT "id", "knowledgeSelection" FROM "AssistantDefinition" ORDER BY "id" FOR UPDATE
  `;
  for (const definition of definitions) {
    const scrubbed = selectionWithoutResource(definition.knowledgeSelection, resourceId, resourceType);
    if (JSON.stringify(scrubbed) === JSON.stringify(definition.knowledgeSelection)) continue;
    await tx.assistantDefinition.update({
      data: { knowledgeSelection: json(scrubbed), version: { increment: 1 } },
      where: { id: definition.id }
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
  input: Readonly<{
    modelRunIds: readonly string[];
    privateValues: readonly string[];
    providerCalls: readonly Readonly<{ modelRunId: string; providerCallId: string }>[];
    purgedAt: Date;
    resourceId: string;
    resourceType: "base" | "source";
  }>
): Promise<void> {
  if (input.modelRunIds.length === 0) return;
  const privateValues = new Set([input.resourceId, ...input.privateValues]);
  const providerCallIdsByRun = new Map<string, Set<string>>();
  for (const call of input.providerCalls) {
    const ids = providerCallIdsByRun.get(call.modelRunId) ?? new Set<string>();
    ids.add(call.providerCallId);
    providerCallIdsByRun.set(call.modelRunId, ids);
  }
  const rows = await tx.modelRun.findMany({
    select: {
      assistantMessageId: true,
      errorPayload: true,
      id: true,
      normalizedRequest: true,
      status: true,
      toolLoopState: true
    },
    where: { id: { in: [...input.modelRunIds] } }
  });
  for (const row of rows) {
    const active = row.status === "preparing" || row.status === "queued" ||
      row.status === "streaming" || row.status === "in_progress";
    const terminalPayload = {
      code: "knowledge_retrieval_failed",
      message: "Knowledge retrieval stopped because selected Knowledge was permanently deleted."
    };
    await tx.modelRun.update({
      data: {
        ...(active
          ? { errorPayload: json(terminalPayload), status: "cancelled" as const }
          : row.errorPayload === null
          ? {}
          : { errorPayload: json(redactPrivateKnowledgeValues(row.errorPayload, privateValues)) }),
        ...(row.normalizedRequest === null
          ? {}
          : { normalizedRequest: json(scrubRunNormalizedRequest(
              row.normalizedRequest,
              {
                privateValues,
                resourceId: input.resourceId,
                resourceType: input.resourceType
              }
            )) }),
        providerResponseId: null,
        ...(row.toolLoopState === null
          ? {}
          : { toolLoopState: json(scrubProviderToolMessageContainers(
              redactPrivateKnowledgeValues(row.toolLoopState, privateValues),
              providerCallIdsByRun.get(row.id) ?? new Set<string>()
            )) })
      },
      where: { id: row.id }
    });
    if (active && row.assistantMessageId) {
      await tx.message.updateMany({
        data: { errorMessage: terminalPayload.message, status: "cancelled" },
        where: {
          id: row.assistantMessageId,
          status: { in: ["queued", "streaming"] }
        }
      });
    }
    await tx.modelRunToolCall.updateMany({
      data: { arguments: json({ deleted: true }), result: Prisma.DbNull },
      where: { modelRunId: row.id, toolName: { in: [...knowledgeToolNames] } }
    });
    if (active) {
      await tx.modelRunToolCall.updateMany({
        data: { completedAt: input.purgedAt, state: "cancelled" },
        where: { modelRunId: row.id, state: { in: ["pending", "running"] } }
      });
    }
  }
  const scopes = await tx.knowledgeRunScope.findMany({
    select: { modelRunId: true, selection: true },
    where: { modelRunId: { in: [...input.modelRunIds] } }
  });
  for (const scope of scopes) {
    await tx.knowledgeRunScope.update({
      data: {
        selection: json(selectionWithoutResource(
          scope.selection,
          input.resourceId,
          input.resourceType
        ))
      },
      where: { modelRunId: scope.modelRunId }
    });
  }
  if (input.resourceType === "source") {
    const bindings = await tx.knowledgeRunBinding.findMany({
      select: { id: true, selectedSourceIds: true },
      where: {
        modelRunId: { in: [...input.modelRunIds] },
        selectedSourceIds: { has: input.resourceId }
      }
    });
    for (const binding of bindings) {
      await tx.knowledgeRunBinding.update({
        data: {
          selectedSourceIds: binding.selectedSourceIds.filter((id) => id !== input.resourceId)
        },
        where: { id: binding.id }
      });
    }
  }
}

async function objectIsReferenced(
  tx: Prisma.TransactionClient,
  storageKey: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ referenced: boolean }>>(Prisma.sql`
    SELECT (
      EXISTS (SELECT 1 FROM "Attachment" WHERE "storageKey" = ${storageKey}) OR
      EXISTS (SELECT 1 FROM "ChatPdfArtifact" WHERE "storageKey" = ${storageKey}) OR
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
    name: string;
    ownerUserId: string;
    trashedAt: Date | null;
  }>>`
    SELECT "ownerUserId", "name", "trashedAt", "deletionRequestedAt"
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
    artifactId: string | null;
    fileName: string;
    id: string;
    normalizedTextStorageKey: string | null;
    originalStorageKey: string | null;
  }>>`
    SELECT
      version."id",
      version."fileName",
      version."originalStorageKey",
      artifact."id" AS "artifactId",
      artifact."normalizedTextStorageKey"
    FROM "KnowledgeSourceVersion" AS version
    LEFT JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."sourceVersionId" = version."id"
    WHERE version."sourceId" = ${claim.targetId}
  `;
  const documentVersionIds = uniqueStrings(versions.map((row) => row.id));
  const sourceVersionIds = uniqueStrings(sourceVersions.map((row) => row.id));
  const uploadReceipts = await tx.knowledgeUploadItem.findMany({
    select: { batchId: true, id: true },
    where: { sourceId: claim.targetId }
  });
  const uploadBatchIds = uniqueStrings(uploadReceipts.map(({ batchId }) => batchId));
  const storageKeys = uniqueStrings([
    ...versions.flatMap((row) => [row.originalStorageKey, row.normalizedTextStorageKey]),
    ...sourceVersions.flatMap((row) => [row.originalStorageKey, row.normalizedTextStorageKey])
  ]);
  const boundRuns = await tx.knowledgeRunBinding.findMany({
    select: { modelRunId: true },
    where: {
      OR: [
        { selectedSourceIds: { has: claim.targetId } },
        { knowledgeBaseSnapshot: { sources: { some: { sourceId: claim.targetId } } } }
      ]
    }
  });
  const scopeModelRunIds = await lockAffectedRunScopeModelRunIds(tx, {
    resourceId: claim.targetId,
    resourceType: "source"
  });
  const sourceBindingRows = await lockAffectedRunSourceBindings(tx, {
    resourceId: claim.targetId,
    resourceType: "source"
  });
  await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
  const sourceBindingRuns = await tombstoneRunSourceBindings(tx, {
    purgedAt: now,
    rows: sourceBindingRows
  });
  const resultRuns = await tombstoneKnowledgeRuns(tx, {
    affectedModelRunIds: uniqueStrings([
      ...boundRuns.map((row) => row.modelRunId),
      ...scopeModelRunIds,
      ...sourceBindingRuns.modelRunIds
    ]),
    documentVersionIds,
    privateIdentifiers: uniqueStrings([
      claim.targetId,
      source.name,
      ...documentIds,
      ...documentVersionIds,
      ...sourceVersionIds,
      ...sourceVersions.flatMap((row) => [
        row.artifactId,
        row.fileName,
        row.normalizedTextStorageKey,
        row.originalStorageKey
      ]),
      ...sourceBindingRuns.privateValues
    ]),
    sourceAliases: sourceBindingRuns.sourceAliases,
    sourceId: claim.targetId,
    sourceVersionIds
  });
  const evidenceItems = await tombstoneEvidenceItems(tx, {
    documentVersionIds,
    modelRunIds: uniqueStrings([
      ...boundRuns.map((row) => row.modelRunId),
      ...resultRuns.modelRunIds,
      ...scopeModelRunIds,
      ...sourceBindingRuns.modelRunIds
    ]),
    purgedAt: now,
    retrievalSessionIds: resultRuns.retrievalSessionIds,
    resourceId: claim.targetId,
    resourceType: "source"
  });
  const modelRunIds = uniqueStrings([
    ...boundRuns.map((row) => row.modelRunId),
    ...resultRuns.modelRunIds,
    ...scopeModelRunIds,
    ...sourceBindingRuns.modelRunIds,
    ...evidenceItems.modelRunIds
  ]);
  const dispatchModelRunIds = await purgeDispatchManifests(tx, {
    evidenceItemIds: evidenceItems.evidenceItemIds,
    modelRunIds,
    purgedAt: now
  });
  const affectedModelRunIds = uniqueStrings([...modelRunIds, ...dispatchModelRunIds]);
  await purgeBudgetReservations(
    tx,
    affectedModelRunIds,
    now
  );
  await scrubModelRuns(tx, {
    modelRunIds: affectedModelRunIds,
    privateValues: resultRuns.privateValues,
    providerCalls: resultRuns.providerCalls,
    purgedAt: now,
    resourceId: claim.targetId,
    resourceType: "source"
  });
  await purgeProviderAttempts(tx, affectedModelRunIds, now);
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
  await tx.projectKnowledgeSourceBinding.deleteMany({ where: { sourceId: claim.targetId } });
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
  const scopeModelRunIds = await lockAffectedRunScopeModelRunIds(tx, {
    resourceId: claim.targetId,
    resourceType: "base"
  });
  const sourceBindingRows = await lockAffectedRunSourceBindings(tx, {
    resourceId: claim.targetId,
    resourceType: "base"
  });
  const baseSourceIdentities: KnowledgeBaseSourceIdentity[] = sourceBindingRows.map((row) => ({
    modelRunId: row.modelRunId,
    profileBindingId: row.profileBindingId,
    sourceArtifactId: row.sourceArtifactId,
    sourceId: row.sourceId,
    sourceVersionId: row.sourceVersionId
  }));
  await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
  const sourceBindingRuns = await tombstoneRunSourceBindings(tx, {
    purgedAt: now,
    rows: sourceBindingRows
  });
  const resultRuns = await tombstoneKnowledgeRuns(tx, {
    affectedModelRunIds: uniqueStrings([
      ...boundRuns.map((row) => row.modelRunId),
      ...scopeModelRunIds,
      ...sourceBindingRuns.modelRunIds
    ]),
    baseSourceIdentities,
    knowledgeBaseId: claim.targetId,
    privateIdentifiers: uniqueStrings([
      claim.targetId,
      ...versions.flatMap((row) => [
        row.id,
        row.normalizedTextStorageKey,
        row.originalStorageKey
      ]),
      ...sourceBindingRuns.privateValues
    ]),
    sourceAliases: sourceBindingRuns.sourceAliases
  });
  const evidenceItems = await tombstoneEvidenceItems(tx, {
    baseSourceIdentities,
    modelRunIds: uniqueStrings([
      ...boundRuns.map((row) => row.modelRunId),
      ...resultRuns.modelRunIds,
      ...scopeModelRunIds,
      ...sourceBindingRuns.modelRunIds
    ]),
    purgedAt: now,
    retrievalSessionIds: resultRuns.retrievalSessionIds,
    resourceId: claim.targetId,
    resourceType: "base"
  });
  const modelRunIds = uniqueStrings([
    ...boundRuns.map((row) => row.modelRunId),
    ...resultRuns.modelRunIds,
    ...scopeModelRunIds,
    ...sourceBindingRuns.modelRunIds,
    ...evidenceItems.modelRunIds
  ]);
  const dispatchModelRunIds = await purgeDispatchManifests(tx, {
    evidenceItemIds: evidenceItems.evidenceItemIds,
    modelRunIds,
    purgedAt: now
  });
  const affectedModelRunIds = uniqueStrings([...modelRunIds, ...dispatchModelRunIds]);
  await purgeBudgetReservations(
    tx,
    affectedModelRunIds,
    now
  );
  await scrubModelRuns(tx, {
    modelRunIds: affectedModelRunIds,
    privateValues: resultRuns.privateValues,
    providerCalls: resultRuns.providerCalls,
    purgedAt: now,
    resourceId: claim.targetId,
    resourceType: "base"
  });
  await purgeProviderAttempts(tx, affectedModelRunIds, now);
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
    data: {
      sourceBaseVersion: null,
      sourceIndexGenerationId: null,
      targetContentRevision: null,
      targetSourceRevision: null
    },
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

export function createPrismaKnowledgeDeletionProcessor(
  client: PrismaClient = prisma,
  searchDeletion: (indexArtifactIds: readonly string[]) => Promise<void> =
    (indexArtifactIds) => deleteKnowledgeSearchArtifacts({ indexArtifactIds })
) {
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
      if (claim.targetType === "SOURCE") {
        const projections = await client.knowledgeSearchProjection.findMany({
          orderBy: { indexArtifactId: "asc" },
          select: { indexArtifactId: true },
          where: {
            indexArtifact: {
              sourceArtifact: {
                sourceVersion: { sourceId: claim.targetId }
              }
            }
          }
        });
        if (projections.length > 0) {
          await client.knowledgeSearchProjection.updateMany({
            data: {
              claimToken: null,
              leaseExpiresAt: null,
              state: "DELETING"
            },
            where: {
              indexArtifactId: {
                in: projections.map(({ indexArtifactId }) => indexArtifactId)
              }
            }
          });
          await searchDeletion(projections.map(({ indexArtifactId }) => indexArtifactId));
        }
      }
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

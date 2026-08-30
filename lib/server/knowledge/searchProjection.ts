import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeKnowledgeDocumentContext } from "./documentContext";
import { KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS } from "./hierarchicalIndex";
import {
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_BULK_MAX_DOCUMENTS,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  knowledgeSearchProjectionFingerprint,
  type KnowledgeSearchDocument
} from "../search/opensearch/contract";
import {
  OpenSearchTransportError,
  createKnowledgeOpenSearchTransport,
  type AiqsaOpenSearchTransport
} from "../search/opensearch/transport";

const PROJECTION_LEASE_MS = 5 * 60 * 1_000;
const PROJECTION_MAX_ATTEMPTS = 5;
const PROJECTION_BATCH_SIZE = Math.min(100, KNOWLEDGE_SEARCH_BULK_MAX_DOCUMENTS);
const PROJECTION_REBUILD_CLAIM_BATCH_SIZE = 128;
const PROJECTION_SEED_BATCH_SIZE = 1_000;

type ProjectionClaim = Readonly<{
  attemptCount: number;
  claimToken: string;
  expectedPassageCount: number;
  id: string;
  indexArtifactId: string;
  projectionFingerprint: string;
}>;

type ProjectionClaimRow = Omit<ProjectionClaim, "claimToken">;

export type KnowledgeSearchProjectionPass = Readonly<{
  claimed: number;
  failed: number;
  projected: number;
  seeded: number;
}>;

export type KnowledgeSearchProjectionReset = Readonly<{
  removed: number;
  reset: number;
}>;

export type KnowledgeSearchProjectionRebuild = KnowledgeSearchProjectionReset & Readonly<{
  claimed: number;
  failed: number;
  projected: number;
  seeded: number;
}>;

export type KnowledgeSearchIntegrity = Readonly<{
  currentMappingDocumentCount: number;
  expectedArtifactCount: number;
  expectedPassageCount: number;
  healthy: boolean;
  incompleteProjectionCount: number;
  missingProjectionCount: number;
  orphanDocumentCount: number;
  projectionCountMismatchCount: number;
  projectionFingerprintMismatchCount: number;
  readyProjectionCount: number;
  staleMappingDocumentCount: number;
  staleProjectionCount: number;
  totalProjectionCount: number;
  version: 1;
}>;

function projectionErrorCode(error: unknown): string {
  if (error instanceof OpenSearchTransportError) return error.code;
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message)) {
    return error.message;
  }
  return "knowledge_search_projection_failed";
}

function passageLayoutKind(input: Readonly<{
  contextPrefix: string;
  documentContext: unknown;
  layoutKind: string | null;
}>): string {
  if (input.layoutKind) return input.layoutKind;
  const context = decodeKnowledgeDocumentContext(input.documentContext);
  if (context) return context.locator.kind;
  const marker = input.contextPrefix.split("\n", 1)[0];
  if (marker === "Evidence layout: table_ambiguous_v1") return "table_ambiguous";
  if (marker === "Evidence layout: table_row_v1") return "table_row";
  return "body";
}

function passageTableContext(value: unknown): string {
  const context = decodeKnowledgeDocumentContext(value);
  if (!context) return "";
  const sourceText = new Set<string>();
  if ("headerLineage" in context.locator) {
    for (const header of context.locator.headerLineage) sourceText.add(header.text);
  }
  for (const observation of context.observations) {
    for (const candidate of [observation.subject, observation.metric, observation.unit]) {
      if (candidate) sourceText.add(candidate);
    }
  }
  return [...sourceText].join("\n").slice(0, 8_192);
}

async function expectedKnowledgeSearchHierarchies(client: PrismaClient) {
  const hierarchies = await client.knowledgeHierarchicalIndexArtifact.findMany({
    orderBy: [
      { sourceArtifactId: "asc" },
      { schemaVersion: "desc" },
      { id: "asc" }
    ],
    select: {
      checksum: true,
      id: true,
      passageCount: true,
      sourceArtifactId: true
    },
    where: {
      checksum: { not: null },
      schemaVersion: {
        in: [...KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS]
      },
      sourceArtifact: {
        state: "ready",
        sourceVersion: {
          source: {
            deletionRequestedAt: null,
            trashedAt: null
          }
        }
      },
      state: "ready"
    }
  });
  return hierarchies.filter((hierarchy, index) =>
    index === 0 || hierarchy.sourceArtifactId !== hierarchies[index - 1]!.sourceArtifactId);
}

async function seedKnowledgeSearchProjections(client: PrismaClient): Promise<number> {
  const latest = await expectedKnowledgeSearchHierarchies(client);
  if (latest.length === 0) return 0;
  const existing = new Map((await client.knowledgeSearchProjection.findMany({
    select: {
      expectedPassageCount: true,
      indexArtifactId: true,
      mappingVersion: true,
      projectionFingerprint: true
    },
    where: { indexArtifactId: { in: latest.map(({ id }) => id) } }
  })).map((projection) => [projection.indexArtifactId, projection]));
  const missing = [];
  const stale = [];
  for (const hierarchy of latest) {
    if (!hierarchy.checksum || !/^[0-9a-f]{64}$/u.test(hierarchy.checksum)) {
      throw new Error("knowledge_search_projection_source_invalid");
    }
    const projectionFingerprint = knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: hierarchy.checksum,
      indexArtifactId: hierarchy.id,
      passageCount: hierarchy.passageCount
    });
    const current = existing.get(hierarchy.id);
    const data = {
      backendKind: KNOWLEDGE_SEARCH_BACKEND_KIND,
      expectedPassageCount: hierarchy.passageCount,
      indexArtifactId: hierarchy.id,
      mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
      projectionFingerprint
    };
    if (!current) {
      missing.push({ ...data, id: randomUUID() });
    } else if (
      current.mappingVersion !== KNOWLEDGE_SEARCH_MAPPING_VERSION ||
      current.projectionFingerprint !== projectionFingerprint ||
      current.expectedPassageCount !== hierarchy.passageCount
    ) {
      stale.push(data);
    }
  }
  if (missing.length > 0) {
    for (let offset = 0; offset < missing.length; offset += PROJECTION_SEED_BATCH_SIZE) {
      await client.knowledgeSearchProjection.createMany({
        data: missing.slice(offset, offset + PROJECTION_SEED_BATCH_SIZE),
        skipDuplicates: true
      });
    }
  }
  for (const projection of stale) {
    await client.knowledgeSearchProjection.update({
      data: {
        ...projection,
        attemptCount: 0,
        claimToken: null,
        indexedPassageCount: 0,
        lastErrorCode: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(),
        readyAt: null,
        state: "PENDING"
      },
      where: { indexArtifactId: projection.indexArtifactId }
    });
  }
  return missing.length + stale.length;
}

async function claimKnowledgeSearchProjectionBatch(
  client: PrismaClient,
  now: Date,
  limit: number
): Promise<readonly ProjectionClaim[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 ||
    limit > PROJECTION_REBUILD_CLAIM_BATCH_SIZE) {
    throw new Error("knowledge_search_projection_limit_invalid");
  }
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + PROJECTION_LEASE_MS);
  const rows = await client.$queryRaw<ProjectionClaimRow[]>(Prisma.sql`
    WITH candidates AS (
      SELECT projection."id"
      FROM "KnowledgeSearchProjection" AS projection
      WHERE (
        projection."state" IN ('PENDING', 'RETRY_WAIT')
          AND projection."nextAttemptAt" <= ${now}
        OR projection."state" = 'BUILDING'
          AND projection."leaseExpiresAt" < ${now}
      )
        AND projection."attemptCount" < ${PROJECTION_MAX_ATTEMPTS}
      ORDER BY projection."nextAttemptAt", projection."createdAt", projection."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE "KnowledgeSearchProjection" AS projection
    SET
      "attemptCount" = projection."attemptCount" + 1,
      "claimToken" = ${claimToken},
      "lastErrorCode" = NULL,
      "leaseExpiresAt" = ${leaseExpiresAt},
      "startedAt" = COALESCE(projection."startedAt", ${now}),
      "state" = 'BUILDING',
      "updatedAt" = ${now}
    FROM candidates
    WHERE projection."id" = candidates."id"
    RETURNING
      projection."id",
      projection."indexArtifactId",
      projection."projectionFingerprint",
      projection."expectedPassageCount",
      projection."attemptCount"
  `);
  return Object.freeze(rows.map((row) => Object.freeze({ ...row, claimToken })));
}

async function projectionDocuments(
  client: PrismaClient,
  claim: ProjectionClaim
): Promise<readonly KnowledgeSearchDocument[]> {
  const hierarchy = await client.knowledgeHierarchicalIndexArtifact.findUnique({
    select: {
      checksum: true,
      passageCount: true,
      passageIndexes: {
        orderBy: { ordinal: "asc" },
        select: {
          contentHash: true,
          contextPrefix: true,
          documentContext: true,
          headingPath: true,
          id: true,
          layoutKind: true,
          text: true
        }
      },
      sourceArtifact: {
        select: {
          sourceVersion: {
            select: {
              id: true,
              ownerUserId: true,
              source: {
                select: { deletionRequestedAt: true, trashedAt: true }
              }
            }
          },
          state: true
        }
      },
      state: true
    },
    where: { id: claim.indexArtifactId }
  });
  if (!hierarchy || hierarchy.state !== "ready" || !hierarchy.checksum ||
    hierarchy.sourceArtifact.state !== "ready" ||
    hierarchy.sourceArtifact.sourceVersion.source.trashedAt !== null ||
    hierarchy.sourceArtifact.sourceVersion.source.deletionRequestedAt !== null ||
    hierarchy.passageCount !== claim.expectedPassageCount ||
    hierarchy.passageIndexes.length !== claim.expectedPassageCount ||
    knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: hierarchy.checksum,
      indexArtifactId: claim.indexArtifactId,
      passageCount: hierarchy.passageCount
    }) !== claim.projectionFingerprint) {
    throw new Error("knowledge_search_projection_source_invalid");
  }
  return Object.freeze(hierarchy.passageIndexes.map((passage) => Object.freeze({
    body: passage.text,
    contentHash: passage.contentHash,
    heading: passage.headingPath.join("\n"),
    indexArtifactId: claim.indexArtifactId,
    layoutKind: passageLayoutKind(passage),
    ownerUserId: hierarchy.sourceArtifact.sourceVersion.ownerUserId,
    passageId: passage.id,
    sourceVersionId: hierarchy.sourceArtifact.sourceVersion.id,
    tableContext: passageTableContext(passage.documentContext)
  })));
}

async function settleProjectionFailure(
  client: PrismaClient,
  claim: ProjectionClaim,
  error: unknown,
  now: Date
): Promise<void> {
  const terminal = claim.attemptCount >= PROJECTION_MAX_ATTEMPTS;
  await client.knowledgeSearchProjection.updateMany({
    data: {
      claimToken: null,
      lastErrorCode: projectionErrorCode(error),
      leaseExpiresAt: null,
      nextAttemptAt: new Date(now.getTime() + claim.attemptCount * 30_000),
      state: terminal ? "FAILED" : "RETRY_WAIT"
    },
    where: { claimToken: claim.claimToken, id: claim.id, state: "BUILDING" }
  });
}

async function settleProjectionSuccess(
  client: PrismaClient,
  claim: ProjectionClaim,
  indexedPassageCount: number,
  now = new Date()
): Promise<void> {
  const settled = await client.knowledgeSearchProjection.updateMany({
    data: {
      claimToken: null,
      indexedPassageCount,
      lastErrorCode: null,
      leaseExpiresAt: null,
      readyAt: now,
      state: "READY"
    },
    where: {
      claimToken: claim.claimToken,
      id: claim.id,
      projectionFingerprint: claim.projectionFingerprint,
      state: "BUILDING"
    }
  });
  if (settled.count !== 1) throw new Error("knowledge_search_projection_lease_lost");
}

async function projectClaim(input: Readonly<{
  claim: ProjectionClaim;
  client: PrismaClient;
  search: AiqsaOpenSearchTransport;
}>): Promise<void> {
  const documents = await projectionDocuments(input.client, input.claim);
  await input.search.deleteKnowledgeArtifact(input.claim.indexArtifactId);
  for (let offset = 0; offset < documents.length; offset += PROJECTION_BATCH_SIZE) {
    await input.search.bulkUpsertKnowledgeDocuments(
      documents.slice(offset, offset + PROJECTION_BATCH_SIZE)
    );
  }
  await input.search.refreshKnowledgeIndex();
  const indexedPassageCount = await input.search.countKnowledgeArtifact(
    input.claim.indexArtifactId
  );
  if (indexedPassageCount !== input.claim.expectedPassageCount) {
    throw new Error("knowledge_search_projection_count_mismatch");
  }
  await settleProjectionSuccess(input.client, input.claim, indexedPassageCount);
}

export async function runKnowledgeSearchProjectionPass(input: Readonly<{
  client: PrismaClient;
  limit?: number;
  search?: AiqsaOpenSearchTransport;
}>): Promise<KnowledgeSearchProjectionPass> {
  const limit = input.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
    throw new Error("knowledge_search_projection_limit_invalid");
  }
  const search = input.search ?? createKnowledgeOpenSearchTransport();
  await search.ensureKnowledgeIndex();
  const seeded = await seedKnowledgeSearchProjections(input.client);
  let claimed = 0;
  let failed = 0;
  let projected = 0;
  const claims = await claimKnowledgeSearchProjectionBatch(input.client, new Date(), limit);
  for (const claim of claims) {
    claimed += 1;
    try {
      await projectClaim({ claim, client: input.client, search });
      projected += 1;
    } catch (error) {
      failed += 1;
      await settleProjectionFailure(input.client, claim, error, new Date());
    }
  }
  return Object.freeze({ claimed, failed, projected, seeded });
}

async function bulkProjectionDocuments(
  search: AiqsaOpenSearchTransport,
  documents: readonly KnowledgeSearchDocument[]
): Promise<void> {
  if (documents.length === 0) return;
  try {
    await search.bulkUpsertKnowledgeDocuments(documents);
  } catch (error) {
    if (error instanceof OpenSearchTransportError &&
      error.code === "opensearch_response_too_large" && documents.length > 1) {
      const middle = Math.ceil(documents.length / 2);
      await bulkProjectionDocuments(search, documents.slice(0, middle));
      await bulkProjectionDocuments(search, documents.slice(middle));
      return;
    }
    throw error;
  }
}

async function projectRebuildClaims(input: Readonly<{
  claims: readonly ProjectionClaim[];
  client: PrismaClient;
  search: AiqsaOpenSearchTransport;
}>): Promise<Readonly<{ failed: number; projected: number }>> {
  let buffered: KnowledgeSearchDocument[] = [];
  const flush = async (): Promise<void> => {
    if (buffered.length === 0) return;
    const documents = buffered;
    buffered = [];
    await bulkProjectionDocuments(input.search, documents);
  };
  try {
    for (const claim of input.claims) {
      const documents = await projectionDocuments(input.client, claim);
      for (const document of documents) {
        buffered.push(document);
        if (buffered.length === PROJECTION_BATCH_SIZE) await flush();
      }
    }
    await flush();
    await input.search.refreshKnowledgeIndex();
    const indexed = new Map((await input.search.countKnowledgeArtifacts(
      input.claims.map(({ indexArtifactId }) => indexArtifactId)
    )).map((entry) => [entry.indexArtifactId, entry.count]));
    let failed = 0;
    let projected = 0;
    for (const claim of input.claims) {
      const indexedPassageCount = indexed.get(claim.indexArtifactId) ?? 0;
      if (indexedPassageCount !== claim.expectedPassageCount) {
        failed += 1;
        await settleProjectionFailure(
          input.client,
          claim,
          new Error("knowledge_search_projection_count_mismatch"),
          new Date()
        );
      } else {
        projected += 1;
        await settleProjectionSuccess(
          input.client,
          claim,
          indexedPassageCount
        );
      }
    }
    return Object.freeze({ failed, projected });
  } catch (error) {
    for (const claim of input.claims) {
      await settleProjectionFailure(input.client, claim, error, new Date());
    }
    throw error;
  }
}

/** Fast, bounded operator rebuild for a freshly recreated derived index.
 * Documents are streamed from canonical PostgreSQL in small bulk requests;
 * one refresh and one aggregate count settle each bounded claim batch. */
export async function rebuildKnowledgeSearchProjections(input: Readonly<{
  client: PrismaClient;
  search?: AiqsaOpenSearchTransport;
}>): Promise<KnowledgeSearchProjectionRebuild> {
  const search = input.search ?? createKnowledgeOpenSearchTransport();
  await search.recreateKnowledgeIndex();
  const reset = await resetKnowledgeSearchProjections(input.client);
  const seeded = await seedKnowledgeSearchProjections(input.client);
  let claimed = 0;
  let failed = 0;
  let projected = 0;
  while (true) {
    const claims = await claimKnowledgeSearchProjectionBatch(
      input.client,
      new Date(),
      PROJECTION_REBUILD_CLAIM_BATCH_SIZE
    );
    if (claims.length === 0) break;
    claimed += claims.length;
    const result = await projectRebuildClaims({ claims, client: input.client, search });
    failed += result.failed;
    projected += result.projected;
  }
  return Object.freeze({ ...reset, claimed, failed, projected, seeded });
}

/** Explicit operator rebuild boundary. Retrieval remains fail-closed until
 * every accepted artifact returns to READY; no old lexical backend is used. */
export async function resetKnowledgeSearchProjections(
  client: PrismaClient,
  now = new Date()
): Promise<KnowledgeSearchProjectionReset> {
  const expected = await expectedKnowledgeSearchHierarchies(client);
  const expectedIds = expected.map(({ id }) => id);
  const removed = await client.knowledgeSearchProjection.deleteMany({
    where: expectedIds.length > 0
      ? { indexArtifactId: { notIn: expectedIds } }
      : {}
  });
  const reset = expectedIds.length === 0
    ? { count: 0 }
    : await client.knowledgeSearchProjection.updateMany({
      data: {
        attemptCount: 0,
        claimToken: null,
        indexedPassageCount: 0,
        lastErrorCode: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        readyAt: null,
        startedAt: null,
        state: "PENDING"
      },
      where: { indexArtifactId: { in: expectedIds } }
    });
  return Object.freeze({ removed: removed.count, reset: reset.count });
}

export async function inspectKnowledgeSearchIntegrity(input: Readonly<{
  client: PrismaClient;
  search?: AiqsaOpenSearchTransport;
}>): Promise<KnowledgeSearchIntegrity> {
  const search = input.search ?? createKnowledgeOpenSearchTransport();
  await search.ensureKnowledgeIndex();
  const [expected, projections, inventory] = await Promise.all([
    expectedKnowledgeSearchHierarchies(input.client),
    input.client.knowledgeSearchProjection.findMany({
      select: {
        backendKind: true,
        expectedPassageCount: true,
        indexedPassageCount: true,
        indexArtifactId: true,
        mappingVersion: true,
        projectionFingerprint: true,
        state: true
      }
    }),
    search.inspectKnowledgeIndex()
  ]);
  const expectedIds = new Set(expected.map(({ id }) => id));
  const projectionByArtifact = new Map(projections.map((projection) => [
    projection.indexArtifactId,
    projection
  ]));
  const indexedCountByArtifact = new Map(inventory.artifactCounts.map((entry) => [
    entry.indexArtifactId,
    entry.count
  ]));
  let expectedPassageCount = 0;
  let incompleteProjectionCount = 0;
  let missingProjectionCount = 0;
  let projectionCountMismatchCount = 0;
  let projectionFingerprintMismatchCount = 0;
  let readyProjectionCount = 0;
  for (const hierarchy of expected) {
    if (!hierarchy.checksum || !/^[0-9a-f]{64}$/u.test(hierarchy.checksum)) {
      throw new Error("knowledge_search_projection_source_invalid");
    }
    expectedPassageCount += hierarchy.passageCount;
    const wantedFingerprint = knowledgeSearchProjectionFingerprint({
      hierarchicalChecksum: hierarchy.checksum,
      indexArtifactId: hierarchy.id,
      passageCount: hierarchy.passageCount
    });
    const projection = projectionByArtifact.get(hierarchy.id);
    if (!projection) {
      missingProjectionCount += 1;
    } else {
      const fingerprintMatches = projection.projectionFingerprint === wantedFingerprint;
      if (!fingerprintMatches) projectionFingerprintMismatchCount += 1;
      if (projection.backendKind === KNOWLEDGE_SEARCH_BACKEND_KIND &&
        projection.mappingVersion === KNOWLEDGE_SEARCH_MAPPING_VERSION &&
        fingerprintMatches && projection.expectedPassageCount === hierarchy.passageCount &&
        projection.indexedPassageCount === hierarchy.passageCount &&
        projection.state === "READY") {
        readyProjectionCount += 1;
      } else {
        incompleteProjectionCount += 1;
      }
    }
    if ((indexedCountByArtifact.get(hierarchy.id) ?? 0) !== hierarchy.passageCount) {
      projectionCountMismatchCount += 1;
    }
  }
  const staleProjectionCount = projections.filter((projection) =>
    !expectedIds.has(projection.indexArtifactId)).length;
  const orphanDocumentCount = inventory.artifactCounts.reduce((total, entry) =>
    total + (expectedIds.has(entry.indexArtifactId) ? 0 : entry.count), 0);
  const healthy = missingProjectionCount === 0 && incompleteProjectionCount === 0 &&
    projectionCountMismatchCount === 0 && projectionFingerprintMismatchCount === 0 &&
    staleProjectionCount === 0 && orphanDocumentCount === 0 &&
    inventory.staleMappingDocumentCount === 0 &&
    inventory.currentMappingDocumentCount === expectedPassageCount;
  return Object.freeze({
    currentMappingDocumentCount: inventory.currentMappingDocumentCount,
    expectedArtifactCount: expected.length,
    expectedPassageCount,
    healthy,
    incompleteProjectionCount,
    missingProjectionCount,
    orphanDocumentCount,
    projectionCountMismatchCount,
    projectionFingerprintMismatchCount,
    readyProjectionCount,
    staleMappingDocumentCount: inventory.staleMappingDocumentCount,
    staleProjectionCount,
    totalProjectionCount: projections.length,
    version: 1
  });
}

export async function deleteKnowledgeSearchArtifacts(input: Readonly<{
  indexArtifactIds: readonly string[];
  search?: AiqsaOpenSearchTransport;
}>): Promise<void> {
  const search = input.search ?? createKnowledgeOpenSearchTransport();
  await search.ensureKnowledgeIndex();
  for (const indexArtifactId of [...new Set(input.indexArtifactIds)].sort()) {
    await search.deleteKnowledgeArtifact(indexArtifactId);
  }
}

import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchConfiguration,
  type MemoryOpenSearchDocument,
  type MemoryOpenSearchMutation
} from "../../search/opensearch/memoryContract";
import {
  OpenSearchTransportError
} from "../../search/opensearch/coreTransport";
import type {
  MemoryOpenSearchClient
} from "../../search/opensearch/memoryClient";
import type {
  MemoryLexicalProjectionClaim,
  MemoryLexicalProjectionIntegrity,
  MemoryLexicalProjectionReset,
  MemoryLexicalProjectionStore,
  MemoryLexicalProjectionVerificationCandidate
} from "./repository";

const errorCodePattern = /^[a-z0-9_]{1,64}$/u;

export type MemoryLexicalProjectionWorkerConfiguration = Readonly<{
  intervalMs: number;
  leaseMs: number;
  maximumAttempts: number;
  projectionBatch: number;
  verificationBatch: number;
}>;

export type MemoryLexicalProjectionPass = Readonly<{
  claimed: number;
  failed: number;
  integrityFailed: number;
  projected: number;
  purged: number;
  verifiedReady: number;
}>;

// Projection events are ordered per owner, so a busy queue can expose only a
// small claimable head even when thousands of later events are pending. Do not
// run an expensive full-generation visibility check after every such head.
// The CLI still forces bounded verification during sustained traffic, and an
// idle pass always verifies immediately before sleeping or declaring drain.
export const MEMORY_LEXICAL_PROJECTION_MAX_DEFERRED_VERIFICATION_PASSES = 64;

export function shouldDeferMemoryLexicalProjectionVerification(
  deferredPasses: number
): boolean {
  if (!Number.isSafeInteger(deferredPasses) || deferredPasses < 0 ||
    deferredPasses > MEMORY_LEXICAL_PROJECTION_MAX_DEFERRED_VERIFICATION_PASSES) {
    throw new Error("memory_lexical_projection_verification_schedule_invalid");
  }
  return deferredPasses <
    MEMORY_LEXICAL_PROJECTION_MAX_DEFERRED_VERIFICATION_PASSES;
}

export function nextMemoryLexicalProjectionDeferredVerificationPasses(
  deferredPasses: number,
  claimed: number
): number {
  if (!Number.isSafeInteger(claimed) || claimed < 0) {
    throw new Error("memory_lexical_projection_verification_schedule_invalid");
  }
  return claimed > 0 &&
    shouldDeferMemoryLexicalProjectionVerification(deferredPasses)
    ? deferredPasses + 1
    : 0;
}

export function shouldRunMemoryLexicalProjectionMaintenance(
  indexValidated: boolean,
  deferredPasses: number
): boolean {
  return !indexValidated ||
    !shouldDeferMemoryLexicalProjectionVerification(deferredPasses);
}

export type MemoryLexicalProjectionRebuild = Readonly<{
  failed: number;
  integrity: MemoryLexicalProjectionIntegrity;
  projected: number;
  purged: number;
  reset: MemoryLexicalProjectionReset;
  verifiedReady: number;
}>;

export type MemoryLexicalProjectionAudit = Readonly<{
  checkedGenerations: number;
  integrity: MemoryLexicalProjectionIntegrity;
  mismatchedGenerations: number;
}>;

type MemoryLexicalProjectionPassInput = Readonly<{
  configuration: MemoryLexicalProjectionWorkerConfiguration;
  deferVerification?: boolean;
  now?: Date;
  openSearchConfiguration: MemoryOpenSearchConfiguration;
  search: MemoryOpenSearchClient;
  skipIndexValidation?: boolean;
  store: MemoryLexicalProjectionStore;
}>;

function integerFromEnvironment(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("memory_lexical_projection_worker_configuration_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("memory_lexical_projection_worker_configuration_invalid");
  }
  return parsed;
}

export function memoryLexicalProjectionWorkerConfigurationFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): MemoryLexicalProjectionWorkerConfiguration {
  return Object.freeze({
    intervalMs: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_PROJECTION_INTERVAL_MS,
      2_000,
      250,
      60_000
    ),
    leaseMs: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_PROJECTION_LEASE_MS,
      120_000,
      10_000,
      10 * 60_000
    ),
    maximumAttempts: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_PROJECTION_MAX_ATTEMPTS,
      8,
      1,
      20
    ),
    projectionBatch: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_PROJECTION_BATCH,
      16,
      1,
      100
    ),
    verificationBatch: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_VERIFICATION_BATCH,
      4,
      1,
      100
    )
  });
}

function projectionErrorCode(error: unknown): string {
  if (error instanceof OpenSearchTransportError) return error.code;
  if (error instanceof Error && errorCodePattern.test(error.message)) {
    return error.message;
  }
  return "memory_lexical_projection_failed";
}

function deleteMutation(
  claim: MemoryLexicalProjectionClaim,
  routing: string
): MemoryOpenSearchMutation {
  if (!claim.searchEntryId) {
    throw new Error("memory_lexical_projection_entry_missing");
  }
  return Object.freeze({
    operation: "DELETE",
    routing,
    searchEntryId: claim.searchEntryId,
    sequence: claim.sequence
  });
}

async function preparePointMutation(input: Readonly<{
  claim: MemoryLexicalProjectionClaim;
  configuration: MemoryOpenSearchConfiguration;
  store: MemoryLexicalProjectionStore;
}>): Promise<MemoryOpenSearchMutation> {
  const routing = memoryOpenSearchUserScope(
    input.claim.userId,
    input.configuration
  );
  if (input.claim.operation === "PURGE_USER" ||
    input.claim.operation === "PURGE_GENERATION") {
    throw new Error("memory_lexical_projection_point_operation_invalid");
  }
  if (input.claim.operation === "DELETE_ENTRY") {
    return deleteMutation(input.claim, routing);
  }
  const canonical = await input.store.loadCanonicalEntry(input.claim);
  if (!canonical) return deleteMutation(input.claim, routing);
  if (canonical.userId !== input.claim.userId ||
    canonical.indexGenerationId !== input.claim.indexGenerationId ||
    canonical.searchEntryId !== input.claim.searchEntryId) {
    throw new Error("memory_lexical_projection_canonical_identity_invalid");
  }
  const document: MemoryOpenSearchDocument = Object.freeze({
    analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
    generationId: canonical.indexGenerationId,
    itemType: canonical.itemType,
    lexicalText: canonical.lexicalText,
    mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
    normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
    projectionSequence: input.claim.sequence,
    retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
    safeContentHash: canonical.safeContentHash,
    searchEntryId: canonical.searchEntryId,
    sourceChatId: canonical.sourceChatId,
    userScope: routing
  });
  return Object.freeze({
    document,
    operation: "UPSERT",
    routing,
    sequence: input.claim.sequence
  });
}

async function projectPurge(input: Readonly<{
  claim: MemoryLexicalProjectionClaim;
  configuration: MemoryOpenSearchConfiguration;
  now: Date;
  search: MemoryOpenSearchClient;
  store: MemoryLexicalProjectionStore;
}>): Promise<void> {
  const routing = memoryOpenSearchUserScope(
    input.claim.userId,
    input.configuration
  );
  if (input.claim.operation === "PURGE_USER") {
    if (!await input.store.purgeFenceExists(input.claim)) {
      throw new Error("memory_lexical_projection_user_purge_fence_missing");
    }
    await input.search.purgeUser({ routing, userScope: routing });
    await input.store.settleSuccess(input.claim, input.now);
    return;
  }
  if (input.claim.operation === "PURGE_GENERATION") {
    if (!input.claim.indexGenerationId ||
      !await input.store.purgeFenceExists(input.claim)) {
      throw new Error("memory_lexical_projection_generation_purge_fence_missing");
    }
    await input.search.purgeGeneration({
      generationId: input.claim.indexGenerationId,
      routing,
      userScope: routing
    });
    await input.store.settleSuccess(input.claim, input.now);
    return;
  }
  throw new Error("memory_lexical_projection_purge_operation_invalid");
}

async function verifyCandidate(input: Readonly<{
  candidate: MemoryLexicalProjectionVerificationCandidate;
  configuration: MemoryOpenSearchConfiguration;
  now: Date;
  search: MemoryOpenSearchClient;
  store: MemoryLexicalProjectionStore;
}>): Promise<boolean> {
  const expected = await input.store.expectedGeneration(input.candidate);
  if (!expected) return false;
  await input.search.refreshIndex();
  const routing = memoryOpenSearchUserScope(
    input.candidate.userId,
    input.configuration
  );
  const visible = await input.search.inspectGeneration({
    generationId: input.candidate.indexGenerationId,
    routing,
    userScope: routing
  });
  return input.store.settleIntegrity({
    contractFingerprint: memoryOpenSearchProjectionFingerprint(
      input.configuration
    ),
    expected,
    indexGenerationId: input.candidate.indexGenerationId,
    now: input.now,
    userId: input.candidate.userId,
    visibleDocumentCount: visible.documentCount,
    visibleFingerprint: visible.fingerprint
  });
}

async function executeMemoryLexicalProjectionPass(
  input: MemoryLexicalProjectionPassInput,
  requireActiveAlias: boolean
): Promise<MemoryLexicalProjectionPass> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("memory_lexical_projection_clock_invalid");
  }
  if (requireActiveAlias && !input.skipIndexValidation) {
    await input.search.ensureIndex();
  }
  const claims = await input.store.claim({
    leaseMs: input.configuration.leaseMs,
    limit: input.configuration.projectionBatch,
    maximumAttempts: input.configuration.maximumAttempts,
    now
  });
  let failed = 0;
  let projected = 0;
  let purged = 0;
  const pointMutations: Array<Readonly<{
    claim: MemoryLexicalProjectionClaim;
    mutation: MemoryOpenSearchMutation;
  }>> = [];
  for (const claim of claims) {
    try {
      if (claim.operation === "PURGE_USER" ||
        claim.operation === "PURGE_GENERATION") {
        await projectPurge({
          claim,
          configuration: input.openSearchConfiguration,
          now,
          search: input.search,
          store: input.store
        });
        purged += 1;
      } else {
        pointMutations.push(Object.freeze({
          claim,
          mutation: await preparePointMutation({
            claim,
            configuration: input.openSearchConfiguration,
            store: input.store
          })
        }));
      }
    } catch (error) {
      failed += 1;
      await input.store.settleFailure(claim, {
        errorCode: projectionErrorCode(error),
        maximumAttempts: input.configuration.maximumAttempts,
        now
      });
    }
  }
  if (pointMutations.length > 0) {
    let bulkError: unknown = null;
    try {
      await input.search.applyMutations(
        pointMutations.map(({ mutation }) => mutation),
        "NONE"
      );
    } catch (error) {
      bulkError = error;
    }
    if (bulkError === null) {
      const settlements = await Promise.allSettled(pointMutations.map(
        ({ claim }) => input.store.settleSuccess(claim, now)
      ));
      for (const [index, settlement] of settlements.entries()) {
        if (settlement.status === "fulfilled") {
          projected += 1;
          continue;
        }
        failed += 1;
        await input.store.settleFailure(pointMutations[index]!.claim, {
          errorCode: projectionErrorCode(settlement.reason),
          maximumAttempts: input.configuration.maximumAttempts,
          now
        });
      }
    } else {
      const errorCode = projectionErrorCode(bulkError);
      failed += pointMutations.length;
      for (const { claim } of pointMutations) {
        await input.store.settleFailure(claim, {
          errorCode,
          maximumAttempts: input.configuration.maximumAttempts,
          now
        });
      }
    }
  }

  let integrityFailed = 0;
  let verifiedReady = 0;
  if (!input.deferVerification || claims.length === 0) {
    const candidates = await input.store.listVerificationCandidates(
      input.configuration.verificationBatch
    );
    for (const candidate of candidates) {
      try {
        if (await verifyCandidate({
          candidate,
          configuration: input.openSearchConfiguration,
          now,
          search: input.search,
          store: input.store
        })) verifiedReady += 1;
        else integrityFailed += 1;
      } catch (error) {
        integrityFailed += 1;
        await input.store.markVerificationFailure({
          candidate,
          errorCode: projectionErrorCode(error),
          now
        });
      }
    }
  }
  return Object.freeze({
    claimed: claims.length,
    failed,
    integrityFailed,
    projected,
    purged,
    verifiedReady
  });
}

export async function runMemoryLexicalProjectionPass(
  input: MemoryLexicalProjectionPassInput
): Promise<MemoryLexicalProjectionPass> {
  return executeMemoryLexicalProjectionPass(input, true);
}

export async function auditMemoryLexicalProjection(
  input: MemoryLexicalProjectionPassInput
): Promise<MemoryLexicalProjectionAudit> {
  await input.search.ensureIndex();
  await input.search.refreshIndex();
  const projectionFingerprint = memoryOpenSearchProjectionFingerprint(
    input.openSearchConfiguration
  );
  let after: MemoryLexicalProjectionVerificationCandidate | null = null;
  let checkedGenerations = 0;
  let mismatchedGenerations = 0;
  while (true) {
    const candidates = await input.store.listIntegrityCandidates({
      after,
      limit: input.configuration.verificationBatch
    });
    for (const candidate of candidates) {
      checkedGenerations += 1;
      const expected = await input.store.expectedGeneration(candidate);
      if (!expected) {
        mismatchedGenerations += 1;
        continue;
      }
      const routing = memoryOpenSearchUserScope(
        candidate.userId,
        input.openSearchConfiguration
      );
      const visible = await input.search.inspectGeneration({
        generationId: candidate.indexGenerationId,
        routing,
        userScope: routing
      });
      if (expected.backendKind !== MEMORY_OPENSEARCH_BACKEND_KIND ||
        expected.mappingVersion !== MEMORY_OPENSEARCH_MAPPING_VERSION ||
        expected.normalizationVersion !== MEMORY_OPENSEARCH_NORMALIZATION_VERSION ||
        expected.analysisProfile !== MEMORY_OPENSEARCH_ANALYSIS_PROFILE ||
        expected.retrievalPipelineVersion !==
          MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION ||
        expected.projectionFingerprint !== projectionFingerprint ||
        expected.visibleThroughSequence !== expected.enqueuedThroughSequence ||
        expected.documentCount !== visible.documentCount ||
        expected.fingerprint !== visible.fingerprint) {
        mismatchedGenerations += 1;
      }
    }
    if (candidates.length < input.configuration.verificationBatch) break;
    after = candidates.at(-1)!;
  }
  return Object.freeze({
    checkedGenerations,
    integrity: await input.store.inspect(),
    mismatchedGenerations
  });
}

export async function rebuildMemoryLexicalProjection(
  input: MemoryLexicalProjectionPassInput
): Promise<MemoryLexicalProjectionRebuild> {
  const now = input.now ?? new Date();
  // A replacement-index preflight may reject a reused build ID or an
  // incompatible cluster before any derived PostgreSQL readiness state is
  // changed. An unaliased index left behind by a later reset failure is safe:
  // the next preflight deletes and recreates that exact replacement target.
  await input.search.prepareReplacementIndex();
  const reset = await input.store.reset({ mode: "REBUILD", now });
  let failed = 0;
  let projected = 0;
  let purged = 0;
  let verifiedReady = 0;
  while (true) {
    const pass = await executeMemoryLexicalProjectionPass(
      { ...input, now: new Date() },
      false
    );
    failed += pass.failed + pass.integrityFailed;
    projected += pass.projected;
    purged += pass.purged;
    verifiedReady += pass.verifiedReady;
    if (pass.claimed === 0 && pass.verifiedReady === 0) break;
  }
  const integrity = await input.store.inspect();
  if (failed !== 0 || integrity.blockedEvents !== 0 ||
    integrity.claimedEvents !== 0 || integrity.degradedGenerations !== 0 ||
    integrity.outstandingEvents !== 0 ||
    integrity.readyGenerations + integrity.retiredGenerations !==
      integrity.totalGenerations) {
    throw new Error("memory_lexical_projection_rebuild_incomplete");
  }
  await input.search.activateReplacementIndex();
  return Object.freeze({
    failed,
    integrity,
    projected,
    purged,
    reset,
    verifiedReady
  });
}

export function memoryLexicalProjectionRuntimeConfigurationFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Readonly<{
  openSearch: MemoryOpenSearchConfiguration;
  worker: MemoryLexicalProjectionWorkerConfiguration;
}> {
  return Object.freeze({
    openSearch: memoryOpenSearchConfigurationFromEnv(env),
    worker: memoryLexicalProjectionWorkerConfigurationFromEnv(env)
  });
}

import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { memorySha256 } from "../memory/persistence/lexical";
import {
  createPrismaKnowledgeEvidenceDispatchRepository,
  decodeKnowledgeProviderAttemptUsage,
  KnowledgeEvidenceDispatchRepositoryError,
  KNOWLEDGE_PROVIDER_ATTEMPT_PURPOSE_STORAGE_LIMIT,
  loadFinalKnowledgeGroundingDispatch,
  loadSettledKnowledgeAnswerGroundingOperations,
  loadSettledKnowledgeAnswerGroundingOperationsV21,
  type KnowledgeEvidenceDispatchBinding,
  type KnowledgeProviderAttemptUsage,
  type ReserveKnowledgeEvidenceDispatchInput
} from "./evidenceDispatchRepository";
import {
  packKnowledgeEvidenceDispatchManifest,
  type CurrentKnowledgeEvidenceDispatchCandidate,
  type KnowledgeEvidenceDispatchManifestDraft
} from "./evidenceDispatchManifest";
import {
  createKnowledgeAnswerOperationRequestSnapshotV1,
  knowledgeAnswerDraftPromptForPair,
  knowledgeAnswerHash,
  knowledgeCoveragePlannerPrompt,
  knowledgeGroundedSelectorPromptForPair,
  knowledgeSelectorEvidenceFromManifest,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V15_V11,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V6,
  KNOWLEDGE_COVERAGE_PLAN_SCHEMA_V1,
  KNOWLEDGE_COVERAGE_PLANNER_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V9
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeAnswerDraftV21,
  knowledgeAnswerDraftPromptV21
} from "./answerGroundingV21";
import {
  KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V5,
  KNOWLEDGE_COVERAGE_SCOPE_V5_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_V5_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION,
  decodeKnowledgeCoverageScopeV5,
  knowledgeCoverageEvidenceFromManifestV5,
  knowledgeCoverageScopeFailureV5,
  knowledgeCoverageScopePromptV5
} from "./coverageScopeV5";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V20,
  KNOWLEDGE_GROUNDED_SELECTOR_V20_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_V20_MAX_OUTPUT_TOKENS,
  decodeKnowledgeGroundedSelectorV20,
  knowledgeGroundedSelectorPromptV20
} from "./answerGroundingSelectorV20";

const NOW = new Date("2026-08-19T10:00:00.000Z");
const LEASE = new Date("2026-08-19T10:05:00.000Z");
const DISPATCHED = new Date("2026-08-19T10:01:00.000Z");
const DISPATCH_LEASE = new Date("2026-08-19T10:06:00.000Z");
const SETTLED = new Date("2026-08-19T10:02:00.000Z");

type FakeState = Readonly<{
  attempts: Record<string, unknown>[];
  evidenceItems: Record<string, unknown>[];
  exclusions: Record<string, unknown>[];
  items: Record<string, unknown>[];
  manifests: Record<string, unknown>[];
  sourceBindings: Record<string, unknown>[];
}>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fake_expected_object");
  }
  return value as Record<string, unknown>;
}

function nested(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => object(current)[key], value);
}

function date(value: unknown): Date {
  if (!(value instanceof Date)) throw new Error("fake_expected_date");
  return value;
}

function inputArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("fake_expected_array");
  return value.map(object);
}

function createFakePrisma(input: Readonly<{
  evidenceItems?: Record<string, unknown>[];
  knowledgeRuns?: Record<string, unknown>[];
  loseRecoveryClaim?: boolean;
  sourceBindings?: Record<string, unknown>[];
}> = {}): Readonly<{ client: PrismaClient; executeRaw: ReturnType<typeof vi.fn>; state: FakeState }> {
  const state: FakeState = {
    attempts: [],
    evidenceItems: input.evidenceItems ?? [{
      excerpt: "Verified excerpt",
      fileName: "source.txt",
      handle: "K1",
      id: "evidence-item-1",
      retrievalSessionId: "session-1",
      sourceArtifactId: "artifact-1",
      sourceName: "Source",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 1,
      state: "available",
      textTruncated: false
    }],
    exclusions: [],
    items: [],
    manifests: [],
    sourceBindings: input.sourceBindings ?? [{
      fileNameSnapshot: "source.txt",
      profileBinding: { profileRevisionId: "profile-revision-1" },
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceNameSnapshot: "Source",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 1
    }]
  };
  const executeRaw = vi.fn(async () => 0);
  let loseRecoveryClaim = input.loseRecoveryClaim ?? false;

  const attemptFind = async (args: unknown) => {
    const where = object(nested(args, "where"));
    if (where.id !== undefined) {
      return state.attempts.find((attempt) => attempt.id === where.id) ?? null;
    }
    if (where.modelRunId_ordinal !== undefined) {
      const key = object(where.modelRunId_ordinal);
      return state.attempts.find((attempt) =>
        attempt.modelRunId === key.modelRunId && attempt.ordinal === key.ordinal) ?? null;
    }
    const key = object(where.modelRunId_idempotencyKey);
    return state.attempts.find((attempt) =>
      attempt.modelRunId === key.modelRunId && attempt.idempotencyKey === key.idempotencyKey) ?? null;
  };
  const attemptFindMany = async (args: unknown) => {
    const inputArgs = object(args);
    const where = object(inputArgs.where);
    const purposeFilter = where.purpose === undefined
      ? null
      : object(where.purpose).in;
    const purposes = Array.isArray(purposeFilter) ? new Set(purposeFilter) : null;
    const ascending = object(inputArgs.orderBy).ordinal === "asc";
    const take = inputArgs.take === undefined
      ? state.attempts.length
      : Number(inputArgs.take);
    return state.attempts
      .filter((attempt) => attempt.modelRunId === where.modelRunId &&
        (!purposes || purposes.has(attempt.purpose)))
      .sort((left, right) => ascending
        ? Number(left.ordinal) - Number(right.ordinal)
        : Number(right.ordinal) - Number(left.ordinal))
      .slice(0, take);
  };
  const attemptUpdateMany = async (args: unknown) => {
    const where = object(nested(args, "where"));
    const data = object(nested(args, "data"));
    const attempt = state.attempts.find((candidate) => {
      if (candidate.id !== where.id || candidate.modelRunId !== where.modelRunId ||
        candidate.state !== where.state || candidate.leaseToken !== where.leaseToken) return false;
      if (where.leaseExpiresAt) {
        if (where.leaseExpiresAt instanceof Date) {
          return candidate.leaseExpiresAt instanceof Date &&
            candidate.leaseExpiresAt.valueOf() === where.leaseExpiresAt.valueOf();
        }
        const leaseCondition = object(where.leaseExpiresAt);
        if (leaseCondition.gt !== undefined) {
          const gt = date(leaseCondition.gt);
          return candidate.leaseExpiresAt instanceof Date && candidate.leaseExpiresAt > gt;
        }
      }
      return true;
    });
    if (!attempt) return { count: 0 };
    if (loseRecoveryClaim) {
      loseRecoveryClaim = false;
      Object.assign(attempt, {
        leaseExpiresAt: data.leaseExpiresAt,
        leaseToken: "lease:worker:winner",
        updatedAt: SETTLED
      });
      return { count: 0 };
    }
    Object.assign(attempt, data, { updatedAt: SETTLED });
    return { count: 1 };
  };
  const attemptCreate = async (args: unknown) => {
    const data = object(nested(args, "data"));
    const modelRunId = String(nested(data, "modelRun", "connect", "id"));
    const providerBindingKey = String(nested(
      data,
      "providerBinding",
      "connect",
      "modelRunId_bindingKey",
      "bindingKey"
    ));
    const manifestData = object(nested(data, "manifest", "create"));
    const manifestId = `manifest-${state.manifests.length + 1}`;
    const attemptId = `attempt-${state.attempts.length + 1}`;
    const itemCreates = inputArray(nested(manifestData, "items", "create"));
    const exclusionCreates = inputArray(nested(manifestData, "exclusions", "create"));
    const items = itemCreates.map((entry, index) => {
      const evidenceItemId = String(nested(entry, "evidenceItem", "connect", "id"));
      const { evidenceItem: _evidenceItem, ...stored } = entry;
      void _evidenceItem;
      return {
        ...stored,
        createdAt: NOW,
        evidenceItemId,
        id: `manifest-item-${index + 1}`,
        manifestId
      };
    });
    const exclusions = exclusionCreates.map((entry, index) => {
      const evidenceItemId = entry.evidenceItem === undefined
        ? null
        : String(nested(entry, "evidenceItem", "connect", "id"));
      const { evidenceItem: _evidenceItem, ...stored } = entry;
      void _evidenceItem;
      return {
        ...stored,
        createdAt: NOW,
        evidenceItemId,
        id: `manifest-exclusion-${index + 1}`,
        manifestId
      };
    });
    const retrievalSessionId = String(nested(
      manifestData,
      "retrievalSession",
      "connect",
      "id"
    ));
    const manifest = {
      coverage: manifestData.coverage,
      createdAt: NOW,
      excludedCount: manifestData.excludedCount,
      exclusions,
      id: manifestId,
      itemCount: manifestData.itemCount,
      items,
      messageHash: manifestData.messageHash,
      messageText: manifestData.messageText,
      modelRunId,
      packingVersion: manifestData.packingVersion,
      profileRevisionIds: manifestData.profileRevisionIds,
      promptFragmentVersion: manifestData.promptFragmentVersion,
      providerAttemptId: attemptId,
      purgedAt: null,
      retrievalSessionId,
      sealedAt: NOW,
      shortenedCount: manifestData.shortenedCount,
      totalBytes: manifestData.totalBytes,
      totalTokens: manifestData.totalTokens,
      version: manifestData.version
    };
    const attempt = {
      acceptedRequest: data.acceptedRequest ?? null,
      acceptedResult: null,
      actualUsage: null,
      ambiguousAt: null,
      checkpointHash: data.checkpointHash,
      contractVersion: data.contractVersion ?? null,
      createdAt: NOW,
      dispatchedAt: null,
      evidenceReceiptHash: data.evidenceReceiptHash ?? null,
      estimatedUsage: data.estimatedUsage,
      failureCode: null,
      id: attemptId,
      idempotencyKey: data.idempotencyKey,
      leaseExpiresAt: data.leaseExpiresAt,
      leaseToken: data.leaseToken,
      manifest,
      modelRunId,
      ordinal: data.ordinal,
      providerBindingKey,
      providerResponseId: null,
      purpose: data.purpose,
      releasedAt: null,
      requestHash: data.requestHash,
      resultAcceptedAt: null,
      resultHash: null,
      roundIndex: data.roundIndex,
      settledAt: null,
      state: "reserved",
      updatedAt: NOW
    };
    state.items.push(...items);
    state.exclusions.push(...exclusions);
    state.manifests.push(manifest);
    state.attempts.push(attempt);
    return attempt;
  };

  const manifestFindMany = async (args: unknown) => {
    const ids = nested(args, "where", "id", "in");
    const modelRunId = nested(args, "where", "modelRunId");
    if (!Array.isArray(ids)) throw new Error("fake_expected_ids");
    return state.manifests.filter((manifest) =>
      ids.includes(manifest.id) && manifest.modelRunId === modelRunId)
      .map(({ excludedCount, id, itemCount, purgedAt }) => ({
        excludedCount,
        id,
        itemCount,
        purgedAt
      }));
  };
  const updateChildren = (rows: Record<string, unknown>[]) => async (args: unknown) => {
    const ids = nested(args, "where", "manifestId", "in");
    const data = object(nested(args, "data"));
    if (!Array.isArray(ids)) throw new Error("fake_expected_ids");
    const selected = rows.filter((row) => ids.includes(row.manifestId));
    for (const row of selected) {
      for (const [key, value] of Object.entries(data)) {
        row[key] = value === Prisma.DbNull ? null : value;
      }
    }
    return { count: selected.length };
  };
  const manifestUpdateMany = async (args: unknown) => {
    const ids = nested(args, "where", "id", "in");
    const data = object(nested(args, "data"));
    if (!Array.isArray(ids)) throw new Error("fake_expected_ids");
    const selected = state.manifests.filter((manifest) =>
      ids.includes(manifest.id) && manifest.purgedAt === null);
    for (const manifest of selected) {
      for (const [key, value] of Object.entries(data)) {
        manifest[key] = value === Prisma.DbNull ? null : value;
      }
    }
    return { count: selected.length };
  };

  const tx = {
    $executeRaw: executeRaw,
    knowledgeEvidenceDispatchManifest: {
      findMany: manifestFindMany,
      updateMany: manifestUpdateMany
    },
    knowledgeEvidenceDispatchManifestExclusion: {
      updateMany: updateChildren(state.exclusions)
    },
    knowledgeEvidenceDispatchManifestItem: { updateMany: updateChildren(state.items) },
    knowledgeEvidenceItem: {
      findMany: vi.fn(async (args: unknown) => {
        const ids = nested(args, "where", "id", "in");
        const sessionId = nested(args, "where", "retrievalSessionId");
        if (!Array.isArray(ids)) throw new Error("fake_expected_ids");
        return state.evidenceItems.filter((item) =>
          ids.includes(item.id) && item.retrievalSessionId === sessionId);
      })
    },
    knowledgeRun: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (args: unknown) => {
        const where = object(nested(args, "where"));
        const ids = nested(where, "modelRunToolCallId", "in");
        if (!Array.isArray(ids) || where.modelRunId !== "run-1" ||
          where.retrievalSessionId !== "session-1") return [];
        if (input.knowledgeRuns) {
          return input.knowledgeRuns.filter((run) => ids.includes(run.modelRunToolCallId));
        }
        return ids.flatMap((id) => {
          const match = /^tool-call-([1-3])$/u.exec(String(id));
          return match ? [{
            evidenceLinks: [{ evidenceItemId: "evidence-item-1", resultOrdinal: 0 }],
            invocationOrdinal: Number(match[1]),
            modelRunToolCallId: String(id)
          }] : [];
        });
      })
    },
    knowledgeProviderAttempt: {
      create: vi.fn(attemptCreate),
      findMany: vi.fn(attemptFindMany),
      findUnique: vi.fn(attemptFind),
      updateMany: vi.fn(attemptUpdateMany)
    },
    knowledgeRetrievalSession: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = object(nested(args, "where"));
        return where.id === "session-1" && where.modelRunId === "run-1"
          ? { id: "session-1" }
          : null;
      }),
      findUnique: vi.fn(async (args: unknown) =>
        nested(args, "where", "modelRunId") === "run-1" ? { id: "session-1" } : null)
    },
    knowledgeRunSourceBinding: { findMany: vi.fn(async () => state.sourceBindings) },
    providerRunBinding: {
      findUnique: vi.fn(async (args: unknown) => {
        const key = object(nested(args, "where", "modelRunId_bindingKey"));
        return key.modelRunId === "run-1" && key.bindingKey === "answer"
          ? { id: "provider-binding-1" }
          : null;
      })
    },
    modelRunToolCall: {
      findMany: vi.fn(async (args: unknown) => {
        const where = object(nested(args, "where"));
        const providerCallIds = nested(where, "providerCallId", "in");
        if (where.modelRunId !== "run-1" || !Array.isArray(providerCallIds)) return [];
        return providerCallIds.flatMap((providerCallId) => {
          const match = /^provider-call-([1-3])$/u.exec(String(providerCallId));
          return match ? [{
            id: `tool-call-${match[1]}`,
            providerCallId: String(providerCallId)
          }] : [];
        });
      })
    }
  };
  const client = {
    $transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) =>
      operation(tx)),
    knowledgeProviderAttempt: tx.knowledgeProviderAttempt,
    knowledgeRun: tx.knowledgeRun
  } as unknown as PrismaClient;
  return { client, executeRaw, state };
}

function availableCandidate(overrides: Partial<Extract<
  CurrentKnowledgeEvidenceDispatchCandidate,
  { state: "available" }
>> = {}): Extract<CurrentKnowledgeEvidenceDispatchCandidate, { state: "available" }> {
  return {
    ambiguity: "none",
    evidenceId: "dispatch-evidence-1",
    exactExcerpt: "Verified excerpt",
    fileName: "source.txt",
    handle: "K1",
    locator: "page=1; heading=document root",
    operationOrdinal: 1,
    resultOrdinal: 1,
    sourceAlias: "S1",
    sourceLabel: "Source",
    sourceTruncated: false,
    sourceVersionNumber: 1,
    state: "available",
    ...overrides
  };
}

function draft(
  candidates: readonly CurrentKnowledgeEvidenceDispatchCandidate[] = [availableCandidate()],
  maximumBytes = 64 * 1_024
): KnowledgeEvidenceDispatchManifestDraft {
  return packKnowledgeEvidenceDispatchManifest({
    candidates,
    coverageStatement: "Coverage verified: no.",
    footer: "</private_knowledge_evidence>",
    header: "<private_knowledge_evidence version=\"2\">",
    maximumBytes,
    maximumTokens: 64 * 1_024,
    runtimeVersion: 1,
    profileId: "answer:test-model",
    promptFragmentVersion: 2
  });
}

function usage(overrides: Partial<KnowledgeProviderAttemptUsage> = {}): KnowledgeProviderAttemptUsage {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    estimatedCostMicros: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    totalTokens: 120,
    ...overrides
  };
}

function reserveInput(
  manifest: KnowledgeEvidenceDispatchManifestDraft = draft(),
  evidenceBindings: readonly KnowledgeEvidenceDispatchBinding[] = [{
    dispatchEvidenceId: "dispatch-evidence-1",
    evidenceItemId: "evidence-item-1"
  }]
): ReserveKnowledgeEvidenceDispatchInput {
  return {
    checkpointHash: "a".repeat(64),
    draft: manifest,
    estimatedUsage: usage(),
    evidenceBindings,
    idempotencyKey: "run:answer:attempt:1",
    leaseExpiresAt: LEASE,
    leaseToken: "lease:worker:one",
    modelRunId: "run-1",
    now: NOW,
    ordinal: 1,
    providerBindingKey: "answer",
    purpose: "answer",
    requestHash: "b".repeat(64),
    retrievalSessionId: "session-1",
    roundIndex: 0
  };
}

function identity(input: ReserveKnowledgeEvidenceDispatchInput, attemptId: string) {
  return {
    attemptId,
    checkpointHash: input.checkpointHash,
    idempotencyKey: input.idempotencyKey,
    manifestHash: input.draft.manifestHash,
    modelRunId: input.modelRunId,
    providerBindingKey: input.providerBindingKey,
    requestHash: input.requestHash
  };
}

async function expectRepositoryError(
  operation: Promise<unknown>,
  code: KnowledgeEvidenceDispatchRepositoryError["code"]
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("Knowledge evidence dispatch repository", () => {
  it("strictly decodes content-free provider accounting", () => {
    expect(decodeKnowledgeProviderAttemptUsage(usage())).toEqual(usage());
    expect(decodeKnowledgeProviderAttemptUsage({ ...usage(), prompt: "private" })).toBeNull();
    expect(decodeKnowledgeProviderAttemptUsage({ ...usage(), inputTokens: 0.5 })).toBeNull();
  });

  it.each(["answer_citation_retry", "citation_repair", "tool_follow_up"] as const)(
    "rejects new %s attempts while retaining historical read compatibility",
    async (purpose) => {
      const fake = createFakePrisma();
      const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);

      await expectRepositoryError(repository.reserve({
        ...reserveInput(),
        purpose
      } as unknown as ReserveKnowledgeEvidenceDispatchInput), "invalid_input");
      expect(fake.state.attempts).toEqual([]);
      expect(fake.state.manifests).toEqual([]);
    }
  );

  it("atomically persists a V11 accepted request and decoded terminal result", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const manifest = draft();
    const acceptedRequest = {
      contractVersion: 11,
      evidenceReceiptHash: manifest.manifestHash,
      operation: "knowledge_answer_draft_v11",
      version: 1
    } as const;
    const input: ReserveKnowledgeEvidenceDispatchInput = {
      ...reserveInput(manifest),
      acceptedRequest,
      contractVersion: 11,
      evidenceReceiptHash: manifest.manifestHash,
      purpose: "knowledge_answer_draft_v11",
      requestHash: memorySha256(acceptedRequest)
    };
    const created = await repository.reserve(input);
    await repository.dispatch({
      ...identity(input, created.dispatch.attempt.id),
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: input.leaseToken
    });
    const acceptedResult = {
      kind: "draft_malformed",
      reason: "draft_claim_text_invalid"
    } as const;
    await repository.settle({
      ...identity(input, created.dispatch.attempt.id),
      acceptedResult,
      actualUsage: usage(),
      leaseToken: input.leaseToken,
      providerResponseId: "provider-response-1",
      resultAcceptedAt: SETTLED,
      resultHash: memorySha256(acceptedResult),
      settledAt: SETTLED
    });

    await expect(repository.loadForRecovery({ modelRunId: "run-1", ordinal: 1 }))
      .resolves.toMatchObject({
        attempt: {
          acceptedRequest,
          acceptedResult,
          contractVersion: 11,
          evidenceReceiptHash: manifest.manifestHash,
          purpose: "knowledge_answer_draft_v11",
          state: "settled"
        }
      });
  });

  it("persists the full canonical K1..K2048 handle range and rejects K2049", async () => {
    const fake = createFakePrisma({
      evidenceItems: [{
        excerpt: "Verified excerpt",
        fileName: "source.txt",
        handle: "K2048",
        id: "evidence-item-1",
        retrievalSessionId: "session-1",
        sourceArtifactId: "artifact-1",
        sourceName: "Source",
        sourceVersionId: "source-version-1",
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      }]
    });
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const acceptedDraft = draft([availableCandidate({ handle: "K2048" })]);

    await expect(repository.reserve(reserveInput(acceptedDraft))).resolves.toMatchObject({
      kind: "created"
    });
    expect(fake.state.items).toEqual([
      expect.objectContaining({ handle: "K2048" })
    ]);
    expect(() => draft([availableCandidate({ handle: "K2049" })]))
      .toThrow("knowledge_evidence_dispatch_candidate_invalid");
  });

  it("rejects corrupted immutable attempt identity during recovery", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    await repository.reserve(input);
    fake.state.attempts[0]!.requestHash = "corrupt";

    await expectRepositoryError(repository.loadForRecovery({
      modelRunId: input.modelRunId,
      ordinal: input.ordinal
    }), "stored_manifest_invalid");
  });

  it("atomically creates or reuses one exact attempt and replays stored bytes", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const created = await repository.reserve(input);
    const reused = await repository.reserve({
      ...input,
      leaseExpiresAt: new Date("2026-08-19T10:07:00.000Z"),
      leaseToken: "lease:worker:duplicate"
    });
    const loaded = await repository.loadForReplay(identity(input, created.dispatch.attempt.id));

    expect(created.kind).toBe("created");
    expect(reused.kind).toBe("reused");
    expect(reused.dispatch.attempt).toMatchObject({
      leaseExpiresAt: input.leaseExpiresAt,
      leaseToken: input.leaseToken
    });
    expect(fake.state.attempts).toHaveLength(1);
    expect(fake.state.manifests).toHaveLength(1);
    expect(fake.state.items).toHaveLength(1);
    expect(loaded.draft).toEqual(input.draft);
    expect(loaded.draft.message).toBe(input.draft.message);
    expect(loaded.items).toEqual([expect.objectContaining({
      dispatchEvidenceId: "dispatch-evidence-1",
      evidenceItemId: "evidence-item-1",
      sourceArtifactId: "artifact-1",
      sourceVersionId: "source-version-1"
    })]);
    expect(loaded.profileRevisionIds).toEqual(["profile-revision-1"]);
    expect(loaded.attempt.estimatedUsage).toEqual(usage());
  });

  it("re-leases an expired reserved attempt without rebuilding its manifest", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const created = await repository.reserve(input);
    await expectRepositoryError(repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:25:00.000Z"),
      leaseToken: "lease:worker:inconsistent-handle",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:10:00.000Z"),
      ordinal: input.ordinal,
      providerResponseId: "unexpected-provider-response",
      requestHash: input.requestHash
    }), "idempotency_conflict");
    const recovered = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:25:00.000Z"),
      leaseToken: "lease:worker:recovery",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:10:00.000Z"),
      ordinal: input.ordinal,
      requestHash: input.requestHash
    });

    expect(recovered).toMatchObject({
      dispatch: {
        attempt: {
          leaseToken: "lease:worker:recovery",
          state: "reserved"
        },
        draft: {
          manifestHash: input.draft.manifestHash,
          message: input.draft.message,
          messageHash: input.draft.messageHash
        }
      },
      kind: "dispatch",
      leaseToken: "lease:worker:recovery"
    });
    expect(await repository.loadForRecovery({
      modelRunId: input.modelRunId,
      ordinal: input.ordinal
    })).toEqual("dispatch" in recovered ? recovered.dispatch : created.dispatch);

    const competing = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:26:00.000Z"),
      leaseToken: "lease:worker:competing",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:11:00.000Z"),
      ordinal: input.ordinal,
      requestHash: input.requestHash
    });
    expect(competing).toMatchObject({ kind: "busy" });

    await expectRepositoryError(repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:40:00.000Z"),
      leaseToken: "lease:worker:mismatch",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:30:00.000Z"),
      ordinal: input.ordinal,
      requestHash: "c".repeat(64)
    }), "idempotency_conflict");
  });

  it("returns busy when another recovery worker wins the expired RESERVED claim", async () => {
    const fake = createFakePrisma({ loseRecoveryClaim: true });
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    await repository.reserve(input);

    const recovered = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:25:00.000Z"),
      leaseToken: "lease:worker:recovery",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:10:00.000Z"),
      ordinal: input.ordinal,
      requestHash: input.requestHash
    });

    expect(recovered).toMatchObject({
      dispatch: {
        attempt: {
          leaseToken: "lease:worker:winner",
          state: "reserved"
        }
      },
      kind: "busy"
    });
  });

  it("resumes dispatched work only from a durable response handle and replays settlement", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const reserved = await repository.reserve(input);
    const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
    await repository.dispatch({
      ...attemptIdentity,
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: input.leaseToken
    });

    const resumed = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:25:00.000Z"),
      leaseToken: "lease:worker:recovery",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:10:00.000Z"),
      ordinal: input.ordinal,
      providerResponseId: "provider-response-1"
    });
    expect(resumed).toMatchObject({
      dispatch: {
        attempt: {
          providerResponseId: "provider-response-1",
          state: "dispatched"
        }
      },
      kind: "resume",
      leaseToken: "lease:worker:recovery",
      providerResponseId: "provider-response-1"
    });
    if (resumed.kind !== "resume") throw new Error("expected_resume");
    await repository.settle({
      ...attemptIdentity,
      actualUsage: usage(),
      leaseToken: resumed.leaseToken,
      providerResponseId: resumed.providerResponseId,
      settledAt: new Date("2026-08-19T10:11:00.000Z")
    });
    const replay = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:30:00.000Z"),
      leaseToken: "lease:worker:later",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:12:00.000Z"),
      ordinal: input.ordinal,
      providerResponseId: "provider-response-1"
    });
    expect(replay).toMatchObject({
      dispatch: { draft: { message: input.draft.message } },
      kind: "settled",
      providerResponseId: "provider-response-1"
    });
  });

  it("marks an expired dispatched attempt without a refresh handle ambiguous", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const reserved = await repository.reserve(input);
    await repository.dispatch({
      ...identity(input, reserved.dispatch.attempt.id),
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: input.leaseToken
    });

    const recovered = await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:25:00.000Z"),
      leaseToken: "lease:worker:recovery",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:10:00.000Z"),
      ordinal: input.ordinal
    });

    expect(recovered).toMatchObject({
      dispatch: {
        attempt: {
          failureCode: "provider_response_handle_missing",
          leaseExpiresAt: null,
          leaseToken: null,
          state: "ambiguous"
        }
      },
      kind: "ambiguous"
    });
    expect(await repository.recover({
      leaseExpiresAt: new Date("2026-08-19T10:30:00.000Z"),
      leaseToken: "lease:worker:later",
      modelRunId: input.modelRunId,
      now: new Date("2026-08-19T10:12:00.000Z"),
      ordinal: input.ordinal
    })).toMatchObject({ kind: "ambiguous" });
  });

  it("selects only the final settled manifest for current grounding", async () => {
    const legacy = createFakePrisma();
    await expect(loadFinalKnowledgeGroundingDispatch(legacy.client, {
      modelRunId: "run-1",
      retrievalSessionId: "session-1"
    })).resolves.toEqual({ kind: "legacy" });

    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const reserved = await repository.reserve(input);
    await expectRepositoryError(loadFinalKnowledgeGroundingDispatch(fake.client, {
      modelRunId: "run-1",
      retrievalSessionId: "session-1"
    }), "stored_manifest_invalid");

    const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
    await repository.dispatch({
      ...attemptIdentity,
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: input.leaseToken
    });
    await repository.settle({
      ...attemptIdentity,
      actualUsage: usage(),
      leaseToken: input.leaseToken,
      providerResponseId: "provider-response-1",
      settledAt: SETTLED
    });

    const selected = await loadFinalKnowledgeGroundingDispatch(fake.client, {
      modelRunId: "run-1",
      retrievalSessionId: "session-1"
    });
    expect(selected).toMatchObject({
      dispatch: {
        attempt: { ordinal: 1, state: "settled" },
        draft: { manifestHash: input.draft.manifestHash },
        retrievalSessionId: "session-1"
      },
      kind: "current"
    });

    fake.state.manifests[0]!.messageText = "corrupt";
    await expectRepositoryError(loadFinalKnowledgeGroundingDispatch(fake.client, {
      modelRunId: "run-1",
      retrievalSessionId: "session-1"
    }), "stored_manifest_invalid");
  });

  it("loads the V15/V11 ordinal-three validation-repair sequence without a supplement", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const currentManifest = draft();
    const request = "How long are completed exports retained?";
    const acceptedDraft = {
      blocks: [{ claimIds: ["C1"], type: "paragraph" as const }],
      claims: [{
        citationHints: ["K1"],
        id: "C1",
        text: "Completed exports are retained for 30 days."
      }],
      version: 1 as const
    };
    const draftPrompt = knowledgeAnswerDraftPromptForPair({
      evidenceManifest: currentManifest.message,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    }, KNOWLEDGE_ANSWER_CONTRACT_PAIR_V15_V11);
    const initialPrompt = knowledgeGroundedSelectorPromptForPair({
      draft: acceptedDraft,
      evidence: knowledgeSelectorEvidenceFromManifest(currentManifest),
      evidenceManifest: currentManifest.message,
      request,
      selectorPass: "initial"
    }, KNOWLEDGE_ANSWER_CONTRACT_PAIR_V15_V11);
    const repairPrompt = knowledgeGroundedSelectorPromptForPair({
      draft: acceptedDraft,
      evidence: knowledgeSelectorEvidenceFromManifest(currentManifest),
      evidenceManifest: currentManifest.message,
      repairReason: "selector_coverage_invalid",
      request,
      selectorPass: "repair"
    }, KNOWLEDGE_ANSWER_CONTRACT_PAIR_V15_V11);
    const snapshots = [
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 15,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
        operation: "knowledge_answer_draft_v15",
        schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V6,
        systemPrompt: draftPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: draftPrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 11,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
        operation: "knowledge_grounded_selector_v11",
        schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6,
        systemPrompt: initialPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: initialPrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 11,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
        operation: "knowledge_grounded_selector_final_v11",
        schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V6,
        systemPrompt: repairPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: repairPrompt.userPrompt
      })
    ] as const;
    const results = [{
      claims: [{
        citationHints: ["K1"],
        text: "Completed exports are retained for 30 days."
      }],
      version: 1
    }, {
      kind: "selector_failed",
      reason: "selector_coverage_invalid"
    }, {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{
        description: "The requested retention period.",
        id: "D1",
        status: "covered",
        supportIds: ["C1"]
      }],
      decision: "select_claims",
      missingInformation: [],
      requestCoverage: "complete",
      version: 1
    }] as const;

    expect(snapshots.every(({ operation }) =>
      operation.length <= KNOWLEDGE_PROVIDER_ATTEMPT_PURPOSE_STORAGE_LIMIT)).toBe(true);

    for (const [index, snapshot] of snapshots.entries()) {
      const ordinal = index + 1;
      const input: ReserveKnowledgeEvidenceDispatchInput = {
        acceptedRequest: snapshot,
        checkpointHash: String(ordinal).repeat(64),
        contractVersion: snapshot.contractVersion,
        draft: currentManifest,
        estimatedUsage: usage(),
        evidenceBindings: [{
          dispatchEvidenceId: "dispatch-evidence-1",
          evidenceItemId: "evidence-item-1"
        }],
        evidenceReceiptHash: currentManifest.manifestHash,
        idempotencyKey: `run:answer:v15:${ordinal}`,
        leaseExpiresAt: LEASE,
        leaseToken: `lease:worker:${ordinal}`,
        modelRunId: "run-1",
        now: NOW,
        ordinal,
        providerBindingKey: "answer",
        purpose: snapshot.operation,
        requestHash: knowledgeAnswerHash(snapshot),
        retrievalSessionId: "session-1",
        roundIndex: 0
      };
      const reserved = await repository.reserve(input);
      const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
      await repository.dispatch({
        ...attemptIdentity,
        dispatchedAt: DISPATCHED,
        leaseExpiresAt: DISPATCH_LEASE,
        leaseToken: input.leaseToken
      });
      await repository.settle({
        ...attemptIdentity,
        acceptedResult: results[index]!,
        actualUsage: usage(),
        leaseToken: input.leaseToken,
        providerResponseId: `provider-response-${ordinal}`,
        resultAcceptedAt: new Date("2026-08-19T10:01:30.000Z"),
        resultHash: knowledgeAnswerHash(results[index]!),
        settledAt: SETTLED
      });
    }

    await expect(loadSettledKnowledgeAnswerGroundingOperations(fake.client, {
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V15_V11,
      modelRunId: "run-1"
    })).resolves.toMatchObject({
      draft: { attempt: { purpose: "knowledge_answer_draft_v15" } },
      finalSelector: { attempt: { purpose: "knowledge_grounded_selector_final_v11" } },
      initialSelector: { attempt: { purpose: "knowledge_grounded_selector_v11" } },
      selector: { attempt: { purpose: "knowledge_grounded_selector_final_v11" } },
      supplementalDraft: null
    });
  });

  it("loads the V20/V16 Planner, Draft, and Selector sequence in ordinal order", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const currentManifest = draft();
    const request = "How long are completed exports retained?";
    const plan = {
      dimensions: [{ description: "The requested retention period.", id: "D1" }],
      version: 1 as const
    };
    const acceptedDraft = {
      blocks: [{ claimIds: ["C1"], type: "paragraph" as const }],
      claims: [{
        citationHints: ["K1"],
        id: "C1",
        text: "Completed exports are retained for 30 days."
      }],
      version: 1 as const
    };
    const plannerPrompt = knowledgeCoveragePlannerPrompt({
      evidenceManifest: currentManifest.message,
      request
    });
    const draftPrompt = knowledgeAnswerDraftPromptForPair({
      coveragePlan: plan,
      evidenceManifest: currentManifest.message,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    }, KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16);
    const selectorPrompt = knowledgeGroundedSelectorPromptForPair({
      coveragePlan: plan,
      draft: acceptedDraft,
      evidence: knowledgeSelectorEvidenceFromManifest(currentManifest),
      evidenceManifest: currentManifest.message,
      request,
      selectorPass: "initial"
    }, KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16);
    const snapshots = [
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 20,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_COVERAGE_PLANNER_MAX_OUTPUT_TOKENS,
        operation: "knowledge_coverage_planner_v20",
        schema: KNOWLEDGE_COVERAGE_PLAN_SCHEMA_V1,
        systemPrompt: plannerPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: plannerPrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 20,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_MAX_OUTPUT_TOKENS,
        operation: "knowledge_answer_draft_v20",
        schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V6,
        systemPrompt: draftPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: draftPrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV1({
        contractVersion: 16,
        evidenceReceiptHash: currentManifest.manifestHash,
        maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_MAX_OUTPUT_TOKENS,
        operation: "knowledge_grounded_selector_v16",
        schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V9,
        systemPrompt: selectorPrompt.systemPrompt,
        transport: "native_strict",
        userPrompt: selectorPrompt.userPrompt
      })
    ] as const;
    const results = [plan, {
      claims: [{
        citationHints: ["K1"],
        text: "Completed exports are retained for 30 days."
      }],
      version: 1
    }, {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }] as const;

    for (const [index, snapshot] of snapshots.entries()) {
      const ordinal = index + 1;
      const input: ReserveKnowledgeEvidenceDispatchInput = {
        acceptedRequest: snapshot,
        checkpointHash: String(ordinal).repeat(64),
        contractVersion: snapshot.contractVersion,
        draft: currentManifest,
        estimatedUsage: usage(),
        evidenceBindings: [{
          dispatchEvidenceId: "dispatch-evidence-1",
          evidenceItemId: "evidence-item-1"
        }],
        evidenceReceiptHash: currentManifest.manifestHash,
        idempotencyKey: `run:answer:v20:${ordinal}`,
        leaseExpiresAt: LEASE,
        leaseToken: `lease:worker:v20:${ordinal}`,
        modelRunId: "run-1",
        now: NOW,
        ordinal,
        providerBindingKey: "answer",
        purpose: snapshot.operation,
        requestHash: knowledgeAnswerHash(snapshot),
        retrievalSessionId: "session-1",
        roundIndex: 0
      };
      const reserved = await repository.reserve(input);
      const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
      await repository.dispatch({
        ...attemptIdentity,
        dispatchedAt: DISPATCHED,
        leaseExpiresAt: DISPATCH_LEASE,
        leaseToken: input.leaseToken
      });
      await repository.settle({
        ...attemptIdentity,
        acceptedResult: results[index]!,
        actualUsage: usage(),
        leaseToken: input.leaseToken,
        providerResponseId: `provider-response-v20-${ordinal}`,
        resultAcceptedAt: new Date("2026-08-19T10:01:30.000Z"),
        resultHash: knowledgeAnswerHash(results[index]!),
        settledAt: SETTLED
      });
    }

    await expect(loadSettledKnowledgeAnswerGroundingOperations(fake.client, {
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
      modelRunId: "run-1"
    })).resolves.toMatchObject({
      coveragePlanner: { attempt: { purpose: "knowledge_coverage_planner_v20" } },
      draft: { attempt: { purpose: "knowledge_answer_draft_v20" } },
      finalSelector: null,
      initialSelector: { attempt: { purpose: "knowledge_grounded_selector_v16" } },
      selector: { attempt: { purpose: "knowledge_grounded_selector_v16" } },
      supplementalDraft: null
    });
  });

  it("loads the exact V21 Draft, atom Scope repair, and Selector sequence", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const currentManifest = draft();
    const request = "How long is the verified value retained?";
    const evidence = knowledgeCoverageEvidenceFromManifestV5(currentManifest);
    const executionPolicy = {
      auditorReasoningEffort: "low",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: [],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    } as const;
    const rawDraft = {
      claims: [{ citationHints: ["K1"], text: "The verified value is retained." }],
      version: 1
    };
    const acceptedDraft = decodeKnowledgeAnswerDraftV21(rawDraft, {
      availableHandles: ["K1"]
    })!;
    const rawScope = {
      evidenceMap: [{
        answerAtomIds: ["A1"],
        handle: "K1"
      }],
      scope: [{
        description: "State how long the verified value is retained.",
        evidenceAtomIds: ["A1"],
        id: "D1",
        requestAnchor: "How long"
      }],
      version: 5
    } as const;
    const acceptedScope = decodeKnowledgeCoverageScopeV5(rawScope, {
      evidence,
      request
    })!;
    const rawSelector = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    expect(decodeKnowledgeGroundedSelectorV20(rawSelector, {
      draft: acceptedDraft,
      evidence,
      request,
      scope: acceptedScope
    })).not.toBeNull();
    const draftPrompt = knowledgeAnswerDraftPromptV21({
      draftPass: "primary",
      evidenceManifest: currentManifest.message,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    const initialScopePrompt = knowledgeCoverageScopePromptV5({
      evidence,
      evidenceManifest: currentManifest.message,
      request,
      scopePass: "initial"
    });
    const repairScopePrompt = knowledgeCoverageScopePromptV5({
      evidence,
      evidenceManifest: currentManifest.message,
      repairReason: "coverage_scope_shape_invalid",
      request,
      scopePass: "repair"
    });
    const scopePayloadHash = knowledgeAnswerHash(rawScope);
    const selectorPrompt = knowledgeGroundedSelectorPromptV20({
      draft: acceptedDraft,
      evidence,
      evidenceManifest: currentManifest.message,
      request,
      scope: acceptedScope,
      selectorPass: "initial"
    });
    const common = {
      evidenceReceiptHash: currentManifest.manifestHash,
      executionPolicy,
      protocol: "scope_v5" as const,
      transport: "native_strict" as const
    };
    const snapshots = [
      createKnowledgeAnswerOperationRequestSnapshotV21({
        ...common,
        contractVersion: 21,
        maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
        schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
        systemPrompt: draftPrompt.systemPrompt,
        userPrompt: draftPrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV21({
        ...common,
        contractVersion: KNOWLEDGE_COVERAGE_SCOPE_V5_CONTRACT_VERSION,
        maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V5_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION,
        schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V5,
        systemPrompt: initialScopePrompt.systemPrompt,
        userPrompt: initialScopePrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV21({
        ...common,
        contractVersion: KNOWLEDGE_COVERAGE_SCOPE_V5_CONTRACT_VERSION,
        maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V5_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION,
        schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V5,
        systemPrompt: repairScopePrompt.systemPrompt,
        userPrompt: repairScopePrompt.userPrompt
      }),
      createKnowledgeAnswerOperationRequestSnapshotV21({
        ...common,
        contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V20_CONTRACT_VERSION,
        coverageScopePayloadHash: scopePayloadHash,
        maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V20_MAX_OUTPUT_TOKENS,
        operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20,
        schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V20,
        systemPrompt: selectorPrompt.systemPrompt,
        userPrompt: selectorPrompt.userPrompt
      })
    ] as const;
    const results = [
      rawDraft,
      knowledgeCoverageScopeFailureV5("coverage_scope_shape_invalid"),
      rawScope,
      rawSelector
    ] as const;
    for (const [index, snapshot] of snapshots.entries()) {
      const ordinal = index + 1;
      const input: ReserveKnowledgeEvidenceDispatchInput = {
        acceptedRequest: snapshot,
        checkpointHash: String(ordinal).repeat(64),
        contractVersion: snapshot.contractVersion,
        draft: currentManifest,
        estimatedUsage: usage(),
        evidenceBindings: [{
          dispatchEvidenceId: "dispatch-evidence-1",
          evidenceItemId: "evidence-item-1"
        }],
        evidenceReceiptHash: currentManifest.manifestHash,
        idempotencyKey: `run:answer:v21:${ordinal}`,
        leaseExpiresAt: LEASE,
        leaseToken: `lease:worker:v21:${ordinal}`,
        modelRunId: "run-1",
        now: NOW,
        ordinal,
        providerBindingKey: "answer",
        purpose: snapshot.operation,
        requestHash: knowledgeAnswerHash(snapshot),
        retrievalSessionId: "session-1",
        roundIndex: 0
      };
      const reserved = await repository.reserve(input);
      const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
      await repository.dispatch({
        ...attemptIdentity,
        dispatchedAt: DISPATCHED,
        leaseExpiresAt: DISPATCH_LEASE,
        leaseToken: input.leaseToken
      });
      await repository.settle({
        ...attemptIdentity,
        acceptedResult: results[index]!,
        actualUsage: usage(),
        leaseToken: input.leaseToken,
        providerResponseId: `provider-response-v21-${ordinal}`,
        resultAcceptedAt: new Date("2026-08-19T10:01:30.000Z"),
        resultHash: knowledgeAnswerHash(results[index]!),
        settledAt: SETTLED
      });
    }
    await expect(loadSettledKnowledgeAnswerGroundingOperationsV21(fake.client, {
      modelRunId: "run-1"
    })).resolves.toMatchObject({
      draft: { attempt: { ordinal: 1 } },
      finalSelector: null,
      initialScope: { attempt: { ordinal: 2 } },
      initialSelector: { attempt: { ordinal: 4 } },
      scope: { attempt: { ordinal: 3 } },
      scopeRepair: { attempt: { ordinal: 3 } },
      selectorRepair: null,
      supplementalDraft: null
    });

    const selectorAttempt = fake.state.attempts[3]!;
    selectorAttempt.acceptedRequest = {
      ...object(selectorAttempt.acceptedRequest),
      coverageScopePayloadHash: "f".repeat(64)
    };
    await expect(loadSettledKnowledgeAnswerGroundingOperationsV21(fake.client, {
      modelRunId: "run-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_stored_manifest_invalid");
  });

  it("maps a one-based draft result reference to a zero-based durable evidence link", async () => {
    const manifest = draft([availableCandidate({
      evidenceId: "provider-call-1:result:1"
    })]);
    const prepared = reserveInput(manifest, [{
      dispatchEvidenceId: "provider-call-1:result:1",
      evidenceItemId: "evidence-item-1"
    }]);
    const {
      evidenceBindings: _evidenceBindings,
      retrievalSessionId: _retrievalSessionId,
      ...input
    } = prepared;
    void _evidenceBindings;
    void _retrievalSessionId;
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);

    const reserved = await repository.reserve(input);

    expect(reserved.dispatch.retrievalSessionId).toBe("session-1");
    expect(reserved.dispatch.items).toEqual([expect.objectContaining({
      dispatchEvidenceId: "provider-call-1:result:1",
      evidenceItemId: "evidence-item-1"
    })]);
  });

  it("maps eight plus one one-based draft results across two zero-based durable runs", async () => {
    const evidenceItems = Array.from({ length: 9 }, (_, index) => ({
      excerpt: `Verified excerpt ${index + 1}`,
      fileName: "source.txt",
      handle: `K${index + 1}`,
      id: `evidence-item-${index + 1}`,
      retrievalSessionId: "session-1",
      sourceArtifactId: "artifact-1",
      sourceName: "Source",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 1,
      state: "available",
      textTruncated: false
    }));
    const candidates = evidenceItems.map((item, index) => {
      const firstCall = index < 8;
      const resultOrdinal = firstCall ? index + 1 : 1;
      return availableCandidate({
        evidenceId: `provider-call-${firstCall ? 1 : 2}:result:${resultOrdinal}`,
        exactExcerpt: String(item.excerpt),
        handle: String(item.handle),
        operationOrdinal: firstCall ? 1 : 2,
        resultOrdinal
      });
    });
    const manifest = draft(candidates);
    const prepared = reserveInput(manifest);
    const {
      evidenceBindings: _evidenceBindings,
      retrievalSessionId: _retrievalSessionId,
      ...input
    } = prepared;
    void _evidenceBindings;
    void _retrievalSessionId;
    const fake = createFakePrisma({
      evidenceItems,
      knowledgeRuns: [
        {
          evidenceLinks: evidenceItems.slice(0, 8).map((item, resultOrdinal) => ({
            evidenceItemId: item.id,
            resultOrdinal
          })),
          invocationOrdinal: 1,
          modelRunToolCallId: "tool-call-1"
        },
        {
          evidenceLinks: [{ evidenceItemId: "evidence-item-9", resultOrdinal: 0 }],
          invocationOrdinal: 2,
          modelRunToolCallId: "tool-call-2"
        }
      ]
    });
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);

    const reserved = await repository.reserve(input);

    expect(reserved.dispatch.items.map(({ dispatchEvidenceId, evidenceItemId }) => ({
      dispatchEvidenceId,
      evidenceItemId
    }))).toEqual(candidates.map(({ evidenceId }, index) => ({
      dispatchEvidenceId: evidenceId,
      evidenceItemId: `evidence-item-${index + 1}`
    })));
  });

  it("preserves repeated exclusions that resolve to one canonical evidence item", async () => {
    const manifest = draft([
      availableCandidate({ evidenceId: "provider-call-1:result:1" }),
      availableCandidate({
        evidenceId: "provider-call-2:result:1",
        operationOrdinal: 2
      }),
      availableCandidate({
        evidenceId: "provider-call-3:result:1",
        operationOrdinal: 3
      })
    ]);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.exclusions).toHaveLength(2);
    const prepared = reserveInput(manifest);
    const {
      evidenceBindings: _evidenceBindings,
      retrievalSessionId: _retrievalSessionId,
      ...input
    } = prepared;
    void _evidenceBindings;
    void _retrievalSessionId;
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(createFakePrisma().client);

    const reserved = await repository.reserve(input);

    expect(reserved.dispatch.exclusions).toEqual([
      expect.objectContaining({
        dispatchEvidenceId: "provider-call-2:result:1",
        evidenceItemId: "evidence-item-1",
        reason: "deduplicated"
      }),
      expect.objectContaining({
        dispatchEvidenceId: "provider-call-3:result:1",
        evidenceItemId: "evidence-item-1",
        reason: "deduplicated"
      })
    ]);
  });

  it("round-trips an unavailable result without inventing a handle or evidence row", async () => {
    const manifest = draft([{
      evidenceId: "provider-call-1:result:1",
      operationOrdinal: 1,
      resultOrdinal: 1,
      state: "unavailable"
    }]);
    const prepared = reserveInput(manifest);
    const {
      evidenceBindings: _evidenceBindings,
      retrievalSessionId: _retrievalSessionId,
      ...input
    } = prepared;
    void _evidenceBindings;
    void _retrievalSessionId;
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);

    const reserved = await repository.reserve(input);
    const loaded = await repository.loadForReplay(identity(input, reserved.dispatch.attempt.id));

    expect(loaded.draft).toEqual(manifest);
    expect(loaded.items).toEqual([]);
    expect(loaded.exclusions).toEqual([{
      dispatchEvidenceId: "provider-call-1:result:1",
      evidenceItemId: null,
      handle: null,
      reason: "unavailable"
    }]);

    const missingManifest = draft([{
      evidenceId: "provider-call-missing:result:1",
      operationOrdinal: 1,
      resultOrdinal: 1,
      state: "unavailable"
    }]);
    const missingPrepared = reserveInput(missingManifest);
    const {
      evidenceBindings: _missingEvidenceBindings,
      retrievalSessionId: _missingRetrievalSessionId,
      ...missingInput
    } = missingPrepared;
    void _missingEvidenceBindings;
    void _missingRetrievalSessionId;
    await expectRepositoryError(
      createPrismaKnowledgeEvidenceDispatchRepository(createFakePrisma().client)
        .reserve(missingInput),
      "evidence_mismatch"
    );
  });

  it("fails closed on checkpoint, draft, evidence, and stored-byte mismatch", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const created = await repository.reserve(input);

    await expectRepositoryError(repository.reserve({
      ...input,
      checkpointHash: "c".repeat(64)
    }), "idempotency_conflict");
    const conflictingDraft = draft([availableCandidate({ exactExcerpt: "Changed excerpt" })]);
    await expectRepositoryError(repository.reserve({ ...input, draft: conflictingDraft }), "draft_conflict");
    await expectRepositoryError(repository.reserve({
      ...input,
      evidenceBindings: [{
        dispatchEvidenceId: "dispatch-evidence-1",
        evidenceItemId: "different-evidence-item"
      }]
    }), "evidence_mismatch");

    const manifest = fake.state.manifests[0]!;
    manifest.messageText = `${manifest.messageText as string}tampered`;
    await expectRepositoryError(
      repository.loadForReplay(identity(input, created.dispatch.attempt.id)),
      "stored_manifest_invalid"
    );
  });

  it("dispatches and settles once while rejecting a conflicting replay", async () => {
    const fake = createFakePrisma();
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput();
    const reserved = await repository.reserve(input);
    const attemptIdentity = identity(input, reserved.dispatch.attempt.id);
    const dispatchInput = {
      ...attemptIdentity,
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: input.leaseToken
    };

    expect((await repository.dispatch(dispatchInput)).kind).toBe("transitioned");
    expect((await repository.dispatch(dispatchInput)).kind).toBe("idempotent");
    await expectRepositoryError(repository.dispatch({
      ...dispatchInput,
      leaseToken: "lease:worker:other"
    }), "lease_conflict");

    const settleInput = {
      ...attemptIdentity,
      actualUsage: usage({ estimatedCostMicros: 8, outputTokens: 18, totalTokens: 118 }),
      leaseToken: input.leaseToken,
      providerResponseId: "provider-response-1",
      settledAt: SETTLED
    };
    const settled = await repository.settle(settleInput);
    expect(settled.kind).toBe("transitioned");
    expect(settled.attempt).toMatchObject({ leaseExpiresAt: null, leaseToken: null });
    expect(settled.attempt.actualUsage).toEqual(settleInput.actualUsage);
    expect(settled.attempt.estimatedUsage).toEqual(input.estimatedUsage);
    expect((await repository.settle(settleInput)).kind).toBe("idempotent");
    await expectRepositoryError(repository.settle({
      ...settleInput,
      actualUsage: usage({ outputTokens: 19, totalTokens: 119 })
    }), "idempotency_conflict");
  });

  it("releases only pre-dispatch and marks only post-dispatch work ambiguous", async () => {
    const releaseFake = createFakePrisma();
    const releaseRepository = createPrismaKnowledgeEvidenceDispatchRepository(releaseFake.client);
    const releaseInput = reserveInput();
    const releasedAttempt = await releaseRepository.reserve(releaseInput);
    const releaseIdentity = identity(releaseInput, releasedAttempt.dispatch.attempt.id);
    const release = {
      ...releaseIdentity,
      leaseToken: releaseInput.leaseToken,
      reason: "cancelled_before_dispatch",
      releasedAt: DISPATCHED
    };
    expect(await releaseRepository.release(release)).toMatchObject({
      attempt: { leaseExpiresAt: null, leaseToken: null },
      kind: "transitioned"
    });
    expect((await releaseRepository.release(release)).kind).toBe("idempotent");
    await expectRepositoryError(releaseRepository.dispatch({
      ...releaseIdentity,
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: releaseInput.leaseToken
    }), "invalid_state");

    const ambiguousFake = createFakePrisma();
    const ambiguousRepository = createPrismaKnowledgeEvidenceDispatchRepository(
      ambiguousFake.client
    );
    const ambiguousInput = reserveInput();
    const ambiguousAttempt = await ambiguousRepository.reserve(ambiguousInput);
    const ambiguousIdentity = identity(ambiguousInput, ambiguousAttempt.dispatch.attempt.id);
    await ambiguousRepository.dispatch({
      ...ambiguousIdentity,
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE,
      leaseToken: ambiguousInput.leaseToken
    });
    const ambiguous = {
      ...ambiguousIdentity,
      ambiguousAt: SETTLED,
      leaseToken: ambiguousInput.leaseToken,
      reason: "provider_outcome_unknown"
    };
    expect(await ambiguousRepository.markAmbiguous(ambiguous)).toMatchObject({
      attempt: { leaseExpiresAt: null, leaseToken: null },
      kind: "transitioned"
    });
    expect((await ambiguousRepository.markAmbiguous(ambiguous)).kind).toBe("idempotent");
    await expectRepositoryError(ambiguousRepository.settle({
      ...ambiguousIdentity,
      actualUsage: usage(),
      leaseToken: ambiguousInput.leaseToken,
      providerResponseId: null,
      settledAt: new Date("2026-08-19T10:03:00.000Z")
    }), "invalid_state");
  });

  it("purges private rows under the local guard and retains content-free state", async () => {
    const oversized = "x".repeat(4_000);
    const manifest = draft([
      availableCandidate(),
      availableCandidate({
        evidenceId: "dispatch-evidence-2",
        exactExcerpt: oversized,
        handle: "K2",
        operationOrdinal: 2
      })
    ], 1_000);
    expect(manifest.exclusions.map(({ reason }) => reason)).toEqual(["budget"]);
    const fake = createFakePrisma({
      evidenceItems: [
        ...createFakePrisma().state.evidenceItems,
        {
          excerpt: oversized,
          fileName: "second.txt",
          handle: "K2",
          id: "evidence-item-2",
          retrievalSessionId: "session-1",
          sourceArtifactId: "artifact-2",
          sourceName: "Second",
          sourceVersionId: "source-version-2",
          sourceVersionNumber: 1,
          state: "available",
          textTruncated: false
        }
      ],
      sourceBindings: [
        ...createFakePrisma().state.sourceBindings,
        {
          fileNameSnapshot: "second.txt",
          profileBinding: { profileRevisionId: "profile-revision-2" },
          sourceAlias: "S1",
          sourceArtifactId: "artifact-2",
          sourceNameSnapshot: "Second",
          sourceVersionId: "source-version-2",
          sourceVersionNumber: 1
        }
      ]
    });
    const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
    const input = reserveInput(manifest, [
      { dispatchEvidenceId: "dispatch-evidence-1", evidenceItemId: "evidence-item-1" },
      { dispatchEvidenceId: "dispatch-evidence-2", evidenceItemId: "evidence-item-2" }
    ]);
    const reserved = await repository.reserve(input);
    const result = await repository.purge({
      manifestIds: [reserved.dispatch.manifestId],
      modelRunId: "run-1",
      purgedAt: SETTLED
    });

    expect(result).toEqual({ alreadyPurgedCount: 0, purgedCount: 1 });
    expect(fake.executeRaw).toHaveBeenCalledTimes(1);
    expect(fake.state.attempts[0]).toMatchObject({ state: "reserved" });
    expect(fake.state.manifests[0]).toMatchObject({
      coverage: null,
      excludedCount: 1,
      itemCount: 1,
      messageHash: null,
      messageText: null,
      profileRevisionIds: [],
      purgedAt: SETTLED
    });
    expect(fake.state.items[0]).toMatchObject({
      contextBoundaries: null,
      evidenceItemId: null,
      exactExcerpt: null,
      handle: null,
      renderedBlock: null,
      representation: "purged",
      safeMetadata: null
    });
    expect(fake.state.exclusions[0]).toMatchObject({
      evidenceItemId: null,
      handle: null,
      reason: "purged"
    });
    expect(await repository.purge({
      manifestIds: [reserved.dispatch.manifestId],
      modelRunId: "run-1",
      purgedAt: new Date("2026-08-19T10:03:00.000Z")
    })).toEqual({ alreadyPurgedCount: 1, purgedCount: 0 });

    await expectRepositoryError(repository.purge({
      manifestIds: [reserved.dispatch.manifestId],
      modelRunId: "run-other",
      purgedAt: new Date("2026-08-19T10:04:00.000Z")
    }), "target_unavailable");
  });

  it("never sends private dispatch content to console logging", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fake = createFakePrisma();
      const repository = createPrismaKnowledgeEvidenceDispatchRepository(fake.client);
      await repository.reserve(reserveInput());
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

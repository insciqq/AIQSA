import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import {
  cleanupKnowledgeHierarchicalEvaluationFixture,
  createKnowledgeHierarchicalEvaluationFixture,
  persistKnowledgeHierarchicalEvaluationFixture,
  type KnowledgeHierarchicalEvaluationEntry,
  type KnowledgeHierarchicalEvaluationFixture
} from "../../../tests/knowledge-evals/hierarchicalIndexes";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import {
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME
} from "./retrievalTypes";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import {
  compactKnowledgeToolExecutionResult,
  knowledgeEvidenceFromToolResult,
  rehydratePersistedKnowledgeToolExecutionResult
} from "./toolResult";

const now = new Date("2026-08-19T00:00:00.000Z");
const vectorSpaceFingerprint = "4".repeat(64);

type BaseFixture = Readonly<{
  baseId: string;
  generationId: string;
  name: string;
  snapshotId: string;
}>;

type CanonicalRuntimeFixture = Readonly<{
  baseA: BaseFixture;
  baseB: BaseFixture;
  chatIds: readonly string[];
  credentialId: string;
  credentialVersionId: string;
  directExactToolCallId: string;
  directProfileBindingId: string;
  directRunId: string;
  exactToolCallId: string;
  readToolCallId: string;
  runAId: string;
  runABId: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function persistBase(
  client: Prisma.TransactionClient,
  input: Readonly<{
    entry: KnowledgeHierarchicalEvaluationEntry;
    name: string;
    ordinal: number;
    prefix: string;
    state: KnowledgeHierarchicalEvaluationFixture;
  }>
): Promise<BaseFixture> {
  const baseId = `${input.prefix}-base-${input.ordinal}`;
  const generationId = `${input.prefix}-generation-${input.ordinal}`;
  const snapshotId = `${input.prefix}-snapshot-${input.ordinal}`;
  await client.knowledgeBase.create({
    data: {
      contentRevision: 1,
      id: baseId,
      name: input.name,
      ownerUserId: input.state.ownerUserId
    }
  });
  await client.knowledgeIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: input.state.modelId,
      id: generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: baseId,
      profileRevisionId: input.state.profileRevisionId,
      readyAt: now,
      status: "active",
      targetDimension: 1_024,
      vectorSpaceFingerprint
    }
  });
  await client.knowledgeBase.update({
    data: { activeIndexGenerationId: generationId },
    where: { id: baseId }
  });
  await client.knowledgeBaseSource.create({
    data: {
      knowledgeBaseId: baseId,
      ownerUserId: input.state.ownerUserId,
      sourceId: input.entry.sourceId
    }
  });
  await client.knowledgeBaseSnapshot.create({
    data: {
      evidenceFingerprint: sha256(`${snapshotId}\0${input.entry.artifactId}`),
      id: snapshotId,
      indexGenerationId: generationId,
      knowledgeBaseId: baseId,
      ownerUserId: input.state.ownerUserId,
      profileRevisionId: input.state.profileRevisionId,
      readySourceCount: 1,
      sourceCount: 1,
      sourceRevision: 1
    }
  });
  await client.knowledgeBaseSnapshotSource.create({
    data: {
      artifactId: input.entry.artifactId,
      knowledgeBaseId: baseId,
      ordinal: 0,
      ownerUserId: input.state.ownerUserId,
      snapshotId,
      sourceId: input.entry.sourceId,
      sourceVersionId: input.entry.versionId
    }
  });
  return Object.freeze({ baseId, generationId, name: input.name, snapshotId });
}

async function persistRun(
  client: Prisma.TransactionClient,
  input: Readonly<{
    bases: readonly BaseFixture[];
    credentialId: string;
    credentialVersionId: string;
    label: string;
    state: KnowledgeHierarchicalEvaluationFixture;
  }>
): Promise<Readonly<{ chatId: string; runId: string }>> {
  const chat = await client.chat.create({
    data: {
      title: `Canonical Source ${input.label}`,
      userId: input.state.ownerUserId
    }
  });
  const message = await client.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Canonical Source attribution proof"),
      role: "user"
    }
  });
  await client.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  const run = await client.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "knowledge-canonical-source-answer",
      normalizedRequest: {},
      provider: "fake",
      status: "in_progress",
      userId: input.state.ownerUserId,
      userMessageId: message.id
    }
  });
  for (const [ordinal, base] of input.bases.entries()) {
    await client.knowledgeRunBinding.create({
      data: {
        baseContentRevision: 1,
        embeddingConnectionId: input.state.connectionId,
        embeddingCredentialId: input.credentialId,
        embeddingCredentialSource: "default",
        embeddingCredentialVersionId: input.credentialVersionId,
        embeddingExecutionSnapshot: json({ synthetic: true }),
        embeddingProviderModelId: input.state.modelId,
        indexGenerationId: base.generationId,
        indexedContentRevision: 1,
        knowledgeBaseId: base.baseId,
        knowledgeBaseSnapshotId: base.snapshotId,
        modelRunId: run.id,
        ordinal,
        targetDimension: 1_024,
        vectorSpaceFingerprint
      }
    });
  }
  return Object.freeze({ chatId: chat.id, runId: run.id });
}

async function persistCanonicalRuntimeFixtureTransaction(
  client: Prisma.TransactionClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  entry: KnowledgeHierarchicalEvaluationEntry,
  directEntry: KnowledgeHierarchicalEvaluationEntry
): Promise<CanonicalRuntimeFixture> {
  const prefix = `${state.prefix}-canonical-${randomUUID()}`;
  const credentialId = `${prefix}-credential`;
  const credentialVersionId = `${prefix}-credential-version`;
  await client.providerCredential.create({
    data: {
      connectionId: state.connectionId,
      enabled: true,
      id: credentialId,
      label: "Canonical Source test credential"
    }
  });
  await client.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testEvidence: { synthetic: true },
      testedAt: now,
      version: 1
    }
  });
  await client.providerCredential.update({
    data: { activatedAt: now, activeVersionId: credentialVersionId },
    where: { id: credentialId }
  });

  const baseA = await persistBase(client, {
    entry,
    name: "Canonical Base A",
    ordinal: 0,
    prefix,
    state
  });
  const baseB = await persistBase(client, {
    entry,
    name: "Canonical Base B",
    ordinal: 1,
    prefix,
    state
  });
  const runA = await persistRun(client, {
    bases: [baseA],
    credentialId,
    credentialVersionId,
    label: "A only",
    state
  });
  const runAB = await persistRun(client, {
    bases: [baseA, baseB],
    credentialId,
    credentialVersionId,
    label: "A and B",
    state
  });
  const directRun = await persistRun(client, {
    bases: [],
    credentialId,
    credentialVersionId,
    label: "direct Source only",
    state
  });
  await client.knowledgeRunScope.create({
    data: {
      budgetPolicy: json(DEFAULT_KNOWLEDGE_BUDGET_POLICY),
      exclusions: [],
      modelRunId: runAB.runId,
      resolvedBaseCount: 2,
      resolvedSourceCount: 1,
      selection: json({
        baseIds: [baseA.baseId, baseB.baseId],
        mode: "explicit",
        sourceIds: [],
        version: 1
      })
    }
  });
  await client.knowledgeRunScope.create({
    data: {
      budgetPolicy: json(DEFAULT_KNOWLEDGE_BUDGET_POLICY),
      exclusions: [],
      modelRunId: directRun.runId,
      resolvedBaseCount: 0,
      resolvedSourceCount: 1,
      selection: json({
        baseIds: [],
        mode: "explicit",
        sourceIds: [directEntry.sourceId],
        version: 1
      })
    }
  });
  const directProfileBinding = await client.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: state.connectionId,
      embeddingCredentialId: credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: credentialVersionId,
      embeddingExecutionSnapshot: json({ synthetic: true }),
      embeddingProviderModelId: state.modelId,
      modelRunId: directRun.runId,
      ordinal: 0,
      profileRevisionId: state.profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint
    },
    select: { id: true }
  });
  await client.knowledgeRunSourceBinding.create({
    data: {
      accessProvenance: json({
        authority: { knowledgeBaseIds: [], owner: true, projectId: null },
        selectionProvenance: ["explicit_source"]
      }),
      baseProvenance: [],
      directSelected: true,
      fileNameSnapshot: directEntry.source.fileName,
      modelRunId: directRun.runId,
      ordinal: 0,
      profileBindingId: directProfileBinding.id,
      readinessState: "ready",
      selectionKind: "direct",
      sourceAlias: "S1",
      sourceArtifactId: directEntry.artifactId,
      sourceId: directEntry.sourceId,
      sourceNameSnapshot: directEntry.source.displayName,
      sourceVersionId: directEntry.versionId,
      sourceVersionNumber: 1
    }
  });
  const exactCall = await client.modelRunToolCall.create({
    data: {
      arguments: json({
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        sourceAliases: ["S1"],
        value: "completed exports for 37 days"
      }),
      modelRunId: runAB.runId,
      ordinal: 0,
      providerCallId: `${prefix}-exact-provider-call`,
      roundIndex: 0,
      startedAt: now,
      state: "running",
      toolName: KNOWLEDGE_EXACT_TOOL_NAME
    }
  });
  const readCall = await client.modelRunToolCall.create({
    data: {
      arguments: json({
        direction: "around",
        locator: "K1",
        sourceAlias: "S1",
        window: 3
      }),
      modelRunId: runAB.runId,
      ordinal: 0,
      providerCallId: `${prefix}-read-provider-call`,
      roundIndex: 1,
      startedAt: now,
      state: "running",
      toolName: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    }
  });
  const directExactCall = await client.modelRunToolCall.create({
    data: {
      arguments: json({
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        sourceAliases: ["S1"],
        value: "архивные материалы проекта Береста"
      }),
      modelRunId: directRun.runId,
      ordinal: 0,
      providerCallId: `${prefix}-direct-exact-provider-call`,
      roundIndex: 0,
      startedAt: now,
      state: "running",
      toolName: KNOWLEDGE_EXACT_TOOL_NAME
    }
  });
  return Object.freeze({
    baseA,
    baseB,
    chatIds: Object.freeze([runA.chatId, runAB.chatId, directRun.chatId]),
    credentialId,
    credentialVersionId,
    directExactToolCallId: directExactCall.id,
    directProfileBindingId: directProfileBinding.id,
    directRunId: directRun.runId,
    exactToolCallId: exactCall.id,
    readToolCallId: readCall.id,
    runAId: runA.runId,
    runABId: runAB.runId
  });
}

async function persistCanonicalRuntimeFixture(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  entry: KnowledgeHierarchicalEvaluationEntry,
  directEntry: KnowledgeHierarchicalEvaluationEntry
): Promise<CanonicalRuntimeFixture> {
  return client.$transaction(
    (tx) => persistCanonicalRuntimeFixtureTransaction(tx, state, entry, directEntry),
    { timeout: 120_000 }
  );
}

async function admitBaseSourceToCanonicalProfile(
  client: PrismaClient,
  input: Readonly<{
    entry: KnowledgeHierarchicalEvaluationEntry;
    fixture: CanonicalRuntimeFixture;
    state: KnowledgeHierarchicalEvaluationFixture;
  }>
): Promise<string> {
  return client.$transaction(async (tx) => {
    const profile = await tx.knowledgeRunProfileBinding.create({
      data: {
        embeddingConnectionId: input.state.connectionId,
        embeddingCredentialId: input.fixture.credentialId,
        embeddingCredentialSource: "default",
        embeddingCredentialVersionId: input.fixture.credentialVersionId,
        embeddingExecutionSnapshot: json({ synthetic: true }),
        embeddingProviderModelId: input.state.modelId,
        modelRunId: input.fixture.runABId,
        ordinal: 0,
        profileRevisionId: input.state.profileRevisionId,
        targetDimension: 1_024,
        vectorSpaceFingerprint
      },
      select: { id: true }
    });
    await tx.knowledgeRunBinding.updateMany({
      data: { profileBindingId: profile.id },
      where: { modelRunId: input.fixture.runABId }
    });
    await tx.knowledgeRunSourceBinding.create({
      data: {
        accessProvenance: json({
          authority: {
            knowledgeBaseIds: [input.fixture.baseA.baseId, input.fixture.baseB.baseId],
            owner: true,
            projectId: null
          },
          selectionProvenance: ["base"]
        }),
        baseProvenance: json([
          { knowledgeBaseId: input.fixture.baseA.baseId },
          { knowledgeBaseId: input.fixture.baseB.baseId }
        ]),
        directSelected: false,
        fileNameSnapshot: input.entry.source.fileName,
        modelRunId: input.fixture.runABId,
        ordinal: 0,
        profileBindingId: profile.id,
        readinessState: "ready",
        selectionKind: "base",
        sourceAlias: "S1",
        sourceArtifactId: input.entry.artifactId,
        sourceId: input.entry.sourceId,
        sourceNameSnapshot: input.entry.source.displayName,
        sourceVersionId: input.entry.versionId,
        sourceVersionNumber: 1
      }
    });
    return profile.id;
  }, { timeout: 120_000 });
}

async function cleanupCanonicalRuntimeFixture(
  client: PrismaClient,
  fixture: CanonicalRuntimeFixture
): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.modelRun.deleteMany({
      where: { id: { in: [fixture.runAId, fixture.runABId, fixture.directRunId] } }
    });
    await tx.chat.deleteMany({ where: { id: { in: [...fixture.chatIds] } } });
    const snapshotIds = [fixture.baseA.snapshotId, fixture.baseB.snapshotId];
    const baseIds = [fixture.baseA.baseId, fixture.baseB.baseId];
    const generationIds = [fixture.baseA.generationId, fixture.baseB.generationId];
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { snapshotId: { in: snapshotIds } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
    await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: { in: baseIds } } });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: baseIds } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({ where: { id: { in: generationIds } } });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: baseIds } } });
    await tx.providerCredential.update({
      data: { activeVersionId: null },
      where: { id: fixture.credentialId }
    });
    await tx.providerCredentialVersion.deleteMany({
      where: { id: fixture.credentialVersionId }
    });
    await tx.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
  }, { timeout: 120_000 });
}

describe("Prisma canonical Source attribution and deterministic replay", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("retrieves a direct-only Source, deduplicates Bases A+B, and replays a persisted read", async () => {
    const state = createKnowledgeHierarchicalEvaluationFixture();
    let runtime: CanonicalRuntimeFixture | null = null;
    try {
      await persistKnowledgeHierarchicalEvaluationFixture(prisma, state);
      const source = state.entries.find((entry) =>
        entry.ownerUserId === state.ownerUserId && entry.logicalSourceId === "source-001");
      const directSource = state.entries.find((entry) =>
        entry.ownerUserId === state.ownerUserId && entry.logicalSourceId === "source-002");
      if (!source || !directSource) throw new Error("knowledge_canonical_source_fixture_missing");
      runtime = await persistCanonicalRuntimeFixture(prisma, state, source, directSource);
      const store = createPrismaKnowledgeRetrievalStore(prisma);
      const query = "Atlas exports retained";
      const exactQuery = "completed exports for 37 days";
      const commonSearch = {
        candidateLimit: 40,
        operation: "search_knowledge",
        query,
        resultLimit: 8,
        threshold: 0.01,
        userId: state.ownerUserId,
        vectors: []
      } as const;
      const [onlyA, both] = await Promise.all([
        store.hybridSearch({ ...commonSearch, runId: runtime.runAId }),
        store.hybridSearch({ ...commonSearch, runId: runtime.runABId })
      ]);

      expect(onlyA).toMatchObject({
        bindingCount: 1,
        candidateCount: 1,
        candidateCounts: { 0: 1 }
      });
      expect(both).toMatchObject({
        bindingCount: 2,
        candidateCount: 1,
        candidateCounts: { 0: 1, 1: 0 }
      });
      expect(Object.values(both.candidateCounts).reduce((sum, count) => sum + count, 0))
        .toBe(both.candidateCount);
      expect(both.passages.map((passage) => passage.chunkId))
        .toEqual(onlyA.passages.map((passage) => passage.chunkId));
      expect(both.passages.map((passage) => passage.fusedScore))
        .toEqual(onlyA.passages.map((passage) => passage.fusedScore));
      expect(both.rankingEvidence?.postRerankOrder)
        .toEqual(onlyA.rankingEvidence?.postRerankOrder);
      expect(both.canonicalSourceProvenance).toEqual([{
        artifactId: source.artifactId,
        bindings: [
          {
            baseName: runtime.baseA.name,
            bindingOrdinal: 0,
            knowledgeBaseId: runtime.baseA.baseId
          },
          {
            baseName: runtime.baseB.name,
            bindingOrdinal: 1,
            knowledgeBaseId: runtime.baseB.baseId
          }
        ],
        primaryBindingOrdinal: 0,
        sourceId: source.sourceId,
        sourceVersionId: source.versionId
      }]);

      const aliases = await store.loadScopeAliases!({
        runId: runtime.runABId,
        userId: state.ownerUserId
      });
      expect(aliases.filter((alias) => alias.kind === "source")).toEqual([{
        alias: "S1",
        bindingOrdinal: 0,
        bindingOrdinals: [0, 1],
        kind: "source",
        label: source.source.displayName,
        sourceArtifactId: source.artifactId,
        sourceId: source.sourceId,
        sourceVersionId: source.versionId
      }]);

      const [directAttachmentCount, directBaseBindingCount, directProfileBinding, directBindings] =
        await Promise.all([
          prisma.knowledgeBaseSource.count({ where: { sourceId: directSource.sourceId } }),
          prisma.knowledgeRunBinding.count({ where: { modelRunId: runtime.directRunId } }),
          prisma.knowledgeRunProfileBinding.findMany({
            select: { id: true, ordinal: true, profileRevisionId: true },
            where: { modelRunId: runtime.directRunId }
          }),
          prisma.knowledgeRunSourceBinding.findMany({
            select: {
              baseProvenance: true,
              directSelected: true,
              profileBindingId: true,
              sourceAlias: true,
              sourceArtifactId: true,
              sourceId: true,
              sourceVersionId: true
            },
            where: { modelRunId: runtime.directRunId }
          })
        ]);
      expect(directAttachmentCount).toBe(0);
      expect(directBaseBindingCount).toBe(0);
      expect(directProfileBinding).toEqual([{
        id: runtime.directProfileBindingId,
        ordinal: 0,
        profileRevisionId: state.profileRevisionId
      }]);
      expect(directBindings).toEqual([{
        baseProvenance: [],
        directSelected: true,
        profileBindingId: runtime.directProfileBindingId,
        sourceAlias: "S1",
        sourceArtifactId: directSource.artifactId,
        sourceId: directSource.sourceId,
        sourceVersionId: directSource.versionId
      }]);

      const directExecutionBindings = await store.loadBindings({
        runId: runtime.directRunId,
        userId: state.ownerUserId
      });
      expect(directExecutionBindings).toEqual([expect.objectContaining({
        executionScope: "profile",
        knowledgeBaseId: runtime.directProfileBindingId,
        profileRevisionId: state.profileRevisionId,
        selectedSourceIds: [directSource.sourceId]
      })]);
      const directAliases = await store.loadScopeAliases!({
        runId: runtime.directRunId,
        userId: state.ownerUserId
      });
      expect(directAliases).toEqual([{
        alias: "S1",
        bindingOrdinal: 0,
        bindingOrdinals: [0],
        kind: "source",
        label: directSource.source.displayName,
        sourceArtifactId: directSource.artifactId,
        sourceId: directSource.sourceId,
        sourceVersionId: directSource.versionId
      }]);
      const directQuery = "архивные материалы проекта Береста";
      const directSearch = await store.hybridSearch({
        ...commonSearch,
        query: directQuery,
        runId: runtime.directRunId
      });
      expect(directSearch).toMatchObject({
        bindingCount: 1,
        candidateCount: 1,
        candidateCounts: { 0: 1 }
      });
      expect(directSearch.passages).toHaveLength(1);
      expect(directSearch.passages[0]).toMatchObject({
        documentId: directSource.sourceId,
        documentVersionId: directSource.versionId,
        knowledgeBaseId: runtime.directProfileBindingId,
        sourceArtifactId: directSource.artifactId
      });
      expect(directSearch.canonicalSourceProvenance).toEqual([{
        artifactId: directSource.artifactId,
        bindings: [{
          baseName: "Pinned Knowledge Profile",
          bindingOrdinal: 0,
          knowledgeBaseId: runtime.directProfileBindingId
        }],
        primaryBindingOrdinal: 0,
        sourceId: directSource.sourceId,
        sourceVersionId: directSource.versionId
      }]);

      // The H1 assertions above exercise the legacy Base A/B canonicalization.
      // H3 exact/read execution consumes the immutable admitted-run Source
      // projection linked to one pinned profile binding.
      const runABProfileBindingId = await admitBaseSourceToCanonicalProfile(prisma, {
        entry: source,
        fixture: runtime,
        state
      });

      const embeddingResolve = vi.fn(async () => {
        throw new Error("knowledge_embedding_must_not_run");
      });
      const executor = createKnowledgeToolExecutor({
        embeddingRuntime: { resolve: embeddingResolve },
        store
      });
      const directExactResult = await executor.execute({
        arguments: {
          caseMode: "insensitive",
          cursor: null,
          field: "body",
          limit: 8,
          match: "phrase",
          sourceAliases: ["S1"],
          value: directQuery
        },
        id: "canonical-direct-source-provider-call",
        name: KNOWLEDGE_EXACT_TOOL_NAME
      }, {
        persistedToolCallId: runtime.directExactToolCallId,
        request: {} as never,
        runId: runtime.directRunId,
        userId: state.ownerUserId
      });
      expect(directExactResult.status).toBe("complete");
      const directExactEvidence = knowledgeEvidenceFromToolResult(directExactResult);
      expect(directExactEvidence).toMatchObject({
        candidateCount: 1,
        operation: "find_exact",
        results: [{
          documentId: directSource.sourceId,
          documentVersionId: directSource.versionId,
          sourceAlias: "S1",
          sourceArtifactId: directSource.artifactId
        }],
        scopeAliases: [{
          alias: "S1",
          kind: "source",
          label: directSource.source.displayName
        }],
        version: 2
      });
      expect(directExactEvidence?.scopeAliases?.some((alias) => alias.kind === "base")).toBe(false);
      expect(directExactResult.content[0]).toMatchObject({ type: "text" });
      const directProviderText = directExactResult.content[0]?.type === "text"
        ? directExactResult.content[0].text
        : "";
      expect(directProviderText).toContain("[K1] [S1]");
      expect(directProviderText).not.toContain("[B1]");

      const exactCall = {
        arguments: {
          caseMode: "insensitive",
          cursor: null,
          field: "body",
          limit: 8,
          match: "phrase",
          sourceAliases: ["S1"],
          value: exactQuery
        },
        id: "canonical-source-provider-call",
        name: KNOWLEDGE_EXACT_TOOL_NAME
      } as const;
      const exactResult = await executor.execute(exactCall, {
        persistedToolCallId: runtime.exactToolCallId,
        request: {} as never,
        runId: runtime.runABId,
        userId: state.ownerUserId
      });
      expect(exactResult.status).toBe("complete");
      const exactEvidence = knowledgeEvidenceFromToolResult(exactResult);
      expect(exactEvidence).toMatchObject({
        candidateCount: 1,
        operation: "find_exact",
        results: [{ sourceAlias: "S1" }],
        version: 2
      });
      expect(exactEvidence?.scopeAliases?.filter((alias) => alias.kind === "source"))
        .toEqual([{ alias: "S1", kind: "source", label: source.source.displayName }]);
      expect(exactResult.content).toHaveLength(1);
      expect(exactResult.content[0]).toMatchObject({ type: "text" });
      const providerText = exactResult.content[0]?.type === "text"
        ? exactResult.content[0].text
        : "";
      expect(providerText.match(/--- BEGIN SOURCE EVIDENCE K1 ---/gu)).toHaveLength(1);
      expect(providerText.match(/\[K1\] \[S1\]/gu)).toHaveLength(1);
      expect(embeddingResolve).not.toHaveBeenCalled();

      const compacted = compactKnowledgeToolExecutionResult(exactResult);
      expect(compacted).not.toBeNull();
      expect(rehydratePersistedKnowledgeToolExecutionResult(compacted!)).toEqual(exactResult);

      const persistedExact = await prisma.knowledgeRun.findUniqueOrThrow({
        select: {
          evidenceLinks: {
            orderBy: { resultOrdinal: "asc" },
            select: { retrievalProvenance: true }
          }
        },
        where: { modelRunToolCallId: runtime.exactToolCallId }
      });
      expect(persistedExact.evidenceLinks).toHaveLength(1);
      expect(persistedExact.evidenceLinks[0]?.retrievalProvenance).toMatchObject({
        source: {
          artifactId: source.artifactId,
          bindings: [{
            baseName: "Pinned Knowledge Profile",
            bindingOrdinal: 0,
            knowledgeBaseId: runABProfileBindingId
          }],
          primaryBindingOrdinal: 0,
          sourceId: source.sourceId,
          sourceVersionId: source.versionId
        },
        version: 2
      });

      const readSource = vi.fn(store.readSource!.bind(store));
      const loadBindings = vi.fn(store.loadBindings.bind(store));
      const loadScopeAliases = vi.fn(store.loadScopeAliases!.bind(store));
      const budgetState = vi.fn(store.budgetState!.bind(store));
      const replayStore = {
        ...store,
        budgetState,
        loadBindings,
        loadScopeAliases,
        readSource
      };
      const readExecutor = createKnowledgeToolExecutor({
        embeddingRuntime: { resolve: embeddingResolve },
        store: replayStore
      });
      const readCall = {
        arguments: {
          direction: "around",
          locator: exactEvidence!.results[0]!.handle,
          sourceAlias: "S1",
          window: 3
        },
        id: "canonical-source-read-provider-call",
        name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
      } as const;
      const readContext = {
        persistedToolCallId: runtime.readToolCallId,
        request: {} as never,
        runId: runtime.runABId,
        userId: state.ownerUserId
      };
      const firstRead = await readExecutor.execute(readCall, readContext);
      const firstReadEvidence = knowledgeEvidenceFromToolResult(firstRead);
      expect(firstReadEvidence).toMatchObject({
        embeddingExecutions: [],
        operation: "read_source",
        outcome: "complete",
        read: {
          embedding: "forbidden",
          resolvedSource: {
            sourceAlias: "S1",
            sourceArtifactId: source.artifactId,
            sourceId: source.sourceId,
            sourceName: source.source.displayName,
            sourceVersionId: source.versionId
          }
        },
        results: [{ sourceAlias: "S1" }],
        version: 2
      });
      expect(readSource).toHaveBeenCalledOnce();
      const beforeReplay = {
        budgetState: budgetState.mock.calls.length,
        loadBindings: loadBindings.mock.calls.length,
        loadScopeAliases: loadScopeAliases.mock.calls.length,
        readSource: readSource.mock.calls.length
      };
      const admission = await readExecutor.preflight!(readCall, readContext);
      const secondRead = await readExecutor.execute(readCall, readContext);
      expect(admission).toMatchObject({ kind: "replayed" });
      expect(secondRead).toEqual(firstRead);
      const firstReadText = firstRead.content[0]?.type === "text"
        ? firstRead.content[0].text
        : "";
      const secondReadText = secondRead.content[0]?.type === "text"
        ? secondRead.content[0].text
        : "";
      expect(Buffer.from(secondReadText, "utf8")).toEqual(Buffer.from(firstReadText, "utf8"));
      expect(budgetState).toHaveBeenCalledTimes(beforeReplay.budgetState);
      expect(loadBindings).toHaveBeenCalledTimes(beforeReplay.loadBindings);
      expect(loadScopeAliases).toHaveBeenCalledTimes(beforeReplay.loadScopeAliases);
      expect(readSource).toHaveBeenCalledTimes(beforeReplay.readSource);
      expect(embeddingResolve).not.toHaveBeenCalled();
      await expect(prisma.knowledgeRun.findUniqueOrThrow({
        select: { operation: true, readReceipt: true },
        where: { modelRunToolCallId: runtime.readToolCallId }
      })).resolves.toMatchObject({
        operation: "read_source",
        readReceipt: {
          embedding: "forbidden",
          resolvedSource: {
            sourceAlias: "S1",
            sourceArtifactId: source.artifactId,
            sourceId: source.sourceId,
            sourceName: source.source.displayName,
            sourceVersionId: source.versionId
          }
        }
      });
    } finally {
      if (runtime) await cleanupCanonicalRuntimeFixture(prisma, runtime);
      await cleanupKnowledgeHierarchicalEvaluationFixture(prisma, state);
    }
  }, 180_000);
});

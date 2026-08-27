import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { memoryCounterEffectFor } from "../../../../domain/memory/counters";
import { enqueueMemoryEmbeddingBatchItem } from "../../embedding/enqueue";
import { loadPersonalMemoryEvidenceSnapshots } from "../../persistence/eligibility";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../../persistence/scopes";
import {
  advanceMemoryMutation,
  ensureActiveLexicalGeneration,
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryActiveIndex,
  type MemoryTransaction
} from "../../persistence/transaction";
import type { MemoryRetainedSourceMutationEvent } from "../../sourceState";
import { removeUnsupportedMemoryEntityLinks } from "../entities/lifecycle";

type FactRow = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string | null;
  id: string;
  state: "ACTIVE" | "CONFLICTED" | "EXPIRED" | "ORPHANED" | "RETRACTED";
}>;

type VersionRow = Readonly<{
  category: string;
  displayText: string | null;
  factId: string;
  id: string;
  ingestionFingerprint: string | null;
  languageCode: string;
  modality:
    | "CONSIDERATION"
    | "CONSTRAINT"
    | "EVENT"
    | "HABIT"
    | "INTENTION"
    | "PLAN"
    | "PREFERENCE"
    | "STATE"
    | "WORKFLOW";
  sensitivityClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET" | "SENSITIVE";
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state:
    | "ACTIVE"
    | "CONFLICTING"
    | "EXPIRED"
    | "FORGOTTEN"
    | "MERGED"
    | "ORPHANED"
    | "PENDING_RELATION"
    | "RETRACTED"
    | "SUPERSEDED";
  structuredValue: Prisma.JsonValue | null;
  systemFrom: Date;
  systemTo: Date | null;
}>;

type SupportRow = Readonly<{
  factVersionId: string;
  latestObservedAt: Date | null;
  supportCount: bigint;
}>;

function parentAdvancedMemoryRevision(event: MemoryRetainedSourceMutationEvent): boolean {
  return event.mutations.some((mutation) =>
    memoryCounterEffectFor(mutation).memoryRevision);
}

function invalidationPredicate(event: MemoryRetainedSourceMutationEvent): Prisma.Sql | null {
  const fullSourceInvalidation =
    event.mutations.includes("SOURCE_HARD_DELETE") ||
    event.mutations.includes("SOURCE_EXCLUDE") ||
    event.snapshot.memoryMode !== "NORMAL";
  const branchChanged = event.previous.memoryBranchGeneration !==
    event.snapshot.memoryBranchGeneration;
  const folderChanged = event.previous.folderId !== event.snapshot.folderId;
  if (!fullSourceInvalidation && !branchChanged && !folderChanged) return null;
  const branches: Prisma.Sql[] = [];
  if (fullSourceInvalidation) branches.push(Prisma.sql`TRUE`);
  if (branchChanged) {
    const retainedMessageIds = event.snapshot.messages.map(({ id }) => id);
    branches.push(retainedMessageIds.length === 0
      ? Prisma.sql`TRUE`
      : Prisma.sql`
          evidence."messageId" IS NULL
          OR evidence."messageId" NOT IN (${Prisma.join(retainedMessageIds)})
        `);
  }
  if (folderChanged && event.previous.folderId) {
    branches.push(Prisma.sql`
      scope."scopeType" = 'FOLDER'::"MemoryScopeType"
      AND scope."targetIdSnapshot" = ${event.previous.folderId}
    `);
  }
  return Prisma.join(branches, " OR ");
}

async function affectedEvidence(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent,
  predicate: Prisma.Sql
): Promise<Readonly<{
  evidenceIds: string[];
  factIds: string[];
  versionIds: string[];
}>> {
  const rows = await tx.$queryRaw<Array<{
    evidenceId: string;
    factId: string;
    versionId: string;
  }>>(Prisma.sql`
    SELECT evidence."id" AS "evidenceId", version."factId",
      version."id" AS "versionId"
    FROM "MemoryEvidence" AS evidence
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = evidence."userId"
      AND version."id" = evidence."factVersionId"
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE evidence."userId" = ${event.snapshot.userId}
      AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
      AND evidence."chatId" = ${event.snapshot.id}
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND (${predicate})
    ORDER BY version."factId", evidence."id"
  `);
  return {
    evidenceIds: rows.map(({ evidenceId }) => evidenceId),
    factIds: [...new Set(rows.map(({ factId }) => factId))],
    versionIds: [...new Set(rows.map(({ versionId }) => versionId))]
  };
}

async function lockFacts(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[]
): Promise<FactRow[]> {
  if (factIds.length === 0) return [];
  return tx.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT "id", "canonicalKey", "category", "state"::text AS "state",
      "currentVersionId"
    FROM "MemoryFact"
    WHERE "userId" = ${userId} AND "id" IN (${Prisma.join([...factIds])})
    ORDER BY "id"
    FOR UPDATE
  `);
}

async function versionsAndSupport(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[]
): Promise<Readonly<{
  support: ReadonlyMap<string, SupportRow>;
  versions: readonly VersionRow[];
}>> {
  const versions = await tx.memoryFactVersion.findMany({
    orderBy: [{ factId: "asc" }, { systemFrom: "asc" }, { id: "asc" }],
    select: {
      category: true,
      displayText: true,
      factId: true,
      id: true,
      ingestionFingerprint: true,
      languageCode: true,
      modality: true,
      sensitivityClass: true,
      sourceMode: true,
      state: true,
      structuredValue: true,
      systemFrom: true,
      systemTo: true
    },
    where: { factId: { in: [...factIds] }, userId }
  }) as VersionRow[];
  if (versions.length === 0) return { support: new Map(), versions };
  const explicitRows = await tx.$queryRaw<SupportRow[]>(Prisma.sql`
    SELECT evidence."factVersionId",
      count(*)::bigint AS "supportCount",
      max(evidence."observedAt") AS "latestObservedAt"
    FROM "MemoryEvidence" AS evidence
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = evidence."userId"
      AND version."id" = evidence."factVersionId"
    WHERE evidence."userId" = ${userId}
      AND evidence."factVersionId" IN (${Prisma.join(versions.map(({ id }) => id))})
      AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND evidence."sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType"
    GROUP BY evidence."factVersionId"
  `);
  const support = new Map(explicitRows.map((row) => [row.factVersionId, row]));
  const automaticEvidence = await loadPersonalMemoryEvidenceSnapshots(
    tx,
    userId,
    versions.flatMap((version) => version.sourceMode === "AUTOMATIC" ? [version.id] : [])
  );
  for (const evidence of automaticEvidence) {
    const current = support.get(evidence.factVersionId);
    support.set(evidence.factVersionId, {
      factVersionId: evidence.factVersionId,
      latestObservedAt: !current || !current.latestObservedAt ||
        evidence.observedAt > current.latestObservedAt
        ? evidence.observedAt
        : current.latestObservedAt,
      supportCount: (current?.supportCount ?? 0n) + 1n
    });
  }
  return { support, versions };
}

function transitionAt(now: Date, version: VersionRow): Date {
  return new Date(Math.max(
    now.getTime(),
    version.systemFrom.getTime() + 1,
    (version.systemTo?.getTime() ?? -1) + 1
  ));
}

async function sourceInvalidationEvent(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent,
  factId: string,
  versionId: string,
  outcome: "EVIDENCE_REMOVED" | "FACT_RETRACTED" | "POINTER_RESTORED"
): Promise<string> {
  const id = randomUUID();
  await tx.memoryEvent.create({
    data: {
      actorType: "SYSTEM",
      factId,
      factVersionId: versionId,
      id,
      metadata: {
        outcome,
        reason: "source_invalidated",
        schemaVersion: "memory-fact-source-normalization-v1"
      },
      operation: "SOURCE_INVALIDATE",
      sourceChatId: event.snapshot.id,
      sourceGeneration: event.snapshot.memoryBranchGeneration,
      userId: event.snapshot.userId
    }
  });
  return id;
}

async function ensureWinnerSearchEntry(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  index: MemoryActiveIndex,
  fact: FactRow,
  version: VersionRow,
  triggerId: string
): Promise<void> {
  if (version.displayText === null || version.structuredValue === null) {
    throw new Error("memory_fact_source_normalization_content_missing");
  }
  const evidence = version.sourceMode === "AUTOMATIC"
    ? (await loadPersonalMemoryEvidenceSnapshots(
        tx,
        settings.userId,
        [version.id]
      )).map((item) => ({ ...item, sourceType: "MESSAGE" as const }))
    : await tx.memoryEvidence.findMany({
        orderBy: [{ observedAt: "asc" }, { id: "asc" }],
        select: {
          branchGeneration: true,
          chatId: true,
          id: true,
          messageId: true,
          safeSourceHash: true,
          sourceProjectionVersion: true,
          sourceType: true
        },
        where: {
          factVersionId: version.id,
          sourceType: "EXPLICIT_ACTION",
          stance: "SUPPORTS",
          userId: settings.userId
        }
      });
  if (evidence.length === 0) {
    throw new Error("memory_fact_source_normalization_support_missing");
  }
  const normalizedSearchText = normalizeMemorySearchText(version.displayText);
  if (!normalizedSearchText) throw new Error("memory_fact_source_normalization_content_missing");
  const existing = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, id: true },
    where: {
      factVersionId: version.id,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  const embeddingState = index.indexMode === "HYBRID"
    ? existing?.embeddingState === "READY" ? "READY" : "PENDING"
    : "NOT_APPLICABLE";
  const snapshots = {
    safeContentHash: memorySha256({
      displayText: version.displayText,
      structuredValue: version.structuredValue
    }),
    safetyIdentitySnapshot: memorySha256({
      safetyClass: version.sensitivityClass,
      secretTaintedSourceWindow: false
    }),
    sourceIdentitySnapshot: memorySha256({
      evidence: evidence.map((item) => ({
        branchGeneration: item.branchGeneration,
        chatId: item.chatId,
        evidenceId: item.id,
        messageId: item.messageId,
        safeSourceHash: item.safeSourceHash,
        sourceProjectionVersion: item.sourceProjectionVersion,
        sourceType: item.sourceType
      })),
      version: 1
    }),
    suppressionIdentitySnapshot: memorySha256({
      canonicalKey: fact.canonicalKey,
      category: version.category,
      normalizedValue: normalizedSearchText
    })
  };
  const entry = existing
    ? await tx.memorySearchEntry.update({
        data: {
          embeddingState,
          languageCode: version.languageCode,
          normalizedSearchText,
          ...snapshots
        },
        select: { id: true },
        where: { id: existing.id }
      })
    : await tx.memorySearchEntry.create({
        data: {
          embeddingState,
          factVersionId: version.id,
          indexGenerationId: index.id,
          itemType: "FACT_VERSION",
          languageCode: version.languageCode,
          normalizedSearchText,
          userId: settings.userId,
          ...snapshots
        },
        select: { id: true }
      });
  if (embeddingState === "PENDING") {
    await enqueueMemoryEmbeddingBatchItem(tx, settings, {
      entryId: entry.id,
      triggerIdentity: triggerId
    });
  }
}

async function normalizeFact(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  index: MemoryActiveIndex,
  event: MemoryRetainedSourceMutationEvent,
  fact: FactRow,
  versions: readonly VersionRow[],
  support: ReadonlyMap<string, SupportRow>,
  affectedVersionIds: ReadonlySet<string>,
  now: Date
): Promise<void> {
  const unsupported = versions.filter((version) =>
    version.sourceMode === "AUTOMATIC" &&
    !["FORGOTTEN", "RETRACTED"].includes(version.state) &&
    !support.has(version.id));
  for (const version of unsupported) {
    await sourceInvalidationEvent(
      tx,
      event,
      fact.id,
      version.id,
      "FACT_RETRACTED"
    );
    await tx.memoryFactVersion.updateMany({
      data: {
        state: "RETRACTED",
        systemTo: version.systemTo ?? transitionAt(now, version)
      },
      where: {
        id: version.id,
        sourceMode: "AUTOMATIC",
        state: version.state,
        userId: settings.userId
      }
    });
  }
  if (unsupported.length > 0) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId: { in: unsupported.map(({ id }) => id) },
        userId: settings.userId
      }
    });
  }

  const unresolved = versions.filter((version) =>
    version.state === "CONFLICTING" &&
    version.ingestionFingerprint === null &&
    support.has(version.id));
  if (fact.state === "CONFLICTED") {
    if (unresolved.length === 0) {
      await tx.memoryFact.updateMany({
        data: { currentVersionId: null, state: "RETRACTED" },
        where: {
          currentVersionId: null,
          id: fact.id,
          state: "CONFLICTED",
          userId: settings.userId
        }
      });
      return;
    }
    if (unresolved.length === 1) {
      const winner = unresolved[0]!;
      const triggerId = await sourceInvalidationEvent(
        tx,
        event,
        fact.id,
        winner.id,
        "POINTER_RESTORED"
      );
      const version = await tx.memoryFactVersion.updateMany({
        data: { state: "ACTIVE", systemTo: null },
        where: {
          factId: fact.id,
          id: winner.id,
          state: "CONFLICTING",
          userId: settings.userId
        }
      });
      const currentSupport = support.get(winner.id)!;
      const logical = await tx.memoryFact.updateMany({
        data: {
          category: winner.category,
          currentVersionId: winner.id,
          lastConfirmedAt: currentSupport.latestObservedAt,
          state: "ACTIVE"
        },
        where: {
          currentVersionId: null,
          id: fact.id,
          state: "CONFLICTED",
          userId: settings.userId
        }
      });
      if (version.count !== 1 || logical.count !== 1) {
        throw new Error("memory_fact_source_normalization_stale");
      }
      await ensureWinnerSearchEntry(tx, settings, index, fact, winner, triggerId);
      return;
    }
    return;
  }

  if (fact.state === "ACTIVE" && fact.currentVersionId) {
    const current = versions.find(({ id }) => id === fact.currentVersionId);
    if (!current) throw new Error("memory_fact_source_normalization_stale");
    if (current.sourceMode === "AUTOMATIC" && !support.has(current.id)) {
      const retracted = await tx.memoryFact.updateMany({
        data: { currentVersionId: null, state: "RETRACTED" },
        where: {
          currentVersionId: current.id,
          id: fact.id,
          state: "ACTIVE",
          userId: settings.userId
        }
      });
      if (retracted.count !== 1) {
        throw new Error("memory_fact_source_normalization_stale");
      }
      return;
    }
    if (!affectedVersionIds.has(current.id)) return;
    const currentSupport = support.get(current.id);
    if (!currentSupport) {
      throw new Error("memory_fact_source_normalization_support_missing");
    }
    const triggerId = await sourceInvalidationEvent(
      tx,
      event,
      fact.id,
      current.id,
      "EVIDENCE_REMOVED"
    );
    const logical = await tx.memoryFact.updateMany({
      data: { lastConfirmedAt: currentSupport.latestObservedAt },
      where: {
        currentVersionId: current.id,
        id: fact.id,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (logical.count !== 1) {
      throw new Error("memory_fact_source_normalization_stale");
    }
    await ensureWinnerSearchEntry(tx, settings, index, fact, current, triggerId);
  }
}

export async function normalizeMemoryFactsForSourceMutation(
  tx: MemoryTransaction,
  event: MemoryRetainedSourceMutationEvent,
  now = new Date()
): Promise<LockedMemorySettings | null> {
  const predicate = invalidationPredicate(event);
  if (!predicate) return null;
  const affected = await affectedEvidence(tx, event, predicate);
  if (affected.evidenceIds.length === 0) return null;
  const settings = await lockMemorySettings(tx, event.snapshot.userId, false);
  if (!parentAdvancedMemoryRevision(event)) {
    await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  }
  const index = await ensureActiveLexicalGeneration(
    tx,
    settings,
    settings.memoryRevision
  );
  const facts = await lockFacts(tx, settings.userId, affected.factIds);
  await tx.memoryEvidence.deleteMany({
    where: { id: { in: affected.evidenceIds }, userId: settings.userId }
  });
  await removeUnsupportedMemoryEntityLinks(
    tx,
    settings.userId,
    affected.versionIds
  );
  const state = await versionsAndSupport(
    tx,
    settings.userId,
    facts.map(({ id }) => id)
  );
  const affectedVersionIds = new Set(affected.versionIds);
  for (const fact of facts) {
    await normalizeFact(
      tx,
      settings,
      index,
      event,
      fact,
      state.versions.filter((version) => version.factId === fact.id),
      state.support,
      affectedVersionIds,
      now
    );
  }
  await tx.memoryIndexGeneration.update({
    data: { indexedThroughMemoryRevision: settings.memoryRevision },
    where: { id: index.id }
  });
  return settings;
}

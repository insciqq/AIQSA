import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemorySummary } from "../../../contracts/memory";
import { prisma } from "../../prisma";
import type { ExplicitMemoryService } from "../explicit/service";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import {
  memoryActiveSuppressionPredicate
} from "../retrieval/localRepository";
import { memoryExactVNextDirectAuthorityPredicate } from
  "../persistence/eligibility";
import type { MemoryRunUtilityService } from "../retrieval/runUtilities";
import {
  type MemoryVectorRepository
} from "../retrieval/vector";
import { normalizeMemorySearchText } from "../persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";

export const MEMORY_ACTION_TARGET_MAX_CANDIDATES = 5;

export type MemoryActionTarget = Readonly<{
  factId: string;
  statement: string;
  summary: MemorySummary;
  versionId: string;
}>;

export type MemoryActionTargetSearchResult =
  | Readonly<{ status: "READY"; targets: readonly MemoryActionTarget[] }>
  | Readonly<{ reason: string; status: "UNAVAILABLE" }>;

export type MemoryActionTargetSearchService = Readonly<{
  exact(input: Readonly<{
    query: string;
    userId: string;
  }>): Promise<MemoryActionTargetSearchResult>;
  semantic(input: Readonly<{
    attemptId: string;
    fallbackText?: string;
    query: string;
    signal: AbortSignal;
    userId: string;
  }>): Promise<MemoryActionTargetSearchResult>;
}>;

type TargetIdentity = Readonly<{ factId: string; versionId: string }>;

export type MemoryActionTargetRepository = Readonly<{
  byActiveGenerationVersionIds(
    userId: string,
    versionIds: readonly string[]
  ): Promise<readonly TargetIdentity[]>;
  exactActive(
    userId: string,
    normalizedStatement: string,
    limit: number
  ): Promise<readonly TargetIdentity[]>;
}>;

function activeTarget(summary: MemorySummary): MemoryActionTarget | null {
  return summary.scope.type === "GLOBAL_USER" && summary.factState === "ACTIVE" &&
    summary.currentVersionId && summary.displayText
    ? {
        factId: summary.id,
        statement: summary.displayText,
        summary,
        versionId: summary.currentVersionId
      }
    : null;
}

function eligibleSemanticTarget(summary: MemorySummary): MemoryActionTarget | null {
  if (summary.sensitivityClass !== "NORMAL" && summary.sensitivityClass !== "SENSITIVE") {
    return null;
  }
  return activeTarget(summary);
}

function eligibilityPredicates(userId: string): readonly Prisma.Sql[] {
  return [
    Prisma.sql`owner."status" = 'active'`,
    Prisma.sql`settings."useMemoryFacts" = TRUE`,
    Prisma.sql`scope."state" = 'ACTIVE'::"MemoryScopeState"`,
    memoryCanonicalGlobalScopePredicate(),
    Prisma.sql`fact."state" = 'ACTIVE'::"MemoryFactState"`,
    Prisma.sql`fact."currentVersionId" = version."id"`,
    Prisma.sql`version."state" = 'ACTIVE'::"MemoryFactVersionState"`,
    Prisma.sql`version."systemTo" IS NULL`,
    Prisma.sql`(version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)`,
    Prisma.sql`version."contentPurgedAt" IS NULL`,
    Prisma.sql`version."displayText" IS NOT NULL`,
    Prisma.sql`version."structuredValue" IS NOT NULL`,
    Prisma.sql`version."safetyClassificationState" =
      'CLASSIFIED'::"MemorySafetyClassificationState"`,
    Prisma.sql`version."sensitivityClass" IN (
      'NORMAL'::"MemorySensitivityClass",
      'SENSITIVE'::"MemorySensitivityClass"
    )`,
    memoryExactVNextDirectAuthorityPredicate(userId),
    memoryActiveSuppressionPredicate(userId)
  ];
}

export function createPrismaMemoryActionTargetRepository(
  client: PrismaClient = prisma
): MemoryActionTargetRepository {
  return Object.freeze({
    async byActiveGenerationVersionIds(userId, versionIds) {
      const bounded = [...new Set(versionIds)].slice(0, MEMORY_ACTION_TARGET_MAX_CANDIDATES);
      if (bounded.length === 0) return [];
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`,
        Prisma.sql`version."id" IN (${Prisma.join(bounded)})`,
        Prisma.sql`generation."id" = settings."activeIndexGenerationId"`,
        Prisma.sql`generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"`,
        Prisma.sql`search."indexGenerationId" = generation."id"`,
        Prisma.sql`search."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`,
        ...eligibilityPredicates(userId)
      ];
      const rows = await client.$queryRaw<TargetIdentity[]>(Prisma.sql`
        SELECT fact."id" AS "factId", version."id" AS "versionId"
        FROM "MemoryFact" AS fact
        INNER JOIN "User" AS owner ON owner."id" = fact."userId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId" AND version."factId" = fact."id"
        INNER JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
        INNER JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = settings."userId"
        INNER JOIN "MemorySearchEntry" AS search
          ON search."userId" = version."userId" AND search."factVersionId" = version."id"
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY fact."updatedAt" DESC, fact."id", version."id"
        LIMIT ${MEMORY_ACTION_TARGET_MAX_CANDIDATES}
      `);
      const byVersion = new Map(rows.map((row) => [row.versionId, row]));
      return bounded.flatMap((versionId) => {
        const row = byVersion.get(versionId);
        return row ? [row] : [];
      });
    },

    async exactActive(userId, normalizedStatement, limit) {
      const boundedLimit = Math.min(
        Math.max(1, limit),
        MEMORY_ACTION_TARGET_MAX_CANDIDATES
      );
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`,
        Prisma.sql`version."normalizedSearchText" = ${normalizedStatement}`,
        ...eligibilityPredicates(userId)
      ];
      return client.$queryRaw<TargetIdentity[]>(Prisma.sql`
        SELECT fact."id" AS "factId", version."id" AS "versionId"
        FROM "MemoryFact" AS fact
        INNER JOIN "User" AS owner ON owner."id" = fact."userId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId" AND version."factId" = fact."id"
        INNER JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY fact."updatedAt" DESC, fact."id", version."id"
        LIMIT ${boundedLimit}
      `);
    }
  });
}

async function loadTargets(
  service: ExplicitMemoryService,
  userId: string,
  identities: readonly TargetIdentity[]
): Promise<readonly MemoryActionTarget[]> {
  const details = await Promise.all(identities.map(async (identity) => {
    const detail = await service.get(userId, identity.factId).catch(() => null);
    const target = detail ? activeTarget(detail.memory) : null;
    return target?.versionId === identity.versionId ? target : null;
  }));
  return details.flatMap((target) => target ? [target] : []);
}

function fusedTargets(
  lexical: readonly MemoryActionTarget[],
  vector: readonly Readonly<{ score: number; target: MemoryActionTarget }>[]
): readonly MemoryActionTarget[] {
  const scores = new Map<string, Readonly<{ score: number; target: MemoryActionTarget }>>();
  lexical.forEach((target, index) => {
    scores.set(target.factId, { score: 1 / (60 + index + 1), target });
  });
  vector.forEach(({ score, target }, index) => {
    const existing = scores.get(target.factId);
    const fused = score + 1 / (60 + index + 1) + (existing?.score ?? 0);
    scores.set(target.factId, { score: fused, target });
  });
  return [...scores.values()]
    .sort((left, right) => right.score - left.score ||
      left.target.factId.localeCompare(right.target.factId))
    .slice(0, MEMORY_ACTION_TARGET_MAX_CANDIDATES)
    .map(({ target }) => target);
}

function semanticTokens(value: string): ReadonlySet<string> {
  return new Set(normalizeMemorySearchText(value)
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => [...token].length >= 3));
}

function localFallbackTargets(
  memories: readonly MemorySummary[],
  fallbackText: string | undefined
): readonly MemoryActionTarget[] {
  if (!fallbackText || memoryExplicitStatementContainsSecret(fallbackText)) return [];
  const requested = semanticTokens(fallbackText);
  if (requested.size === 0) return [];
  const scored = memories.flatMap((summary) => {
    const target = eligibleSemanticTarget(summary);
    if (!target) return [];
    const shared = [...semanticTokens(target.statement)].filter((token) =>
      requested.has(token));
    const strong = shared.length >= 2 || shared.some((token) => [...token].length >= 8);
    return strong ? [{ score: shared.length, target }] : [];
  }).sort((left, right) => right.score - left.score ||
    left.target.factId.localeCompare(right.target.factId));
  const strongest = scored[0]?.score;
  return strongest === undefined
    ? []
    : scored.filter(({ score }) => score === strongest)
      .slice(0, MEMORY_ACTION_TARGET_MAX_CANDIDATES)
      .map(({ target }) => target);
}

function mergeTargetCandidates(
  primary: readonly MemoryActionTarget[],
  supplemental: readonly MemoryActionTarget[]
): readonly MemoryActionTarget[] {
  const supplementalKeys = new Set(supplemental.map((target) =>
    `${target.factId}:${target.versionId}`));
  const merged = new Map<string, MemoryActionTarget>();
  // The current user turn is direct targeting evidence. Preserve the semantic
  // lane's ordering for candidates that also have the strongest local overlap,
  // then admit the remaining strongest local ties before generic semantic hits.
  // This only shapes the bounded candidate set; the strict selector still owns
  // target choice and may return AMBIGUOUS instead of guessing.
  for (const target of [
    ...primary.filter((candidate) => supplementalKeys.has(
      `${candidate.factId}:${candidate.versionId}`
    )),
    ...supplemental,
    ...primary
  ]) {
    const key = `${target.factId}:${target.versionId}`;
    if (!merged.has(key)) merged.set(key, target);
  }
  return [...merged.values()].slice(0, MEMORY_ACTION_TARGET_MAX_CANDIDATES);
}

export function createMemoryActionTargetSearchService(input: Readonly<{
  explicitService: ExplicitMemoryService;
  repository: MemoryActionTargetRepository;
  utilities: MemoryRunUtilityService;
  vectorRepository: MemoryVectorRepository;
}>): MemoryActionTargetSearchService {
  return Object.freeze({
    async exact(request) {
      const normalized = normalizeMemorySearchText(request.query);
      if (!normalized || memoryExplicitStatementContainsSecret(request.query)) {
        return { reason: "memory_action_target_input_blocked", status: "UNAVAILABLE" };
      }
      try {
        const identities = await input.repository.exactActive(
          request.userId,
          normalized,
          MEMORY_ACTION_TARGET_MAX_CANDIDATES
        );
        return {
          status: "READY",
          targets: await loadTargets(input.explicitService, request.userId, identities)
        };
      } catch {
        return { reason: "memory_action_exact_target_unavailable", status: "UNAVAILABLE" };
      }
    },

    async semantic(request) {
      const normalized = normalizeMemorySearchText(request.query);
      if (!normalized || memoryExplicitStatementContainsSecret(request.query)) {
        return { reason: "memory_action_target_input_blocked", status: "UNAVAILABLE" };
      }
      try {
        const resolved = await input.vectorRepository.resolveActiveProfile(request.userId);
        if (resolved.status !== "READY") {
          return { reason: resolved.reason, status: "UNAVAILABLE" };
        }
        const embedded = await input.utilities.embedQuery({
          attemptId: request.attemptId,
          profile: resolved.profile,
          purpose: "ACTION_TARGET",
          query: normalized,
          signal: request.signal,
          userId: request.userId
        });
        if (embedded.status !== "READY") {
          return { reason: embedded.reason, status: "UNAVAILABLE" };
        }
        const [vectorResult, lexicalResult] = await Promise.all([
          input.vectorRepository.search({
            eligibility: {
              allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
              allowedHistorySafety: ["NORMAL"],
              assistantId: null,
              chatId: null,
              factMode: "CURRENT",
              factTemporalAsOf: null,
              folderId: null,
              includePatterns: false,
              occurredFrom: null,
              occurredTo: null,
              sourceAssistantId: null,
              sourceChatIds: null,
              sourceFolderId: null
            },
            itemTypes: ["FACT_VERSION"],
            limit: MEMORY_ACTION_TARGET_MAX_CANDIDATES,
            minimumScore: resolved.profile.minimumSimilarity,
            profile: embedded.profile,
            userId: request.userId,
            vector: embedded.vector
          }),
          input.explicitService.search(request.userId, {
            pageSize: MEMORY_ACTION_TARGET_MAX_CANDIDATES,
            query: normalized,
            scope: { type: "GLOBAL_USER" },
            state: "ACTIVE"
          })
        ]);
        if (vectorResult.status !== "READY") {
          return { reason: vectorResult.reason, status: "UNAVAILABLE" };
        }
        const vectorHits = vectorResult.hits.filter((hit) =>
          hit.itemType === "FACT_VERSION" && hit.score > resolved.profile.minimumSimilarity
        );
        const identities = await input.repository.byActiveGenerationVersionIds(
          request.userId,
          vectorHits.map((hit) => hit.itemId)
        );
        const vectorTargets = await loadTargets(
          input.explicitService,
          request.userId,
          identities
        );
        const targetByVersion = new Map(vectorTargets.map((target) =>
          [target.versionId, target]));
        const hitByVersion = new Map(vectorHits.map((hit) => [hit.itemId, hit]));
        const scoredVectorTargets = identities.flatMap((identity) => {
          const target = targetByVersion.get(identity.versionId);
          const hit = hitByVersion.get(identity.versionId);
          return target && hit ? [{ score: hit.score, target }] : [];
        });
        const lexicalTargets = lexicalResult.memories.flatMap((summary) => {
          const target = eligibleSemanticTarget(summary);
          return target ? [target] : [];
        });
        const fused = fusedTargets(lexicalTargets, scoredVectorTargets);
        if (!request.fallbackText) {
          return { status: "READY", targets: fused };
        }
        const fallback = await input.explicitService.list(request.userId, {
          pageSize: 20,
          scope: { type: "GLOBAL_USER" },
          state: "ACTIVE"
        });
        return {
          status: "READY",
          // Semantic retrieval can have several hits and still omit a direct
          // distinctive term that the control model summarized out of
          // targetQuery. Keep every strongest direct-text tie so the strict
          // selector can ask for a choice instead of silently applying a
          // destructive mutation to an incomplete candidate set.
          targets: mergeTargetCandidates(
            fused,
            localFallbackTargets(fallback.memories, request.fallbackText)
          )
        };
      } catch {
        return { reason: "memory_action_semantic_target_unavailable", status: "UNAVAILABLE" };
      }
    }
  });
}

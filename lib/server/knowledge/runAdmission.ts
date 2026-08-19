import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import {
  createPrismaEmbeddingRuntime,
  type EmbeddingRuntimeStore
} from "../providerRuntime/embeddingRuntime";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { prisma } from "../prisma";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  knowledgeBudgetPolicyFromProfileConfiguration,
  type KnowledgeBudgetPolicy
} from "./knowledgeBudget";
import {
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SCOPE_MAX_SOURCES
} from "./retrievalTypes";

export type KnowledgeRunAdmissionExclusion = Readonly<{
  count: number;
  reason: "binding_budget" | "not_ready" | "unattached";
  resourceType: "base" | "source";
}>;

export type KnowledgeRunAdmissionBinding = Readonly<{
  approxTokens?: number | null;
  baseContentRevision: number;
  embeddingCredentialSource: "default" | "group" | "user";
  embeddingExecutionSnapshot: ProviderExecutionSnapshot;
  embeddingProviderModelId: string;
  indexedContentRevision: number;
  indexGenerationId: string;
  includeWholeBase: boolean;
  knowledgeBaseId: string;
  ordinal: number;
  passageCount?: number | null;
  readySourceCount?: number;
  selectedSourceIds: readonly string[];
  sourceCount?: number;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeRunAdmissionPlan = Readonly<{
  bindings: readonly KnowledgeRunAdmissionBinding[];
  budgetPolicy: KnowledgeBudgetPolicy;
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
  fingerprint: string;
  knowledgePlan: KnowledgePlan;
  resolvedSourceCount: number;
  executionScope?: "project";
  projectId?: string;
  userId: string;
}>;

export class KnowledgeRunAdmissionError extends Error {
  readonly code = "knowledge_base_not_available" as const;

  constructor() {
    super("knowledge_base_not_available");
    this.name = "KnowledgeRunAdmissionError";
  }
}

export type KnowledgeRunAdmissionStore = EmbeddingRuntimeStore & Pick<
  PrismaClient,
  "knowledgeBase" | "knowledgeSource" | "userGroup"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: Omit<KnowledgeRunAdmissionPlan, "fingerprint">): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function admittedSourceSummary(base: Readonly<{
  activeIndexGeneration: Readonly<{ profileRevisionId?: string | null }> | null;
  sourceMemberships?: readonly Readonly<{
    sourceId: string;
    source: Readonly<{
      currentVersion: Readonly<{
        artifacts: readonly Readonly<{
          hierarchicalIndexes: readonly Readonly<{
            passageCount: number;
            state: string;
          }>[];
          normalizedTextByteSize: number | null;
          profileRevisionId: string;
          state: string;
        }>[];
        byteSize: number;
      }> | null;
    }>;
  }>[];
}>, selectedSourceIds: readonly string[] | null): Readonly<{
  approxTokens: number | null;
  passageCount: number | null;
  readySourceCount: number;
  sourceCount: number;
}> {
  const selected = selectedSourceIds ? new Set(selectedSourceIds) : null;
  const memberships = (base.sourceMemberships ?? []).filter((membership) =>
    !selected || selected.has(membership.sourceId));
  const profileRevisionId = base.activeIndexGeneration?.profileRevisionId;
  let readySourceCount = 0;
  let passageCount = 0;
  let normalizedBytes = 0;
  let complete = Boolean(profileRevisionId) && memberships.length > 0;
  for (const membership of memberships) {
    const version = membership.source.currentVersion;
    const artifact = version?.artifacts.find((candidate) =>
      candidate.profileRevisionId === profileRevisionId && candidate.state === "ready");
    const hierarchy = artifact?.hierarchicalIndexes.find((candidate) => candidate.state === "ready");
    if (!version || !artifact || !hierarchy ||
      !Number.isSafeInteger(hierarchy.passageCount) || hierarchy.passageCount < 1) {
      complete = false;
      continue;
    }
    readySourceCount += 1;
    passageCount += hierarchy.passageCount;
    normalizedBytes += artifact.normalizedTextByteSize ?? version.byteSize;
  }
  return {
    approxTokens: complete && readySourceCount === memberships.length
      ? Math.max(1, Math.ceil(normalizedBytes / 4))
      : null,
    passageCount: complete && readySourceCount === memberships.length ? passageCount : null,
    readySourceCount,
    sourceCount: memberships.length
  };
}

type ResolvedScope = Readonly<{
  knowledgeBaseId: string;
  selectedSourceIds: readonly string[] | null;
}>;

function incrementExclusion(
  exclusions: Map<string, KnowledgeRunAdmissionExclusion>,
  resourceType: KnowledgeRunAdmissionExclusion["resourceType"],
  reason: KnowledgeRunAdmissionExclusion["reason"],
  count = 1
): void {
  if (count < 1) return;
  const key = `${resourceType}:${reason}`;
  const existing = exclusions.get(key);
  exclusions.set(key, {
    count: (existing?.count ?? 0) + count,
    reason,
    resourceType
  });
}

function baseVisibilityWhere(input: Readonly<{
  groupIds: readonly string[];
  projectId?: string;
  userId: string;
}>): Prisma.KnowledgeBaseWhereInput {
  const lifecycle = {
    archivedAt: null,
    deletionRequestedAt: null,
    trashedAt: null
  } satisfies Prisma.KnowledgeBaseWhereInput;
  if (input.projectId) {
    return {
      ...lifecycle,
      projectBindings: { some: { projectId: input.projectId } }
    };
  }
  return {
    ...lifecycle,
    OR: [
      { ownerUserId: input.userId },
      {
        publications: {
          some: {
            OR: [
              { scope: "installation" },
              ...(input.groupIds.length > 0
                ? [{ groupId: { in: [...input.groupIds] }, scope: "group" as const }]
                : [])
            ]
          }
        }
      }
    ]
  };
}

async function resolveSelectionScopes(
  client: KnowledgeRunAdmissionStore,
  input: Readonly<{
    groupIds: readonly string[];
    knowledgePlan: KnowledgePlan;
    projectId?: string;
    userId: string;
  }>
): Promise<Readonly<{
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
  scopes: readonly ResolvedScope[];
}>> {
  const exclusions = new Map<string, KnowledgeRunAdmissionExclusion>();
  const scopes = new Map<string, Set<string> | null>();
  const addWholeBase = (knowledgeBaseId: string) => scopes.set(knowledgeBaseId, null);
  const addSource = (knowledgeBaseId: string, sourceId: string) => {
    if (scopes.get(knowledgeBaseId) === null) return;
    const selected = scopes.get(knowledgeBaseId) ?? new Set<string>();
    selected.add(sourceId);
    scopes.set(knowledgeBaseId, selected);
  };
  const plan = input.knowledgePlan;
  const visibility = baseVisibilityWhere(input);

  if (plan.mode === "none") return { exclusions: [], scopes: [] };
  if (plan.mode === "inherited") {
    if (plan.inheritedFrom !== "project" || !input.projectId) {
      throw new KnowledgeRunAdmissionError();
    }
    const bases = await client.knowledgeBase.findMany({
      orderBy: { id: "asc" },
      select: { activeIndexGeneration: { select: { status: true } }, id: true },
      where: visibility
    });
    for (const base of bases) {
      if (base.activeIndexGeneration?.status === "active") addWholeBase(base.id);
      else incrementExclusion(exclusions, "base", "not_ready");
    }
  } else if (plan.baseIds.length > 0) {
    const bases = await client.knowledgeBase.findMany({
      orderBy: { id: "asc" },
      select: { activeIndexGeneration: { select: { status: true } }, id: true },
      where: { ...visibility, id: { in: [...plan.baseIds] } }
    });
    if (bases.length !== plan.baseIds.length) throw new KnowledgeRunAdmissionError();
    const byId = new Map(bases.map((base) => [base.id, base]));
    for (const baseId of plan.baseIds) {
      const base = byId.get(baseId)!;
      if (base.activeIndexGeneration?.status === "active") addWholeBase(base.id);
      else incrementExclusion(exclusions, "base", "not_ready");
    }
  }

  const requestedSourceIds = plan.mode === "all_my_knowledge" ? null : plan.sourceIds;
  if (plan.mode === "all_my_knowledge" && input.projectId) {
    throw new KnowledgeRunAdmissionError();
  }
  if (requestedSourceIds === null || requestedSourceIds.length > 0) {
    const sourceWhere: Prisma.KnowledgeSourceWhereInput = {
      deletionRequestedAt: null,
      ...(requestedSourceIds === null
        ? { ownerUserId: input.userId }
        : { id: { in: [...requestedSourceIds] } }),
      ...(requestedSourceIds === null
        ? {}
        : {
            OR: [
              { ownerUserId: input.userId },
              { baseMemberships: { some: { knowledgeBase: visibility, removedAt: null } } }
            ]
          }),
      trashedAt: null
    };
    const sources = await client.knowledgeSource.findMany({
      orderBy: { id: "asc" },
      select: {
        baseMemberships: {
          orderBy: { knowledgeBaseId: "asc" },
          select: {
            knowledgeBase: {
              select: {
                activeIndexGeneration: {
                  select: { profileRevisionId: true, status: true }
                },
                id: true
              }
            }
          },
          where: { knowledgeBase: visibility, removedAt: null }
        },
        currentVersion: {
          select: {
            artifacts: {
              select: {
                hierarchicalIndexes: {
                  orderBy: { schemaVersion: "desc" },
                  select: { state: true },
                  take: 1
                },
                profileRevisionId: true,
                state: true
              }
            }
          }
        },
        id: true
      },
      ...(requestedSourceIds === null ? { take: KNOWLEDGE_SCOPE_MAX_SOURCES + 1 } : {}),
      where: sourceWhere
    });
    const sourceCount = requestedSourceIds === null
      ? await client.knowledgeSource.count({ where: sourceWhere })
      : sources.length;
    if (requestedSourceIds !== null && sources.length !== requestedSourceIds.length) {
      throw new KnowledgeRunAdmissionError();
    }
    const admittedSources = requestedSourceIds === null
      ? sources.slice(0, KNOWLEDGE_SCOPE_MAX_SOURCES)
      : sources;
    if (sourceCount > admittedSources.length) {
      incrementExclusion(
        exclusions,
        "source",
        "binding_budget",
        sourceCount - admittedSources.length
      );
    }
    for (const source of admittedSources) {
      const eligible = source.baseMemberships.find(({ knowledgeBase }) => {
        const generation = knowledgeBase.activeIndexGeneration;
        return generation?.status === "active" && Boolean(generation.profileRevisionId) &&
          source.currentVersion?.artifacts.some((artifact) =>
            artifact.profileRevisionId === generation.profileRevisionId &&
            artifact.state === "ready" &&
            artifact.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
      });
      if (!eligible) {
        incrementExclusion(
          exclusions,
          "source",
          source.baseMemberships.length > 0 ? "not_ready" : "unattached"
        );
        continue;
      }
      addSource(eligible.knowledgeBase.id, source.id);
    }
  }

  const ordered = [...scopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const admitted = ordered.slice(0, KNOWLEDGE_SCOPE_MAX_BINDINGS);
  if (ordered.length > admitted.length) {
    incrementExclusion(exclusions, "base", "binding_budget", ordered.length - admitted.length);
  }
  return {
    exclusions: [...exclusions.values()].sort((left, right) =>
      `${left.resourceType}:${left.reason}`.localeCompare(`${right.resourceType}:${right.reason}`)),
    scopes: admitted.map(([knowledgeBaseId, selected]) => ({
      knowledgeBaseId,
      selectedSourceIds: selected === null ? null : [...selected].sort()
    }))
  };
}

export async function loadKnowledgeRunAdmissionPlan(
  client: KnowledgeRunAdmissionStore,
  input: Readonly<{ executionScope?: "project"; knowledgePlan: KnowledgePlan; projectId?: string; userId: string }>
): Promise<KnowledgeRunAdmissionPlan> {
  const decodedKnowledgePlan = decodeKnowledgePlan(input.knowledgePlan);
  if (!decodedKnowledgePlan.ok) throw new KnowledgeRunAdmissionError();
  const knowledgePlan = decodedKnowledgePlan.plan;
  const user = await client.user.findFirst({
    select: { id: true },
    where: { id: input.userId, status: "active" }
  });
  if (!user) throw new KnowledgeRunAdmissionError();
  const projectScope = input.executionScope === "project";
  if (projectScope && !input.projectId) throw new KnowledgeRunAdmissionError();
  const groups = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId: input.userId }
  });
  const groupIds = groups.map(({ groupId }) => groupId);
  const resolved = await resolveSelectionScopes(client, {
    groupIds,
    knowledgePlan,
    ...(projectScope ? { projectId: input.projectId } : {}),
    userId: input.userId
  });
  const embeddingRuntime = createPrismaEmbeddingRuntime(client);
  const bindings: KnowledgeRunAdmissionBinding[] = [];
  let budgetPolicy: KnowledgeBudgetPolicy | null = null;

  for (const [ordinal, scope] of resolved.scopes.entries()) {
    const knowledgeBaseId = scope.knowledgeBaseId;
    const base = await client.knowledgeBase.findFirst({
      select: {
        activeIndexGeneration: {
          select: {
            embeddingConfiguration: true,
            embeddingProviderModelId: true,
            id: true,
            indexedContentRevision: true,
            profileRevisionId: true,
            profileRevision: {
              select: { executionAuthority: true, profileConfiguration: true }
            },
            status: true,
            targetDimension: true,
            vectorSpaceFingerprint: true
          }
        },
        contentRevision: true,
        id: true,
        sourceMemberships: {
          select: {
            sourceId: true,
            source: {
              select: {
                currentVersion: {
                  select: {
                    artifacts: {
                      orderBy: { createdAt: "desc" },
                      select: {
                        hierarchicalIndexes: {
                          orderBy: { schemaVersion: "desc" },
                          select: { passageCount: true, state: true },
                          take: 1
                        },
                        normalizedTextByteSize: true,
                        profileRevisionId: true,
                        state: true
                      }
                    },
                    byteSize: true
                  }
                }
              }
            }
          },
          where: {
            removedAt: null,
            ...(scope.selectedSourceIds
              ? { sourceId: { in: [...scope.selectedSourceIds] } }
              : {}),
            source: { deletionRequestedAt: null, trashedAt: null }
          }
        }
      },
      where: {
        archivedAt: null,
        deletionRequestedAt: null,
        id: knowledgeBaseId,
        trashedAt: null,
        ...(projectScope
          ? { projectBindings: { some: { projectId: input.projectId } } }
          : {
              OR: [
                { ownerUserId: input.userId },
                {
                  publications: {
                    some: {
                      OR: [
                        { scope: "installation" },
                        ...(groupIds.length > 0
                          ? [{ groupId: { in: groupIds }, scope: "group" as const }]
                          : [])
                      ]
                    }
                  }
                }
              ]
            })
      }
    });
    const generation = base?.activeIndexGeneration;
    if (!base || !generation || generation.status !== "active") {
      throw new KnowledgeRunAdmissionError();
    }

    try {
      const resolvedBudgetPolicy = knowledgeBudgetPolicyFromProfileConfiguration(
        generation.profileRevision?.profileConfiguration
      );
      if (budgetPolicy && canonicalJson(budgetPolicy) !== canonicalJson(resolvedBudgetPolicy)) {
        throw new KnowledgeRunAdmissionError();
      }
      budgetPolicy = resolvedBudgetPolicy;
      const embedding = projectScope
        ? await embeddingRuntime.resolveForProject({ providerModelId: generation.embeddingProviderModelId })
        : generation.profileRevision?.executionAuthority === "installation"
          ? await embeddingRuntime.resolveForInstallation({
              providerModelId: generation.embeddingProviderModelId
            })
          : await embeddingRuntime.resolveForUser({
              providerModelId: generation.embeddingProviderModelId,
              userId: input.userId
            });
      const currentPin = createKnowledgeVectorSpacePin({
        configuration: embedding.configuration,
        deploymentId: generation.embeddingProviderModelId
      });
      const storedFingerprint = generation.vectorSpaceFingerprint.trim();
      if (
        !currentPin?.indexSupported ||
        currentPin.fingerprint !== storedFingerprint ||
        currentPin.targetDimension !== generation.targetDimension ||
        canonicalJson(currentPin.configuration) !== canonicalJson(generation.embeddingConfiguration)
      ) {
        throw new KnowledgeRunAdmissionError();
      }
      const sourceSummary = admittedSourceSummary(base, scope.selectedSourceIds);
      bindings.push({
        ...sourceSummary,
        baseContentRevision: base.contentRevision,
        embeddingCredentialSource: embedding.credentialSource,
        embeddingExecutionSnapshot: embedding.executionSnapshot,
        embeddingProviderModelId: generation.embeddingProviderModelId,
        indexedContentRevision: generation.indexedContentRevision,
        indexGenerationId: generation.id,
        includeWholeBase: scope.selectedSourceIds === null,
        knowledgeBaseId: base.id,
        ordinal,
        selectedSourceIds: scope.selectedSourceIds ?? [],
        targetDimension: generation.targetDimension,
        vectorSpaceFingerprint: storedFingerprint
      });
    } catch (error) {
      if (
        error instanceof KnowledgeRunAdmissionError ||
        error instanceof ProviderAdmissionError
      ) {
        throw new KnowledgeRunAdmissionError();
      }
      throw error;
    }
  }

  const accepted = {
    bindings,
    budgetPolicy: budgetPolicy ?? knowledgeBudgetPolicyFromProfileConfiguration(null),
    exclusions: resolved.exclusions,
    knowledgePlan,
    resolvedSourceCount: bindings.reduce((total, binding) => total + (binding.sourceCount ?? 0), 0),
    ...(projectScope ? { executionScope: "project" as const, projectId: input.projectId } : {}),
    userId: input.userId
  } satisfies Omit<KnowledgeRunAdmissionPlan, "fingerprint">;
  return { ...accepted, fingerprint: fingerprint(accepted) };
}

export function sameKnowledgeRunAdmissionPlan(
  left: KnowledgeRunAdmissionPlan,
  right: KnowledgeRunAdmissionPlan
): boolean {
  return left.fingerprint === right.fingerprint && canonicalJson(left) === canonicalJson(right);
}

/** Reauthorization may observe newly admitted resources for constant-size modes
 * such as All my knowledge. Those additions must not invalidate the run, and
 * the executor still reads only its persisted bindings. Every originally
 * admitted binding must, however, remain present with the same immutable index
 * generation and at least the same Source authority. */
export function knowledgeRunAdmissionStillAuthorizes(
  current: KnowledgeRunAdmissionPlan,
  expected: Readonly<{
    bindings: readonly Pick<KnowledgeRunAdmissionBinding,
      "includeWholeBase" | "indexGenerationId" | "knowledgeBaseId" |
      "selectedSourceIds" | "vectorSpaceFingerprint">[];
    knowledgePlan: KnowledgePlan;
  }>
): boolean {
  if (canonicalJson(current.knowledgePlan) !== canonicalJson(expected.knowledgePlan)) return false;
  return expected.bindings.every((accepted) => {
    const candidate = current.bindings.find((binding) =>
      binding.knowledgeBaseId === accepted.knowledgeBaseId);
    if (!candidate || candidate.indexGenerationId !== accepted.indexGenerationId ||
      candidate.vectorSpaceFingerprint !== accepted.vectorSpaceFingerprint) return false;
    if (accepted.includeWholeBase) return candidate.includeWholeBase;
    return candidate.includeWholeBase || accepted.selectedSourceIds.every((sourceId) =>
      candidate.selectedSourceIds.includes(sourceId));
  });
}

export function createKnowledgeRunAdmissionService(
  client: KnowledgeRunAdmissionStore = prisma
) {
  return {
    load(input: Readonly<{ executionScope?: "project"; knowledgePlan: KnowledgePlan; projectId?: string; userId: string }>) {
      return loadKnowledgeRunAdmissionPlan(client, input);
    }
  };
}

export const knowledgeRunAdmissionService = createKnowledgeRunAdmissionService();

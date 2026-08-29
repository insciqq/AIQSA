import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import {
  createPrismaEmbeddingRuntime,
  type EmbeddingRuntimeStore
} from "../providerRuntime/embeddingRuntime";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import { prisma } from "../prisma";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  knowledgeBudgetPolicyFromProfileConfiguration,
  type KnowledgeBudgetPolicy
} from "./knowledgeBudget";
import {
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SCOPE_MAX_SOURCES,
  KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED,
  KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER,
  type KnowledgeSourceBindingStrategy
} from "./retrievalTypes";
import { KNOWLEDGE_INDEX_PROFILE_ID } from "./knowledgeProfile";
import {
  DEFAULT_KNOWLEDGE_ANSWER_POLICY,
  knowledgeAnswerPolicySnapshot,
  type KnowledgeAnswerPolicySnapshot
} from "./answerPolicy";
import type { KnowledgeAnsweringPlan } from "./fullContext";

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

export type KnowledgeRunAdmissionProfile = Readonly<{
  embeddingCredentialSource: "default" | "group" | "user";
  embeddingExecutionSnapshot: ProviderExecutionSnapshot;
  embeddingProviderModelId: string;
  ordinal: number;
  profileRevisionId: string;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeRunAdmissionSource = Readonly<{
  approxTokens: number;
  authority: Readonly<{
    knowledgeBaseIds: readonly string[];
    owner: boolean;
    projectId: string | null;
  }>;
  baseProvenance: readonly Readonly<{
    indexGenerationId: string;
    knowledgeBaseId: string;
  }>[];
  directSelected: boolean;
  ordinal: number;
  privateLabels: Readonly<{
    fileName: string;
    sourceName: string;
  }>;
  passageCount: number;
  profileOrdinal: number;
  profileRevisionId: string;
  selectionProvenance: readonly ("all_my_knowledge" | "base" | "explicit_source")[];
  sourceAlias: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
}>;

export type KnowledgeRunAdmissionSourceAuthorization = Pick<
  KnowledgeRunAdmissionSource,
  | "authority"
  | "baseProvenance"
  | "directSelected"
  | "profileRevisionId"
  | "selectionProvenance"
  | "sourceArtifactId"
  | "sourceId"
  | "sourceVersionId"
>;

export type KnowledgeRunAdmissionAuthorizationSnapshot = Readonly<{
  bindings: readonly Pick<KnowledgeRunAdmissionBinding,
    "includeWholeBase" | "indexGenerationId" | "knowledgeBaseId" |
    "selectedSourceIds" | "vectorSpaceFingerprint">[];
  knowledgePlan: KnowledgePlan;
  profiles: readonly KnowledgeRunAdmissionProfile[];
  resolvedSourceCount?: number;
  sourceBindingStrategy?: KnowledgeSourceBindingStrategy;
  sources: readonly KnowledgeRunAdmissionSourceAuthorization[];
}>;

export type KnowledgeRunAdmissionPlan = Readonly<{
  answerPolicy?: KnowledgeAnswerPolicySnapshot;
  /** Preparation-only materialization. It is excluded from the admission
   * fingerprint and is persisted through dedicated scope/evidence rows. */
  answeringPlan?: KnowledgeAnsweringPlan;
  bindings: readonly KnowledgeRunAdmissionBinding[];
  budgetPolicy: KnowledgeBudgetPolicy;
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
  fingerprint: string;
  knowledgePlan: KnowledgePlan;
  /** Optional only for source compatibility with pre-H2 synthetic plans. New
   * admission always materializes both canonical arrays. */
  profiles?: readonly KnowledgeRunAdmissionProfile[];
  resolvedSourceCount: number;
  sources?: readonly KnowledgeRunAdmissionSource[];
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

/** New H2 admission always exposes canonical Sources. The binding fallback is
 * retained only for pre-H2 synthetic callers and historical tests. */
export function knowledgeRunAdmissionHasReadySources(
  plan: KnowledgeRunAdmissionPlan | null | undefined
): boolean {
  if (!plan) return false;
  return plan.sources === undefined ? plan.bindings.length > 0 : plan.sources.length > 0;
}

type ProjectKnowledgeSourceBindingStore = Partial<Pick<
  PrismaClient,
  "projectKnowledgeSourceBinding"
>>;

export type KnowledgeRunAdmissionStore = EmbeddingRuntimeStore & Pick<
  PrismaClient,
  "knowledgeBase" | "knowledgeIndexProfile" | "knowledgeSource" | "userGroup"
> & ProjectKnowledgeSourceBindingStore & Partial<Pick<PrismaClient, "knowledgeAnswerPolicy">>;

export type KnowledgeRunSnapshotAuthorizationStore = Pick<
  PrismaClient,
  "knowledgeBase" | "knowledgeSource" | "project" | "user"
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

type DirectProfileRevision = Readonly<{
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  executionAuthority: "installation" | "legacy_user";
  id: string;
  profileConfiguration: Prisma.JsonValue;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type ResolvedDirectSource = Readonly<{
  approxTokens: number;
  artifactId: string;
  fileName: string;
  ownerUserId: string;
  passageCount: number;
  profileRevisionId: string;
  provenance: "all_my_knowledge" | "explicit_source";
  sourceId: string;
  sourceName: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
}>;

function readyArtifactSummary(input: Readonly<{
  artifact: Readonly<{
    hierarchicalIndexes: readonly Readonly<{ passageCount: number; state: string }>[];
    normalizedTextByteSize: number | null;
  }>;
  versionByteSize: number;
}>): Readonly<{ approxTokens: number; passageCount: number }> | null {
  const hierarchy = input.artifact.hierarchicalIndexes.find((candidate) =>
    candidate.state === "ready");
  const normalizedBytes = input.artifact.normalizedTextByteSize ?? input.versionByteSize;
  if (!hierarchy || !Number.isSafeInteger(hierarchy.passageCount) || hierarchy.passageCount < 1 ||
    !Number.isSafeInteger(normalizedBytes) || normalizedBytes < 0) return null;
  return {
    approxTokens: Math.max(1, Math.ceil(normalizedBytes / 4)),
    passageCount: hierarchy.passageCount
  };
}

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
  baseAuthorizedSourceIds: readonly string[];
  directProfile: DirectProfileRevision | null;
  directSources: readonly ResolvedDirectSource[];
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
  scopes: readonly ResolvedScope[];
}>> {
  const exclusions = new Map<string, KnowledgeRunAdmissionExclusion>();
  const scopes = new Map<string, Set<string> | null>();
  const baseAuthorizedSourceIds = new Set<string>();
  const directSources: ResolvedDirectSource[] = [];
  const addWholeBase = (knowledgeBaseId: string) => scopes.set(knowledgeBaseId, null);
  const addSource = (knowledgeBaseId: string, sourceId: string) => {
    if (scopes.get(knowledgeBaseId) === null) return;
    const selected = scopes.get(knowledgeBaseId) ?? new Set<string>();
    selected.add(sourceId);
    scopes.set(knowledgeBaseId, selected);
  };
  const plan = input.knowledgePlan;
  const visibility = baseVisibilityWhere(input);

  if (plan.mode === "none") {
    return {
      baseAuthorizedSourceIds: [],
      directProfile: null,
      directSources: [],
      exclusions: [],
      scopes: []
    };
  }
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

  let requestedSourceIds: readonly string[] | null = plan.mode === "all_my_knowledge"
    ? null
    : plan.sourceIds;
  if (plan.mode === "all_my_knowledge" && input.projectId) {
    throw new KnowledgeRunAdmissionError();
  }

  let projectBoundSourceCount: number | null = null;
  if (input.projectId && ((requestedSourceIds?.length ?? 0) > 0 || plan.mode === "inherited")) {
    const bindings = client.projectKnowledgeSourceBinding;
    if (!bindings) {
      if ((requestedSourceIds?.length ?? 0) > 0) throw new KnowledgeRunAdmissionError();
      requestedSourceIds = [];
    } else if (plan.mode === "inherited") {
      projectBoundSourceCount = await bindings.count({ where: { projectId: input.projectId } });
      const rows = await bindings.findMany({
        orderBy: { sourceId: "asc" },
        select: { sourceId: true },
        take: KNOWLEDGE_SCOPE_MAX_SOURCES,
        where: { projectId: input.projectId }
      });
      requestedSourceIds = rows.map(({ sourceId }) => sourceId);
      if (projectBoundSourceCount > rows.length) {
        incrementExclusion(
          exclusions,
          "source",
          "binding_budget",
          projectBoundSourceCount - rows.length
        );
      }
    } else {
      const selectedSourceIds = requestedSourceIds ?? [];
      const rows = await bindings.findMany({
        orderBy: { sourceId: "asc" },
        select: { sourceId: true },
        where: {
          projectId: input.projectId,
          sourceId: { in: [...selectedSourceIds] }
        }
      });
      if (rows.length !== selectedSourceIds.length) throw new KnowledgeRunAdmissionError();
    }
  }

  let directProfile: DirectProfileRevision | null = null;
  if (requestedSourceIds === null || requestedSourceIds.length > 0) {
    const sourceWhere: Prisma.KnowledgeSourceWhereInput = {
      deletionRequestedAt: null,
      ...(requestedSourceIds === null
        ? { ownerUserId: input.userId }
        : { id: { in: [...requestedSourceIds] } }),
      ...(requestedSourceIds === null || input.projectId
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
                  select: {
                    id: true,
                    profileRevisionId: true,
                    status: true
                  }
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
                id: true,
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
            byteSize: true,
            fileName: true,
            id: true,
            versionNumber: true
          }
        },
        id: true,
        name: true,
        ownerUserId: true
      },
      ...(requestedSourceIds === null ? { take: KNOWLEDGE_SCOPE_MAX_SOURCES + 1 } : {}),
      where: sourceWhere
    });
    const sourceCount = requestedSourceIds === null
      ? await client.knowledgeSource.count({ where: sourceWhere })
      : sources.length;
    if (requestedSourceIds !== null && sources.length !== requestedSourceIds.length) {
      if (input.projectId && plan.mode === "inherited") {
        incrementExclusion(
          exclusions,
          "source",
          "not_ready",
          requestedSourceIds.length - sources.length
        );
      } else {
        throw new KnowledgeRunAdmissionError();
      }
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
    const needsDirectProfile = admittedSources.some((source) =>
      Boolean(input.projectId) || source.ownerUserId === input.userId);
    if (needsDirectProfile) {
      const profile = await client.knowledgeIndexProfile.findUnique({
        select: {
          activeRevision: {
            select: {
              embeddingConfiguration: true,
              embeddingProviderModelId: true,
              executionAuthority: true,
              id: true,
              preflightErrorCode: true,
              preflightStatus: true,
              profileConfiguration: true,
              targetDimension: true,
              vectorSpaceFingerprint: true
            }
          }
        },
        where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
      });
      const revision = profile?.activeRevision;
      if (revision?.preflightStatus === "ready" && revision.preflightErrorCode === null) {
        directProfile = revision;
      }
    }

    for (const source of admittedSources) {
      const directAuthority = Boolean(input.projectId) || source.ownerUserId === input.userId;
      if (directAuthority) {
        const version = source.currentVersion;
        const artifact = directProfile && version?.artifacts.find((candidate) =>
          candidate.profileRevisionId === directProfile?.id &&
          candidate.state === "ready" &&
          candidate.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
        const summary = version && artifact
          ? readyArtifactSummary({ artifact, versionByteSize: version.byteSize })
          : null;
        if (!directProfile || !version || !artifact || !summary) {
          incrementExclusion(exclusions, "source", "not_ready");
          continue;
        }
        directSources.push({
          approxTokens: summary.approxTokens,
          artifactId: artifact.id,
          fileName: version.fileName,
          ownerUserId: source.ownerUserId,
          passageCount: summary.passageCount,
          profileRevisionId: directProfile.id,
          provenance: plan.mode === "all_my_knowledge"
            ? "all_my_knowledge"
            : "explicit_source",
          sourceId: source.id,
          sourceName: source.name,
          sourceVersionId: version.id,
          sourceVersionNumber: version.versionNumber
        });
        continue;
      }
      const eligible = source.baseMemberships.filter(({ knowledgeBase }) => {
        const generation = knowledgeBase.activeIndexGeneration;
        return generation?.status === "active" && Boolean(generation.profileRevisionId) &&
          source.currentVersion?.artifacts.some((artifact) =>
            artifact.profileRevisionId === generation.profileRevisionId &&
            artifact.state === "ready" &&
            artifact.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
      });
      if (eligible.length === 0) {
        incrementExclusion(
          exclusions,
          "source",
          source.baseMemberships.length > 0 ? "not_ready" : "unattached"
        );
        continue;
      }
      baseAuthorizedSourceIds.add(source.id);
      for (const { knowledgeBase } of eligible) addSource(knowledgeBase.id, source.id);
    }
  }

  const ordered = [...scopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const admitted = ordered.slice(0, KNOWLEDGE_SCOPE_MAX_BINDINGS);
  if (ordered.length > admitted.length) {
    incrementExclusion(exclusions, "base", "binding_budget", ordered.length - admitted.length);
  }
  return {
    baseAuthorizedSourceIds: [...baseAuthorizedSourceIds].sort(),
    directProfile,
    directSources: directSources.sort((left, right) =>
      `${left.sourceId}:${left.sourceVersionId}:${left.artifactId}`.localeCompare(
        `${right.sourceId}:${right.sourceVersionId}:${right.artifactId}`
      )),
    exclusions: [...exclusions.values()].sort((left, right) =>
      `${left.resourceType}:${left.reason}`.localeCompare(`${right.resourceType}:${right.reason}`)),
    scopes: admitted.map(([knowledgeBaseId, selected]) => ({
      knowledgeBaseId,
      selectedSourceIds: selected === null ? null : [...selected].sort()
    }))
  };
}

type AdmissionProfileSeed = Omit<KnowledgeRunAdmissionProfile, "ordinal">;

function embeddingCompatibilityKey(profile: Pick<AdmissionProfileSeed,
  "embeddingExecutionSnapshot" | "vectorSpaceFingerprint">): string {
  return `${profile.vectorSpaceFingerprint}\u0000${canonicalJson(
    normalizeProviderExecutionSnapshot(profile.embeddingExecutionSnapshot)
  )}`;
}

type MutableAdmissionSource = {
  approxTokens: number;
  artifactId: string;
  authorityKnowledgeBaseIds: Set<string>;
  authorityOwner: boolean;
  authorityProjectId: string | null;
  baseProvenance: Map<string, string>;
  directSelected: boolean;
  fileName: string;
  passageCount: number;
  profileKey: string;
  profileRevisionId: string;
  provenance: Set<KnowledgeRunAdmissionSource["selectionProvenance"][number]>;
  sourceId: string;
  sourceName: string;
  sourceVersionId: string;
  sourceVersionNumber: number;
};

export async function loadKnowledgeRunAdmissionPlan(
  client: KnowledgeRunAdmissionStore,
  input: Readonly<{
    executionScope?: "project";
    knowledgePlan: KnowledgePlan;
    preferredProfileRevisionId?: string;
    projectId?: string;
    userId: string;
  }>
): Promise<KnowledgeRunAdmissionPlan> {
  const decodedKnowledgePlan = decodeKnowledgePlan(input.knowledgePlan);
  if (!decodedKnowledgePlan.ok) throw new KnowledgeRunAdmissionError();
  const knowledgePlan = decodedKnowledgePlan.plan;
  const answerPolicyRow = client.knowledgeAnswerPolicy
    ? await client.knowledgeAnswerPolicy.findUnique({
        select: { maximumKnowledgeSearches: true, version: true },
        where: { id: "installation" }
      })
    : null;
  const answerPolicy = answerPolicyRow
    ? knowledgeAnswerPolicySnapshot({
        maximumKnowledgeSearches: answerPolicyRow.maximumKnowledgeSearches,
        revision: answerPolicyRow.version
      })
    : DEFAULT_KNOWLEDGE_ANSWER_POLICY;
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
  const bindingProfileKeys = new Map<string, string>();
  const budgetPoliciesByProfileKey = new Map<string, KnowledgeBudgetPolicy>();
  const compatibilityKeysByProfileKey = new Map<string, string>();
  const profilesByKey = new Map<string, AdmissionProfileSeed>();
  const sourcesByKey = new Map<string, MutableAdmissionSource>();
  const unavailableMembershipSourceIds = new Set<string>();
  const exclusions = new Map(resolved.exclusions.map((exclusion) => [
    `${exclusion.resourceType}:${exclusion.reason}`,
    exclusion
  ]));

  const resolveProfile = async (revision: DirectProfileRevision): Promise<string> => {
    const resolvedBudgetPolicy = knowledgeBudgetPolicyFromProfileConfiguration(
      revision.profileConfiguration,
      answerPolicy.maximumKnowledgeSearches
    );
    const embedding = projectScope
      ? await embeddingRuntime.resolveForProject({
          providerModelId: revision.embeddingProviderModelId
        })
      : revision.executionAuthority === "installation"
        ? await embeddingRuntime.resolveForInstallation({
            providerModelId: revision.embeddingProviderModelId
          })
        : await embeddingRuntime.resolveForUser({
            providerModelId: revision.embeddingProviderModelId,
            userId: input.userId
          });
    const currentPin = createKnowledgeVectorSpacePin({
      configuration: embedding.configuration,
      deploymentId: revision.embeddingProviderModelId
    });
    const storedFingerprint = revision.vectorSpaceFingerprint.trim();
    if (
      !currentPin?.indexSupported ||
      currentPin.fingerprint !== storedFingerprint ||
      currentPin.targetDimension !== revision.targetDimension ||
      canonicalJson(currentPin.configuration) !== canonicalJson(revision.embeddingConfiguration)
    ) {
      throw new KnowledgeRunAdmissionError();
    }
    const profile = {
      embeddingCredentialSource: embedding.credentialSource,
      embeddingExecutionSnapshot: embedding.executionSnapshot,
      embeddingProviderModelId: revision.embeddingProviderModelId,
      profileRevisionId: revision.id,
      targetDimension: revision.targetDimension,
      vectorSpaceFingerprint: storedFingerprint
    } satisfies AdmissionProfileSeed;
    const key = canonicalJson(profile);
    profilesByKey.set(key, profile);
    budgetPoliciesByProfileKey.set(key, resolvedBudgetPolicy);
    compatibilityKeysByProfileKey.set(key, embeddingCompatibilityKey(profile));
    return key;
  };

  const addSource = (source: Readonly<{
    approxTokens: number;
    artifactId: string;
    authorityKnowledgeBaseId?: string;
    authorityOwner: boolean;
    authorityProjectId: string | null;
    baseProvenance?: Readonly<{
      indexGenerationId: string;
      knowledgeBaseId: string;
    }>;
    directSelected: boolean;
    fileName: string;
    passageCount: number;
    profileKey: string;
    profileRevisionId: string;
    provenance: readonly KnowledgeRunAdmissionSource["selectionProvenance"][number][];
    sourceId: string;
    sourceName: string;
    sourceVersionId: string;
    sourceVersionNumber: number;
  }>): void => {
    const key = canonicalJson([
      source.sourceId,
      source.sourceVersionId,
      source.artifactId,
      source.profileRevisionId
    ]);
    const existing = sourcesByKey.get(key);
    if (existing) {
      if (existing.profileKey !== source.profileKey ||
        existing.fileName !== source.fileName || existing.sourceName !== source.sourceName ||
        existing.approxTokens !== source.approxTokens ||
        existing.passageCount !== source.passageCount ||
        existing.sourceVersionNumber !== source.sourceVersionNumber ||
        existing.authorityProjectId !== source.authorityProjectId) {
        throw new KnowledgeRunAdmissionError();
      }
      existing.directSelected ||= source.directSelected;
      existing.authorityOwner ||= source.authorityOwner;
      if (source.authorityKnowledgeBaseId) {
        existing.authorityKnowledgeBaseIds.add(source.authorityKnowledgeBaseId);
      }
      if (source.baseProvenance) {
        existing.baseProvenance.set(
          source.baseProvenance.knowledgeBaseId,
          source.baseProvenance.indexGenerationId
        );
      }
      for (const value of source.provenance) existing.provenance.add(value);
      return;
    }
    sourcesByKey.set(key, {
      approxTokens: source.approxTokens,
      artifactId: source.artifactId,
      authorityKnowledgeBaseIds: new Set(
        source.authorityKnowledgeBaseId ? [source.authorityKnowledgeBaseId] : []
      ),
      authorityOwner: source.authorityOwner,
      authorityProjectId: source.authorityProjectId,
      baseProvenance: new Map(source.baseProvenance
        ? [[source.baseProvenance.knowledgeBaseId, source.baseProvenance.indexGenerationId]]
        : []),
      directSelected: source.directSelected,
      fileName: source.fileName,
      passageCount: source.passageCount,
      profileKey: source.profileKey,
      profileRevisionId: source.profileRevisionId,
      provenance: new Set(source.provenance),
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      sourceVersionId: source.sourceVersionId,
      sourceVersionNumber: source.sourceVersionNumber
    });
  };

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
                        id: true,
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
                    byteSize: true,
                    fileName: true,
                    id: true,
                    versionNumber: true
                  }
                },
                name: true,
                ownerUserId: true
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
      if (!generation.profileRevisionId || !generation.profileRevision) {
        throw new KnowledgeRunAdmissionError();
      }
      const profileKey = await resolveProfile({
        embeddingConfiguration: generation.embeddingConfiguration,
        embeddingProviderModelId: generation.embeddingProviderModelId,
        executionAuthority: generation.profileRevision.executionAuthority,
        id: generation.profileRevisionId,
        profileConfiguration: generation.profileRevision.profileConfiguration,
        targetDimension: generation.targetDimension,
        vectorSpaceFingerprint: generation.vectorSpaceFingerprint
      });
      const profile = profilesByKey.get(profileKey)!;
      const sourceSummary = admittedSourceSummary(base, scope.selectedSourceIds);
      bindings.push({
        ...sourceSummary,
        baseContentRevision: base.contentRevision,
        embeddingCredentialSource: profile.embeddingCredentialSource,
        embeddingExecutionSnapshot: profile.embeddingExecutionSnapshot,
        embeddingProviderModelId: generation.embeddingProviderModelId,
        indexedContentRevision: generation.indexedContentRevision,
        indexGenerationId: generation.id,
        includeWholeBase: scope.selectedSourceIds === null,
        knowledgeBaseId: base.id,
        ordinal,
        selectedSourceIds: scope.selectedSourceIds ?? [],
        targetDimension: generation.targetDimension,
        vectorSpaceFingerprint: profile.vectorSpaceFingerprint
      });
      bindingProfileKeys.set(base.id, profileKey);
      for (const membership of base.sourceMemberships ?? []) {
        const version = membership.source.currentVersion;
        const artifact = version?.artifacts.find((candidate) =>
          candidate.profileRevisionId === generation.profileRevisionId &&
          candidate.state === "ready" &&
          candidate.hierarchicalIndexes.some((hierarchy) => hierarchy.state === "ready"));
        const summary = version && artifact
          ? readyArtifactSummary({ artifact, versionByteSize: version.byteSize })
          : null;
        if (!version || !artifact || !summary) {
          unavailableMembershipSourceIds.add(membership.sourceId);
          continue;
        }
        const baseAuthorized = resolved.baseAuthorizedSourceIds.includes(membership.sourceId);
        addSource({
          approxTokens: summary.approxTokens,
          artifactId: artifact.id,
          authorityKnowledgeBaseId: base.id,
          authorityOwner: !projectScope && membership.source.ownerUserId === input.userId,
          authorityProjectId: projectScope ? input.projectId! : null,
          baseProvenance: {
            indexGenerationId: generation.id,
            knowledgeBaseId: base.id
          },
          directSelected: baseAuthorized,
          fileName: version.fileName,
          passageCount: summary.passageCount,
          profileKey,
          profileRevisionId: generation.profileRevisionId,
          provenance: baseAuthorized ? ["base", "explicit_source"] : ["base"],
          sourceId: membership.sourceId,
          sourceName: membership.source.name,
          sourceVersionId: version.id,
          sourceVersionNumber: version.versionNumber
        });
      }
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

  if (resolved.directSources.length > 0) {
    if (!resolved.directProfile) throw new KnowledgeRunAdmissionError();
    try {
      const profileKey = await resolveProfile(resolved.directProfile);
      for (const source of resolved.directSources) {
        addSource({
          approxTokens: source.approxTokens,
          artifactId: source.artifactId,
          authorityOwner: !projectScope && source.ownerUserId === input.userId,
          authorityProjectId: projectScope ? input.projectId! : null,
          directSelected: source.provenance === "explicit_source",
          fileName: source.fileName,
          passageCount: source.passageCount,
          profileKey,
          profileRevisionId: source.profileRevisionId,
          provenance: [source.provenance],
          sourceId: source.sourceId,
          sourceName: source.sourceName,
          sourceVersionId: source.sourceVersionId,
          sourceVersionNumber: source.sourceVersionNumber
        });
      }
    } catch (error) {
      if (error instanceof KnowledgeRunAdmissionError || error instanceof ProviderAdmissionError) {
        throw new KnowledgeRunAdmissionError();
      }
      throw error;
    }
  }

  const allOrderedSources = [...sourcesByKey.values()].sort((left, right) =>
    canonicalJson([
      left.sourceId,
      left.sourceVersionId,
      left.artifactId,
      left.profileRevisionId
    ]).localeCompare(canonicalJson([
      right.sourceId,
      right.sourceVersionId,
      right.artifactId,
      right.profileRevisionId
    ])));
  const profileKeysByCompatibility = new Map<string, string[]>();
  for (const profileKey of profilesByKey.keys()) {
    const compatibilityKey = compatibilityKeysByProfileKey.get(profileKey)!;
    const profileKeys = profileKeysByCompatibility.get(compatibilityKey) ?? [];
    profileKeys.push(profileKey);
    profileKeysByCompatibility.set(compatibilityKey, profileKeys);
  }
  const readySourceIdsByCompatibility = new Map<string, Set<string>>();
  for (const source of allOrderedSources) {
    const compatibilityKey = compatibilityKeysByProfileKey.get(source.profileKey)!;
    const sourceIds = readySourceIdsByCompatibility.get(compatibilityKey) ?? new Set<string>();
    sourceIds.add(source.sourceId);
    readySourceIdsByCompatibility.set(compatibilityKey, sourceIds);
  }
  const bindingCompatibilityKeys = new Set([...bindingProfileKeys.values()].map((profileKey) =>
    compatibilityKeysByProfileKey.get(profileKey)!));
  const eligibleCompatibilityKeys = [...profileKeysByCompatibility.keys()].filter(
    (compatibilityKey) =>
      (readySourceIdsByCompatibility.get(compatibilityKey)?.size ?? 0) > 0 ||
      bindingCompatibilityKeys.has(compatibilityKey)
  );
  const orderedCompatibilityKeys = eligibleCompatibilityKeys.sort((left, right) => {
    const leftPreferred = (profileKeysByCompatibility.get(left) ?? []).some((profileKey) =>
      profilesByKey.get(profileKey)?.profileRevisionId === input.preferredProfileRevisionId);
    const rightPreferred = (profileKeysByCompatibility.get(right) ?? []).some((profileKey) =>
      profilesByKey.get(profileKey)?.profileRevisionId === input.preferredProfileRevisionId);
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    const sourceCount = (readySourceIdsByCompatibility.get(right)?.size ?? 0) -
      (readySourceIdsByCompatibility.get(left)?.size ?? 0);
    return sourceCount || left.localeCompare(right);
  });
  const selectedCompatibilityKey = orderedCompatibilityKeys[0] ?? null;
  const selectedProfileKeys = selectedCompatibilityKey
    ? [...(profileKeysByCompatibility.get(selectedCompatibilityKey) ?? [])].sort()
    : [];
  if (new Set(selectedProfileKeys.map((profileKey) =>
    canonicalJson(budgetPoliciesByProfileKey.get(profileKey)))).size > 1) {
    throw new KnowledgeRunAdmissionError();
  }
  const profileOrdinals = new Map(selectedProfileKeys.map((profileKey, ordinal) => [
    profileKey,
    ordinal
  ]));
  const profiles: KnowledgeRunAdmissionProfile[] = selectedProfileKeys.map(
    (profileKey, ordinal) => ({ ...profilesByKey.get(profileKey)!, ordinal })
  );
  const selectedBindings = bindings
    .filter((binding) => {
      const profileKey = bindingProfileKeys.get(binding.knowledgeBaseId);
      return profileKey !== undefined &&
        compatibilityKeysByProfileKey.get(profileKey) === selectedCompatibilityKey;
    })
    .map((binding, ordinal) => ({ ...binding, ordinal }));
  const orderedSources = selectedCompatibilityKey
    ? allOrderedSources.filter((source) =>
        compatibilityKeysByProfileKey.get(source.profileKey) === selectedCompatibilityKey)
    : [];
  const selectedSourceIds = new Set(orderedSources.map((source) => source.sourceId));
  const omittedReadySourceIds = new Set(allOrderedSources
    .filter((source) => !selectedSourceIds.has(source.sourceId))
    .map((source) => source.sourceId));
  incrementExclusion(exclusions, "source", "not_ready", omittedReadySourceIds.size);
  const availableSourceIds = new Set(allOrderedSources.map((source) => source.sourceId));
  const unavailableMembershipCount = [...unavailableMembershipSourceIds].filter((sourceId) =>
    !availableSourceIds.has(sourceId)).length;
  incrementExclusion(exclusions, "source", "not_ready", unavailableMembershipCount);
  const sources: KnowledgeRunAdmissionSource[] = orderedSources.map((source, ordinal) => ({
    approxTokens: source.approxTokens,
    authority: {
      knowledgeBaseIds: [...source.authorityKnowledgeBaseIds].sort(),
      owner: source.authorityOwner,
      projectId: source.authorityProjectId
    },
    baseProvenance: [...source.baseProvenance.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([knowledgeBaseId, indexGenerationId]) => ({
        indexGenerationId,
        knowledgeBaseId
      })),
    directSelected: source.directSelected,
    ordinal,
    privateLabels: {
      fileName: source.fileName,
      sourceName: source.sourceName
    },
    passageCount: source.passageCount,
    profileOrdinal: profileOrdinals.get(source.profileKey)!,
    profileRevisionId: source.profileRevisionId,
    selectionProvenance: [...source.provenance].sort(),
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: source.artifactId,
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    sourceVersionNumber: source.sourceVersionNumber
  }));

  const accepted = {
    answerPolicy,
    bindings: selectedBindings,
    budgetPolicy: selectedProfileKeys[0]
      ? budgetPoliciesByProfileKey.get(selectedProfileKeys[0])!
      : knowledgeBudgetPolicyFromProfileConfiguration(null),
    exclusions: [...exclusions.values()].sort((left, right) =>
      `${left.resourceType}:${left.reason}`.localeCompare(
        `${right.resourceType}:${right.reason}`
      )),
    knowledgePlan,
    profiles,
    resolvedSourceCount: sources.length,
    sources,
    ...(projectScope ? { executionScope: "project" as const, projectId: input.projectId } : {}),
    userId: input.userId
  } satisfies Omit<KnowledgeRunAdmissionPlan, "fingerprint">;
  return { ...accepted, fingerprint: fingerprint(accepted) };
}

export function sameKnowledgeRunAdmissionPlan(
  left: KnowledgeRunAdmissionPlan,
  right: KnowledgeRunAdmissionPlan
): boolean {
  const normalized = (plan: KnowledgeRunAdmissionPlan) => ({
    ...plan,
    answerPolicy: plan.answerPolicy ?? DEFAULT_KNOWLEDGE_ANSWER_POLICY,
    answeringPlan: undefined,
    fingerprint: undefined
  });
  const sameContent = canonicalJson(normalized(left)) === canonicalJson(normalized(right));
  const legacy = left.answerPolicy === undefined || right.answerPolicy === undefined;
  return sameContent && (legacy || left.fingerprint === right.fingerprint);
}

function validKnowledgeAuthorizationSnapshot(
  snapshot: KnowledgeRunAdmissionAuthorizationSnapshot,
  projectId: string | undefined
): boolean {
  const sourceBindingStrategy = snapshot.sourceBindingStrategy ??
    KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER;
  const resolvedSourceCount = snapshot.resolvedSourceCount ?? snapshot.sources.length;
  const sourceCardinalityValid = Number.isSafeInteger(resolvedSourceCount) &&
    resolvedSourceCount >= 1 && resolvedSourceCount <= 2_147_483_647 &&
    (sourceBindingStrategy === KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
      ? resolvedSourceCount <= KNOWLEDGE_SCOPE_MAX_SOURCES &&
        snapshot.sources.length === resolvedSourceCount
      : sourceBindingStrategy === KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED &&
        resolvedSourceCount > KNOWLEDGE_SCOPE_MAX_SOURCES &&
        snapshot.sources.length <= KNOWLEDGE_SCOPE_MAX_SOURCES &&
        snapshot.sources.length <= resolvedSourceCount);
  const decodedPlan = decodeKnowledgePlan(snapshot.knowledgePlan);
  if (!decodedPlan.ok || decodedPlan.plan.mode === "none" || snapshot.profiles.length < 1 ||
    !sourceCardinalityValid || snapshot.profiles.some((profile, ordinal) =>
      profile.ordinal !== ordinal)) return false;
  const profilesByRevision = new Map(snapshot.profiles.map((profile) => [
    profile.profileRevisionId,
    profile
  ]));
  if (profilesByRevision.size !== snapshot.profiles.length ||
    new Set(snapshot.profiles.map(embeddingCompatibilityKey)).size !== 1) return false;
  const vectorSpaceFingerprint = snapshot.profiles[0]!.vectorSpaceFingerprint;
  const bindingIds = new Set<string>();
  for (const binding of snapshot.bindings) {
    if (!binding.knowledgeBaseId.trim() || !binding.indexGenerationId.trim() ||
      !/^[0-9a-f]{64}$/u.test(binding.vectorSpaceFingerprint.trim()) ||
      binding.vectorSpaceFingerprint !== vectorSpaceFingerprint ||
      bindingIds.has(binding.knowledgeBaseId)) return false;
    bindingIds.add(binding.knowledgeBaseId);
  }
  const sourceTuples = new Set<string>();
  for (const source of snapshot.sources) {
    const sourceTuple = canonicalJson([
      source.sourceId,
      source.sourceVersionId,
      source.sourceArtifactId
    ]);
    if (!source.sourceId.trim() || !source.sourceVersionId.trim() ||
      !source.sourceArtifactId.trim() || !profilesByRevision.has(source.profileRevisionId) ||
      sourceTuples.has(sourceTuple) || (projectId
        ? source.authority.projectId !== projectId || source.authority.owner
        : source.authority.projectId !== null)) return false;
    sourceTuples.add(sourceTuple);
    const authorityBaseIds = new Set(source.authority.knowledgeBaseIds);
    if (authorityBaseIds.size !== source.authority.knowledgeBaseIds.length ||
      [...authorityBaseIds].some((knowledgeBaseId) => !bindingIds.has(knowledgeBaseId)) ||
      !source.authority.owner && !projectId && authorityBaseIds.size === 0) return false;
    const provenanceBaseIds = new Set<string>();
    for (const provenance of source.baseProvenance) {
      const binding = snapshot.bindings.find((candidate) =>
        candidate.knowledgeBaseId === provenance.knowledgeBaseId);
      if (!binding || !authorityBaseIds.has(provenance.knowledgeBaseId) ||
        binding.indexGenerationId !== provenance.indexGenerationId ||
        provenanceBaseIds.has(provenance.knowledgeBaseId)) return false;
      provenanceBaseIds.add(provenance.knowledgeBaseId);
    }
    if (provenanceBaseIds.size !== authorityBaseIds.size) return false;
  }
  return true;
}

/**
 * Reauthorizes an already accepted immutable Knowledge snapshot. Current
 * pointers intentionally do not participate: activation, Source replacement,
 * and Base membership edits affect future admission only. The exact accepted
 * rows must still exist, while live user/Project/resource authority and
 * deletion fences are checked again before private retrieval or provider
 * egress.
 */
export async function authorizeKnowledgeRunAdmissionSnapshot(
  client: KnowledgeRunSnapshotAuthorizationStore,
  input: Readonly<{
    executionScope?: "project";
    projectId?: string;
    snapshot: KnowledgeRunAdmissionAuthorizationSnapshot;
    userId: string;
  }>
): Promise<boolean> {
  const projectScope = input.executionScope === "project";
  if (projectScope !== Boolean(input.projectId) ||
    !validKnowledgeAuthorizationSnapshot(input.snapshot, input.projectId)) return false;

  const user = await client.user.findFirst({
    select: {
      groups: {
        select: { groupId: true },
        where: { group: { archivedAt: null } }
      },
      id: true
    },
    where: { id: input.userId, status: "active" }
  });
  if (!user) return false;
  const groupIds = user.groups.map(({ groupId }) => groupId);
  if (projectScope) {
    const project = await client.project.findFirst({
      select: { id: true },
      where: {
        archivedAt: null,
        deletionRequestedAt: null,
        grants: {
          some: {
            OR: [
              { userId: input.userId },
              ...(groupIds.length > 0 ? [{ groupId: { in: groupIds } }] : [])
            ],
            role: { in: ["CONTRIBUTOR", "MANAGER", "OWNER"] }
          }
        },
        id: input.projectId,
        status: "ACTIVE"
      }
    });
    if (!project) return false;
  }

  const generationIds = input.snapshot.bindings.map(({ indexGenerationId }) =>
    indexGenerationId);
  const bases = await client.knowledgeBase.findMany({
    select: {
      deletionRequestedAt: true,
      id: true,
      indexGenerations: {
        select: {
          embeddingProviderModelId: true,
          id: true,
          profileRevisionId: true,
          status: true,
          targetDimension: true,
          vectorSpaceFingerprint: true
        },
        where: { id: { in: generationIds } }
      },
      ownerUserId: true,
      projectBindings: {
        select: { projectId: true },
        ...(input.projectId ? { where: { projectId: input.projectId } } : {})
      },
      publications: { select: { groupId: true, scope: true } }
    },
    where: { id: { in: input.snapshot.bindings.map(({ knowledgeBaseId }) => knowledgeBaseId) } }
  });
  if (bases.length !== input.snapshot.bindings.length) return false;
  const basesById = new Map(bases.map((base) => [base.id, base]));
  const profilesByRevision = new Map(input.snapshot.profiles.map((profile) => [
    profile.profileRevisionId,
    profile
  ]));
  for (const binding of input.snapshot.bindings) {
    const base = basesById.get(binding.knowledgeBaseId);
    if (!base || base.deletionRequestedAt !== null) return false;
    const authorityCurrent = projectScope
      ? base.projectBindings.some(({ projectId }) => projectId === input.projectId)
      : base.ownerUserId === input.userId || base.publications.some((publication) =>
          publication.scope === "installation" ||
          publication.scope === "group" && publication.groupId !== null &&
            groupIds.includes(publication.groupId));
    if (!authorityCurrent) return false;
    const generation = base.indexGenerations.find(({ id }) => id === binding.indexGenerationId);
    const profile = generation?.profileRevisionId
      ? profilesByRevision.get(generation.profileRevisionId)
      : null;
    if (!generation || !["active", "ready", "retired"].includes(generation.status) ||
      !profile ||
      generation.embeddingProviderModelId !== profile.embeddingProviderModelId ||
      generation.targetDimension !== profile.targetDimension ||
      generation.vectorSpaceFingerprint.trim() !== binding.vectorSpaceFingerprint) return false;
  }

  const sourceVersionIds = input.snapshot.sources.map(({ sourceVersionId }) => sourceVersionId);
  const sourceArtifactIds = input.snapshot.sources.map(({ sourceArtifactId }) => sourceArtifactId);
  const sources = await client.knowledgeSource.findMany({
    select: {
      deletionRequestedAt: true,
      id: true,
      ownerUserId: true,
      projectBindings: {
        select: { projectId: true },
        ...(input.projectId ? { where: { projectId: input.projectId } } : {})
      },
      versions: {
        select: {
          artifacts: {
            select: {
              hierarchicalIndexes: {
                select: { state: true },
                where: { state: "ready" }
              },
              id: true,
              profileRevisionId: true,
              state: true
            },
            where: { id: { in: sourceArtifactIds } }
          },
          id: true
        },
        where: { id: { in: sourceVersionIds } }
      }
    },
    where: { id: { in: input.snapshot.sources.map(({ sourceId }) => sourceId) } }
  });
  if (sources.length !== new Set(input.snapshot.sources.map(({ sourceId }) => sourceId)).size) {
    return false;
  }
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  for (const accepted of input.snapshot.sources) {
    const source = sourcesById.get(accepted.sourceId);
    const version = source?.versions.find(({ id }) => id === accepted.sourceVersionId);
    const artifact = version?.artifacts.find(({ id }) => id === accepted.sourceArtifactId);
    if (!source || source.deletionRequestedAt !== null || !version || !artifact ||
      artifact.state !== "ready" || artifact.profileRevisionId !== accepted.profileRevisionId ||
      !artifact.hierarchicalIndexes.some(({ state }) => state === "ready")) return false;
    if (accepted.authority.owner && source.ownerUserId !== input.userId) return false;
    if (projectScope && (accepted.directSelected || accepted.baseProvenance.length === 0) &&
      !source.projectBindings.some(({ projectId }) => projectId === input.projectId)) return false;
  }
  return true;
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
    profiles?: readonly KnowledgeRunAdmissionProfile[];
    sources?: readonly KnowledgeRunAdmissionSource[];
  }>
): boolean {
  if (canonicalJson(current.knowledgePlan) !== canonicalJson(expected.knowledgePlan)) return false;
  const bindingsAuthorize = expected.bindings.every((accepted) => {
    const candidate = current.bindings.find((binding) =>
      binding.knowledgeBaseId === accepted.knowledgeBaseId);
    if (!candidate || candidate.indexGenerationId !== accepted.indexGenerationId ||
      candidate.vectorSpaceFingerprint !== accepted.vectorSpaceFingerprint) return false;
    if (accepted.includeWholeBase) return candidate.includeWholeBase;
    return candidate.includeWholeBase || accepted.selectedSourceIds.every((sourceId) =>
      candidate.selectedSourceIds.includes(sourceId));
  });
  if (!bindingsAuthorize) return false;
  if (!expected.profiles && !expected.sources) return true;

  const currentProfiles = current.profiles ?? [];
  const expectedProfiles = expected.profiles ?? [];
  const profileTuple = (profile: KnowledgeRunAdmissionProfile) => ({
    embeddingCredentialSource: profile.embeddingCredentialSource,
    embeddingExecutionSnapshot: profile.embeddingExecutionSnapshot,
    embeddingProviderModelId: profile.embeddingProviderModelId,
    profileRevisionId: profile.profileRevisionId,
    targetDimension: profile.targetDimension,
    vectorSpaceFingerprint: profile.vectorSpaceFingerprint
  });
  if (!expectedProfiles.every((accepted) => currentProfiles.some((candidate) =>
    canonicalJson(profileTuple(candidate)) === canonicalJson(profileTuple(accepted))))) {
    return false;
  }

  const expectedSources = expected.sources ?? [];
  const currentSources = current.sources ?? [];
  return expectedSources.every((accepted) => {
    const candidate = currentSources.find((source) =>
      source.sourceId === accepted.sourceId &&
      source.sourceVersionId === accepted.sourceVersionId &&
      source.sourceArtifactId === accepted.sourceArtifactId &&
      source.profileRevisionId === accepted.profileRevisionId);
    if (!candidate || accepted.directSelected && !candidate.directSelected ||
      accepted.approxTokens !== candidate.approxTokens ||
      accepted.passageCount !== candidate.passageCount ||
      accepted.authority.owner && !candidate.authority.owner ||
      accepted.authority.projectId !== candidate.authority.projectId) return false;
    const acceptedProfile = expectedProfiles.find((profile) =>
      profile.ordinal === accepted.profileOrdinal);
    const candidateProfile = currentProfiles.find((profile) =>
      profile.ordinal === candidate.profileOrdinal);
    if (!acceptedProfile || !candidateProfile ||
      canonicalJson(profileTuple(acceptedProfile)) !== canonicalJson(profileTuple(candidateProfile))) {
      return false;
    }
    if (!accepted.selectionProvenance.every((value) =>
      candidate.selectionProvenance.includes(value)) ||
      !accepted.authority.knowledgeBaseIds.every((knowledgeBaseId) =>
        candidate.authority.knowledgeBaseIds.includes(knowledgeBaseId))) return false;
    return accepted.baseProvenance.every((provenance) =>
      candidate.baseProvenance.some((value) =>
        value.knowledgeBaseId === provenance.knowledgeBaseId &&
        value.indexGenerationId === provenance.indexGenerationId));
  });
}

export function createKnowledgeRunAdmissionService(
  client: KnowledgeRunAdmissionStore & KnowledgeRunSnapshotAuthorizationStore = prisma
) {
  return {
    authorizeSnapshot(input: Readonly<{
      executionScope?: "project";
      projectId?: string;
      snapshot: KnowledgeRunAdmissionAuthorizationSnapshot;
      userId: string;
    }>) {
      return authorizeKnowledgeRunAdmissionSnapshot(client, input);
    },
    load(input: Readonly<{
      executionScope?: "project";
      knowledgePlan: KnowledgePlan;
      preferredProfileRevisionId?: string;
      projectId?: string;
      userId: string;
    }>) {
      return loadKnowledgeRunAdmissionPlan(client, input);
    }
  };
}

export const knowledgeRunAdmissionService = createKnowledgeRunAdmissionService();

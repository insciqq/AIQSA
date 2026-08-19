import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  adminSearchExecutionDefaults,
  type AdminSearchDraft
} from "../../../contracts/adminSearch";
import type {
  AdminProviderActiveCheck,
  AdminProviderConnection,
  AdminProviderDeleteBlocker,
  AdminProviderDeleteResult,
  AdminProviderDraftCheck,
  AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import {
  normalizeProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import {
  adminProviderConnectionConfiguration,
  adminProviderModelConfiguration
} from "./adminConfiguration";
import { normalizeSearchDraft, searchDraftHash } from "../../search/configuration";
import { searchValidationFingerprint } from "../../search/probeBinding";
import type {
  AdminProviderRepository,
  ProviderActivationWrite,
  ProviderDraftTestCandidate,
  StoredProviderDraftCheck
} from "./repositoryContract";
import { decodeStructuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import {
  countBlockingMemoryExecutionBindings,
  detachExpiredMemoryExecutionBindings,
  type MemoryExecutionDetachTarget
} from "../../memory/execution/lifecycle";

class ProviderActivationStaleError extends Error {}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function date(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidence(value: unknown): AdminProviderTestEvidence | null {
  if (
    !isRecord(value) ||
    (value.method !== "models_catalog" &&
      value.method !== "openrouter_account_catalog" &&
      value.method !== "tiny_generation") ||
    (value.detail !== "model_missing" && value.detail !== "ok" && value.detail !== "route_missing") ||
    typeof value.upstreamModelId !== "string" ||
    !Array.isArray(value.selectedProviders) ||
    value.selectedProviders.some((provider) => typeof provider !== "string")
  ) {
    return null;
  }
  const structuredOutput = decodeStructuredOutputVerificationEvidence(value.structuredOutput);
  return {
    detail: value.detail,
    method: value.method,
    selectedProviders: value.selectedProviders as string[],
    ...(structuredOutput ? { structuredOutput } : {}),
    upstreamModelId: value.upstreamModelId
  };
}

function family(value: string): AdminProviderConnection["family"] {
  if (
    value === "anthropic" ||
    value === "fake" ||
    value === "gemini" ||
    value === "openai" ||
    value === "openai_compatible" ||
    value === "openrouter"
  ) {
    return value;
  }
  throw new Error("provider_family_invalid");
}

function draftCheck(row: {
  checkedAt: Date;
  connectionDraftVersion: number;
  credentialDraftVersion: number | null;
  credentialId: string;
  credentialVersionId: string | null;
  evidence: Prisma.JsonValue | null;
  fingerprint: string;
  modelDraftVersion: number;
  providerModelId: string;
  status: "available" | "unavailable";
}): AdminProviderDraftCheck | null {
  const safeEvidence = evidence(row.evidence);
  if (!safeEvidence) return null;
  return {
    checkedAt: row.checkedAt.toISOString(),
    connectionDraftVersion: row.connectionDraftVersion,
    credentialDraftVersion: row.credentialDraftVersion,
    credentialId: row.credentialId,
    credentialVersionId: row.credentialVersionId,
    evidence: safeEvidence,
    fingerprint: row.fingerprint,
    modelDraftVersion: row.modelDraftVersion,
    providerModelId: row.providerModelId,
    status: row.status
  };
}

function activeCheck(row: {
  checkedAt: Date;
  connectionVersion: number;
  credentialId: string;
  credentialVersionId: string;
  evidence: Prisma.JsonValue | null;
  latestRefreshError: Prisma.JsonValue | null;
  modelVersion: number;
  providerModelId: string;
  refreshFailedAt: Date | null;
  status: "available" | "unavailable";
}): AdminProviderActiveCheck {
  return {
    checkedAt: row.checkedAt.toISOString(),
    connectionVersion: row.connectionVersion,
    credentialId: row.credentialId,
    credentialVersionId: row.credentialVersionId,
    evidence: evidence(row.evidence),
    latestRefreshError: isRecord(row.latestRefreshError) &&
      row.latestRefreshError.code === "provider_refresh_failed" &&
      row.latestRefreshError.version === 1
      ? { code: "provider_refresh_failed", version: 1 }
      : null,
    modelVersion: row.modelVersion,
    providerModelId: row.providerModelId,
    refreshFailedAt: date(row.refreshFailedAt),
    status: row.status
  };
}

function modelColumns(configuration: ProviderModelConfiguration) {
  return {
    capabilities: json(configuration.capabilities),
    defaultParams: json(configuration.defaultParams),
    modelId: configuration.upstreamModelId,
    modelClass: configuration.modelClass,
    supportsNativeSearch: configuration.capabilities.nativeSearch,
    supportsPdf: configuration.capabilities.pdf,
    supportsReasoning: configuration.capabilities.reasoning,
    supportsVision: configuration.capabilities.vision
  };
}

function blockers(entries: Array<AdminProviderDeleteBlocker | null>): AdminProviderDeleteBlocker[] {
  return entries.filter((entry): entry is AdminProviderDeleteBlocker => Boolean(entry?.count));
}

function conflict(entries: AdminProviderDeleteBlocker[]): AdminProviderDeleteResult | null {
  return entries.length ? { blockers: entries, status: "conflict" } : null;
}

const activeRunStatuses = ["preparing", "in_progress", "queued", "streaming"] as const;

async function cleanupProviderReferences(
  tx: Prisma.TransactionClient,
  target: Extract<
    MemoryExecutionDetachTarget,
    { connectionId: string } | { credentialId: string } | { providerModelId: string }
  >,
  now = new Date()
): Promise<void> {
  await tx.providerRunBinding.updateMany({
    data: {
      connectionId: null,
      credentialId: null,
      credentialVersionId: null,
      providerModelId: null
    },
    where: {
      AND: [
        target,
        { modelRun: { status: { notIn: [...activeRunStatuses] } } },
        {
          OR: [
            { recoverableUntil: null },
            { recoverableUntil: { lte: now } }
          ]
        }
      ]
    }
  });
  await detachExpiredMemoryExecutionBindings(tx, target, now);
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "ProviderCredentialVersion" AS version
    WHERE NOT EXISTS (
      SELECT 1 FROM "ProviderCredential" AS credential
      WHERE credential."id" = version."credentialId"
        AND credential."activeVersionId" = version."id"
    )
      AND NOT EXISTS (
        SELECT 1 FROM "ProviderRunBinding" AS binding
        WHERE binding."credentialId" = version."credentialId"
          AND binding."credentialVersionId" = version."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryExecutionBinding" AS binding
        WHERE binding."credentialId" = version."credentialId"
          AND binding."credentialVersionId" = version."id"
      )
  `);
}

async function lockInstallationModelPolicies(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "ModelPolicy"
    WHERE "id" = 'installation'
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "SystemModelPolicy"
    WHERE "id" = 'installation'
    FOR UPDATE
  `);
}

async function repeatableRead<Value>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 30_000
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("provider_transaction_conflict");
}

async function serializable<Value>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("provider_transaction_conflict");
}

function sourceMatches(
  candidate: ProviderDraftTestCandidate,
  credential: {
    activeVersion: null | { id: string; revokedAt: Date | null; secretEnvelope: string | null };
    activeVersionId: string | null;
    draftSecretEnvelope: string | null;
    draftVersion: number;
  }
): boolean {
  const source = candidate.credential.source;
  if (source.kind === "draft") {
    return (
      credential.draftVersion === source.draftVersion &&
      credential.draftSecretEnvelope === source.envelope
    );
  }
  return (
    credential.activeVersionId === source.versionId &&
    credential.activeVersion?.id === source.versionId &&
    credential.activeVersion.revokedAt === null &&
    credential.activeVersion.secretEnvelope === source.envelope
  );
}

async function currentReferencedCredentialIds(
  db: Pick<
    Prisma.TransactionClient,
    | "providerConnection"
    | "providerGroupCredentialAssignment"
    | "providerUserCredentialAssignment"
  >,
  connectionId: string
): Promise<string[] | null> {
  const [connection, groupAssignments, userAssignments] = await Promise.all([
    db.providerConnection.findUnique({
      select: { defaultCredentialId: true },
      where: { id: connectionId }
    }),
    db.providerGroupCredentialAssignment.findMany({
      select: { credentialId: true },
      where: { connectionId, group: { archivedAt: null } }
    }),
    db.providerUserCredentialAssignment.findMany({
      select: { credentialId: true },
      where: { connectionId, user: { status: "active" } }
    })
  ]);
  if (!connection) return null;
  return [...new Set([
    ...(connection.defaultCredentialId ? [connection.defaultCredentialId] : []),
    ...groupAssignments.map(({ credentialId }) => credentialId),
    ...userAssignments.map(({ credentialId }) => credentialId)
  ])].sort();
}

function checkMatchesWrite(
  check: StoredProviderDraftCheck,
  modelVersion: number,
  credential: ProviderActivationWrite["credentials"][number],
  connectionVersion: number
): boolean {
  return (
    check.connectionDraftVersion === connectionVersion &&
    check.modelDraftVersion === modelVersion &&
    check.credentialId === credential.id &&
    (credential.kind === "draft"
      ? check.credentialDraftVersion === credential.draftVersion && check.credentialVersionId === null
      : check.credentialDraftVersion === null && check.credentialVersionId === credential.versionId)
  );
}

type ProviderSearchPolicy = Readonly<{
  clientId: string;
  clientKind: "gemini_google_search" | "provider_model_web_search";
  displayName: string;
  description: string;
  hostedId: string;
  hostedKind: "anthropic_native_web_search" | "gemini_google_search" | "openai_native_web_search";
  hostedStrategyId: string;
  modelAdapterKind:
    | "anthropic_messages"
    | "gemini_interactions_native"
    | "openai_responses_compatible"
    | "openai_responses_native";
  optionId: string;
  optionKind: "gemini_google_search" | "web_search";
  optionRowId: string;
  optionTemplateKey: string | null;
  protocol: "anthropic_web_search" | "gemini_google_search" | "openai_responses_web_search";
  provider: "anthropic" | "gemini" | "openai" | "openai_compatible";
}>;

function providerSearchPolicy(connection: Readonly<{
  displayName: string;
  family: string;
  id: string;
  templateKey: string | null;
}>): ProviderSearchPolicy | null {
  if (connection.family === "anthropic" && connection.templateKey === "anthropic") {
    return {
      clientId: `anthropic-search-client:${connection.id}`,
      clientKind: "provider_model_web_search",
      description: "Web search provided by Anthropic.",
      displayName: "Anthropic Search",
      hostedId: "anthropic-web-search",
      hostedKind: "anthropic_native_web_search",
      hostedStrategyId: "anthropic-web-search",
      modelAdapterKind: "anthropic_messages",
      optionId: "anthropic-web-search",
      optionKind: "web_search",
      optionRowId: "00000000-0000-4000-8000-000000001405",
      optionTemplateKey: "search:anthropic",
      protocol: "anthropic_web_search",
      provider: "anthropic"
    };
  }
  if (connection.family === "openai" && connection.templateKey === "openai") {
    return {
      clientId: `openai-search-client:${connection.id}`,
      clientKind: "provider_model_web_search",
      description: "Web search provided by OpenAI.",
      displayName: "OpenAI Search",
      hostedId: "openai-native-web-search",
      hostedKind: "openai_native_web_search",
      hostedStrategyId: "openai-native-web-search",
      modelAdapterKind: "openai_responses_native",
      optionId: "openai-native-web-search",
      optionKind: "web_search",
      optionRowId: "00000000-0000-4000-8000-000000001402",
      optionTemplateKey: "search:openai",
      protocol: "openai_responses_web_search",
      provider: "openai"
    };
  }
  if (connection.family === "gemini" && connection.templateKey === "gemini") {
    return {
      clientId: `gemini-search-client:${connection.id}`,
      clientKind: "gemini_google_search",
      description: "Google Search grounding for eligible Gemini models.",
      displayName: "Google Search",
      hostedId: "00000000-0000-4000-8000-000000001301",
      hostedKind: "gemini_google_search",
      hostedStrategyId: "gemini-google-search",
      modelAdapterKind: "gemini_interactions_native",
      optionId: "gemini-google-search",
      optionKind: "gemini_google_search",
      optionRowId: "00000000-0000-4000-8000-000000001403",
      optionTemplateKey: "search:gemini-google",
      protocol: "gemini_google_search",
      provider: "gemini"
    };
  }
  if (connection.family !== "openai_compatible" || connection.templateKey !== null) return null;
  const sourceName = connection.displayName.trim() || "Custom endpoint";
  return {
    clientId: `custom-web-search-client:${connection.id}`,
    clientKind: "provider_model_web_search",
    description: `Web search provided by ${sourceName}.`.slice(0, 500),
    displayName: `${sourceName.slice(0, 153)} Search`,
    hostedId: `custom-web-search-hosted:${connection.id}`,
    hostedKind: "openai_native_web_search",
    hostedStrategyId: `custom-web-search-hosted:${connection.id}`,
    modelAdapterKind: "openai_responses_compatible",
    optionId: `custom-web-search:${connection.id}`,
    optionKind: "web_search",
    optionRowId: `custom-web-search-option:${connection.id}`,
    optionTemplateKey: null,
    protocol: "openai_responses_web_search",
    provider: "openai_compatible"
  };
}

async function publishProviderSearchRoute(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    draft: AdminSearchDraft;
    evidence: Record<string, unknown>;
    existing: null | Readonly<{ draft: unknown; id: string }>;
    kind: "anthropic_native_web_search" | "gemini_google_search" | "openai_native_web_search" | "provider_model_web_search";
    modelId: string | null;
    now: Date;
    option: Readonly<{ description: string; displayName: string; id: string }>;
    preferredId: string;
    preferredStrategyId: string;
    provider: string;
  }>
): Promise<void> {
  let draft = input.draft;
  if (input.existing) {
    try {
      const current = normalizeSearchDraft(input.existing.draft);
      if (
        current.adapterKind === draft.adapterKind &&
        current.credentialMode === draft.credentialMode &&
        current.protocol === draft.protocol
      ) {
        draft = {
          ...draft,
          maxResults: current.maxResults,
          queryMaxCharacters: current.queryMaxCharacters,
          timeoutMs: current.timeoutMs,
          ...(draft.adapterKind === "provider_model_client"
            ? {
                maxOutputTokens: current.maxOutputTokens,
                maxSearchCallsPerAnswer: current.maxSearchCallsPerAnswer,
                reasoningPolicy: current.reasoningPolicy
              }
            : {})
        };
      }
    } catch {
      // Replace malformed mutable state with the bounded canonical draft below.
    }
  }
  const draftHash = searchDraftHash(draft);
  const validationFingerprint = searchValidationFingerprint(input.evidence);
  const strategy = input.existing ?? await tx.searchStrategy.create({
    data: {
      adapterKind: draft.adapterKind,
      config: json({}),
      credentialMode: draft.credentialMode,
      description: input.option.description,
      displayName: input.option.displayName,
      draft: json(draft),
      draftTestEvidence: Prisma.DbNull,
      enabled: false,
      id: input.preferredId,
      kind: input.kind,
      modelId: input.modelId,
      provider: input.provider,
      providerModelId: draft.providerModelId,
      searchOptionId: input.option.id,
      strategyId: input.preferredStrategyId,
      testedDraftHash: null
    }
  });
  const existingRevision = await tx.searchIntegrationRevision.findUnique({
    where: {
      searchStrategyId_draftHash_validationFingerprint: {
        draftHash,
        searchStrategyId: strategy.id,
        validationFingerprint
      }
    }
  });
  const latestRevision = existingRevision
    ? null
    : await tx.searchIntegrationRevision.findFirst({
        orderBy: { revisionNumber: "desc" },
        where: { searchStrategyId: strategy.id }
      });
  const revision = existingRevision ?? await tx.searchIntegrationRevision.create({
    data: {
      adapterKind: draft.adapterKind,
      configuration: json(draft),
      credentialMode: draft.credentialMode,
      draftHash,
      id: randomUUID(),
      providerModelId: draft.providerModelId,
      revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
      searchStrategyId: strategy.id,
      validationEvidence: json(input.evidence),
      validationFingerprint
    }
  });
  await tx.searchStrategy.update({
    data: {
      activatedAt: input.now,
      activeRevisionId: revision.id,
      adapterKind: draft.adapterKind,
      config: json(draft),
      credentialMode: draft.credentialMode,
      draft: json(draft),
      draftTestEvidence: json(input.evidence),
      enabled: true,
      kind: input.kind,
      modelId: input.modelId,
      provider: input.provider,
      providerModelId: draft.providerModelId,
      testedDraftHash: draftHash
    },
    where: { id: strategy.id }
  });
}

async function synchronizeProviderSearch(
  tx: Prisma.TransactionClient,
  input: ProviderActivationWrite,
  connection: Readonly<{
    displayName: string;
    family: string;
    id: string;
    templateKey: string | null;
  }>
): Promise<void> {
  const policy = providerSearchPolicy(connection);
  if (!policy) return;
  const eligibleModels = input.models.filter((model) =>
    model.configuration.adapterKind === policy.modelAdapterKind &&
    model.configuration.capabilities.nativeSearch === true
  ).sort((left, right) => left.id.localeCompare(right.id));
  const existingOption = await tx.searchOption.findUnique({
    where: {
      sourceConnectionId_kind: {
        kind: policy.optionKind,
        sourceConnectionId: connection.id
      }
    }
  });
  if (eligibleModels.length === 0) {
    if (existingOption && !existingOption.archivedAt) {
      await tx.searchStrategy.updateMany({
        data: { enabled: false },
        where: {
          adapterKind: "provider_model_client",
          archivedAt: null,
          searchOptionId: existingOption.id
        }
      });
    }
    return;
  }
  const option = existingOption ?? await tx.searchOption.create({
    data: {
      description: policy.description,
      displayName: policy.displayName,
      enabled: true,
      id: policy.optionRowId,
      kind: policy.optionKind,
      optionId: policy.optionId,
      sourceConnectionId: connection.id,
      templateKey: policy.optionTemplateKey
    }
  });
  if (option.archivedAt) return;

  const baseDraft = {
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    maxResults: 8,
    maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
    protocol: policy.protocol,
    queryMaxCharacters: 500,
    timeoutMs: 300_000
  };
  const hostedDraft: AdminSearchDraft = {
    adapterKind: "answer_provider_hosted",
    credentialMode: "answer_provider",
    providerModelId: null,
    reasoningPolicy: "provider_default",
    ...baseDraft
  };
  const existingHosted = await tx.searchStrategy.findFirst({
    orderBy: { strategyId: "asc" },
    where: {
      adapterKind: "answer_provider_hosted",
      archivedAt: null,
      credentialMode: "answer_provider",
      searchOptionId: option.id
    }
  });
  const activationEvidence = {
    checkedAt: input.now.toISOString(),
    method: "provider_activation_configuration",
    normalizedSourceCount: 0,
    protocol: policy.protocol,
    sourceProbe: false,
    status: "available"
  } as const;
  const existingClient = await tx.searchStrategy.findFirst({
    where: {
      adapterKind: "provider_model_client",
      archivedAt: null,
      credentialMode: "provider_model",
      searchOptionId: option.id
    }
  });
  const selectedModel = eligibleModels.find((model) => model.id === existingClient?.providerModelId) ??
    eligibleModels[0]!;
  const clientDraft: AdminSearchDraft = {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    providerModelId: selectedModel.id,
    reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
    ...baseDraft
  };
  await publishProviderSearchRoute(tx, {
    draft: hostedDraft,
    evidence: activationEvidence,
    existing: existingHosted,
    kind: policy.hostedKind,
    modelId: null,
    now: input.now,
    option,
    preferredId: policy.hostedId,
    preferredStrategyId: policy.hostedStrategyId,
    provider: policy.provider
  });
  await publishProviderSearchRoute(tx, {
    draft: clientDraft,
    evidence: activationEvidence,
    existing: existingClient,
    kind: policy.clientKind,
    modelId: selectedModel.configuration.upstreamModelId,
    now: input.now,
    option,
    preferredId: policy.clientId,
    preferredStrategyId: policy.clientId,
    provider: policy.provider
  });
}

export function createPrismaAdminProviderRepository(
  prisma: PrismaClient
): AdminProviderRepository {
  return {
    async listConnections() {
      const [connections, draftChecks, activeChecks] = await Promise.all([
        prisma.providerConnection.findMany({
          include: {
            credentials: {
              include: {
                activeVersion: {
                  select: {
                    activatedAt: true,
                    id: true,
                    revokedAt: true,
                    testedAt: true,
                    version: true
                  }
                },
                groupAssignments: {
                  include: {
                    group: {
                      select: { archivedAt: true, id: true, name: true }
                    }
                  }
                },
                userAssignments: {
                  include: {
                    user: {
                      select: {
                        displayName: true,
                        email: true,
                        id: true,
                        status: true
                      }
                    }
                  }
                }
              },
              orderBy: { createdAt: "asc" }
            },
            models: { orderBy: { createdAt: "asc" } }
          },
          orderBy: { createdAt: "asc" },
          where: {
            family: {
              in: ["anthropic", "gemini", "openai", "openai_compatible", "openrouter"]
            }
          }
        }),
        prisma.providerDraftCheck.findMany({ orderBy: { checkedAt: "desc" } }),
        prisma.providerModelCredentialCheck.findMany({ orderBy: { checkedAt: "desc" } })
      ]);

      return connections.map((connection): AdminProviderConnection => ({
        activatedAt: date(connection.activatedAt),
        activeChecks: activeChecks
          .filter((check) => check.connectionId === connection.id)
          .map(activeCheck),
        activeConfig: connection.activeConfig === null
          ? null
          : adminProviderConnectionConfiguration(connection.activeConfig),
        activeVersion: connection.activeVersion,
        assignments: connection.credentials.flatMap((credential) =>
          credential.groupAssignments.map((assignment) => ({
            connectionId: assignment.connectionId,
            credentialId: assignment.credentialId,
            group: {
              archivedAt: date(assignment.group.archivedAt),
              id: assignment.group.id,
              name: assignment.group.name
            },
            updatedAt: assignment.updatedAt.toISOString()
          }))
        ),
        createdAt: connection.createdAt.toISOString(),
        credentials: connection.credentials.map((credential) => ({
          activatedAt: date(credential.activatedAt),
          activeVersion: credential.activeVersion
            ? {
                activatedAt: credential.activeVersion.activatedAt.toISOString(),
                id: credential.activeVersion.id,
                revokedAt: date(credential.activeVersion.revokedAt),
                testedAt: credential.activeVersion.testedAt.toISOString(),
                version: credential.activeVersion.version
              }
            : null,
          createdAt: credential.createdAt.toISOString(),
          draftSecretConfigured: credential.draftSecretEnvelope !== null,
          draftVersion: credential.draftVersion,
          enabled: credential.enabled,
          id: credential.id,
          label: credential.label,
          testedAt: date(credential.testedAt),
          updatedAt: credential.updatedAt.toISOString()
        })),
        defaultCredentialId: connection.defaultCredentialId,
        displayName: connection.displayName,
        draftChecks: draftChecks
          .filter((check) => check.connectionId === connection.id)
          .map(draftCheck)
          .filter((check): check is AdminProviderDraftCheck => check !== null),
        draftConfig: adminProviderConnectionConfiguration(connection.draftConfig),
        draftVersion: connection.draftVersion,
        enabled: connection.enabled,
        family: family(connection.family),
        id: connection.id,
        models: connection.models.map((model) => ({
          activatedAt: date(model.activatedAt),
          activeConfig: model.activeConfig === null
            ? null
            : adminProviderModelConfiguration(model.activeConfig),
          activeVersion: model.activeVersion,
          connectionId: model.connectionId,
          createdAt: model.createdAt.toISOString(),
          displayName: model.displayName,
          draftConfig: adminProviderModelConfiguration(model.draftConfig),
          draftVersion: model.draftVersion,
          enabled: model.enabled,
          id: model.id,
          modelClass: model.modelClass,
          updatedAt: model.updatedAt.toISOString()
        })),
        unassignedPolicy: connection.unassignedPolicy,
        updatedAt: connection.updatedAt.toISOString(),
        userAssignments: connection.credentials.flatMap((credential) =>
          (credential.userAssignments ?? []).map((assignment) => ({
            connectionId: assignment.connectionId,
            credentialId: assignment.credentialId,
            updatedAt: assignment.updatedAt.toISOString(),
            user: {
              displayName: assignment.user.displayName,
              email: assignment.user.email,
              id: assignment.user.id,
              status: assignment.user.status
            }
          }))
        )
      }));
    },

    async createConnection(input) {
      await prisma.providerConnection.create({
        data: {
          displayName: input.displayName,
          draftConfig: json(input.configuration),
          draftVersion: 1,
          enabled: false,
          family: input.family,
          id: input.id,
          unassignedPolicy: input.unassignedPolicy
        }
      });
    },

    async updateConnectionDraft(input) {
      const existing = await prisma.providerConnection.findUnique({
        select: { id: true },
        where: { id: input.connectionId }
      });
      if (!existing) return "not_found";
      const updated = await prisma.providerConnection.updateMany({
        data: {
          displayName: input.displayName,
          draftConfig: json(input.configuration),
          draftVersion: { increment: 1 },
          unassignedPolicy: input.unassignedPolicy
        },
        where: {
          draftVersion: input.expectedDraftVersion,
          family: { not: "fake" },
          id: input.connectionId
        }
      });
      return updated.count === 1 ? "updated" : "stale";
    },

    async createModel(input) {
      const connection = await prisma.providerConnection.findUnique({
        select: { family: true },
        where: { id: input.connectionId }
      });
      if (!connection || connection.family === "fake") return "connection_not_found";
      if (connection.family !== input.family) return "family_mismatch";
      await prisma.providerModel.create({
        data: {
          ...modelColumns(input.configuration),
          connectionId: input.connectionId,
          displayName: input.displayName,
          draftConfig: json(input.configuration),
          draftVersion: 1,
          enabled: true,
          id: input.id,
          provider: connection.family
        }
      });
      return "created";
    },

    async updateModelDraft(input) {
      const existing = await prisma.providerModel.findUnique({
        select: { connection: { select: { family: true } }, id: true, modelClass: true },
        where: { id: input.modelId }
      });
      if (!existing || existing.connection.family === "fake") return "not_found";
      if (existing.connection.family !== input.family) return "family_mismatch";
      if (existing.modelClass !== input.configuration.modelClass) {
        return "model_class_mismatch";
      }
      const updated = await prisma.providerModel.updateMany({
        data: {
          displayName: input.displayName,
          draftConfig: json(input.configuration),
          draftVersion: { increment: 1 }
        },
        where: { draftVersion: input.expectedDraftVersion, id: input.modelId }
      });
      return updated.count === 1 ? "updated" : "stale";
    },

    async createCredential(input) {
      const connection = await prisma.providerConnection.findUnique({
        select: { family: true, id: true },
        where: { id: input.connectionId }
      });
      if (!connection || connection.family === "fake") return "connection_not_found";
      await prisma.providerCredential.create({
        data: {
          connectionId: input.connectionId,
          draftSecretEnvelope: input.draftSecretEnvelope,
          draftVersion: 1,
          enabled: true,
          id: input.id,
          label: input.label
        }
      });
      return "created";
    },

    async renameCredential(input) {
      const updated = await prisma.providerCredential.updateMany({
        data: { label: input.label },
        where: { id: input.credentialId }
      });
      return updated.count === 1 ? "updated" : "not_found";
    },

    async updateCredentialDraft(input) {
      const existing = await prisma.providerCredential.findUnique({
        select: { id: true },
        where: { id: input.credentialId }
      });
      if (!existing) return "not_found";
      const updated = await prisma.providerCredential.updateMany({
        data: {
          draftSecretEnvelope: input.draftSecretEnvelope,
          draftVersion: { increment: 1 }
        },
        where: {
          draftVersion: input.expectedDraftVersion,
          id: input.credentialId
        }
      });
      return updated.count === 1 ? "updated" : "stale";
    },

    async loadDraftTestCandidate(input) {
      const [model, credential] = await Promise.all([
        prisma.providerModel.findFirst({
          include: { connection: true },
          where: {
            connection: { family: { not: "fake" } },
            connectionId: input.connectionId,
            id: input.providerModelId
          }
        }),
        prisma.providerCredential.findFirst({
          include: {
            activeVersion: {
              select: { id: true, revokedAt: true, secretEnvelope: true }
            }
          },
          where: { connectionId: input.connectionId, id: input.credentialId }
        })
      ]);
      if (!model || !credential) return null;
      const source = credential.draftSecretEnvelope
        ? {
            draftVersion: credential.draftVersion,
            envelope: credential.draftSecretEnvelope,
            kind: "draft" as const
          }
        : credential.activeVersion?.secretEnvelope && !credential.activeVersion.revokedAt
          ? {
              envelope: credential.activeVersion.secretEnvelope,
              kind: "active" as const,
              versionId: credential.activeVersion.id
            }
          : null;
      if (!source) return null;
      return {
        connection: {
          configuration: model.connection.draftConfig,
          displayName: model.connection.displayName,
          draftVersion: model.connection.draftVersion,
          family: model.connection.family,
          id: model.connection.id
        },
        credential: { id: credential.id, source },
        model: {
          configuration: model.draftConfig,
          displayName: model.displayName,
          draftVersion: model.draftVersion,
          id: model.id
        }
      };
    },

    async storeDraftCheckCas(candidate, check) {
      const source = candidate.credential.source;
      if (
        check.connectionDraftVersion !== candidate.connection.draftVersion ||
        check.modelDraftVersion !== candidate.model.draftVersion ||
        check.providerModelId !== candidate.model.id ||
        check.credentialId !== candidate.credential.id ||
        (source.kind === "draft"
          ? check.credentialDraftVersion !== source.draftVersion || check.credentialVersionId !== null
          : check.credentialDraftVersion !== null || check.credentialVersionId !== source.versionId)
      ) {
        return "stale";
      }
      return repeatableRead(prisma, async (tx) => {
        const [connection, model, credential] = await Promise.all([
          tx.providerConnection.findUnique({
            select: { draftVersion: true },
            where: { id: candidate.connection.id }
          }),
          tx.providerModel.findFirst({
            select: { draftVersion: true },
            where: {
              connectionId: candidate.connection.id,
              id: candidate.model.id
            }
          }),
          tx.providerCredential.findFirst({
            include: {
              activeVersion: {
                select: { id: true, revokedAt: true, secretEnvelope: true }
              }
            },
            where: {
              connectionId: candidate.connection.id,
              id: candidate.credential.id
            }
          })
        ]);
        if (
          connection?.draftVersion !== candidate.connection.draftVersion ||
          model?.draftVersion !== candidate.model.draftVersion ||
          !credential ||
          !sourceMatches(candidate, credential)
        ) {
          return "stale" as const;
        }
        await tx.providerDraftCheck.upsert({
          create: {
            checkedAt: check.checkedAt,
            connectionDraftVersion: check.connectionDraftVersion,
            connectionId: candidate.connection.id,
            credentialDraftVersion: check.credentialDraftVersion,
            credentialId: check.credentialId,
            credentialVersionId: check.credentialVersionId,
            evidence: json(check.evidence),
            fingerprint: check.fingerprint,
            modelDraftVersion: check.modelDraftVersion,
            providerModelId: check.providerModelId,
            status: check.status
          },
          update: {
            checkedAt: check.checkedAt,
            evidence: json(check.evidence),
            status: check.status
          },
          where: { fingerprint: check.fingerprint }
        });
        await tx.providerCredential.update({
          data: { testedAt: check.checkedAt },
          where: { id: check.credentialId }
        });
        return "stored" as const;
      });
    },

    async loadActivationCandidate(connectionId) {
      const connection = await prisma.providerConnection.findUnique({
        select: { draftConfig: true, draftVersion: true, family: true, id: true },
        where: { id: connectionId }
      });
      if (!connection || connection.family === "fake") return null;
      const [models, referencedCredentialIds] = await Promise.all([
        prisma.providerModel.findMany({
          select: { draftConfig: true, draftVersion: true, id: true },
          where: { connectionId, enabled: true },
          orderBy: { id: "asc" }
        }),
        currentReferencedCredentialIds(prisma, connectionId)
      ]);
      if (!referencedCredentialIds) return null;
      const credentials = await prisma.providerCredential.findMany({
        include: {
          activeVersion: {
            select: {
              id: true,
              revokedAt: true,
              secretEnvelope: true,
              version: true
            }
          }
        },
        where: { connectionId, id: { in: referencedCredentialIds } },
        orderBy: { id: "asc" }
      });
      return {
        connection: {
          configuration: connection.draftConfig,
          draftVersion: connection.draftVersion,
          family: connection.family,
          id: connection.id
        },
        credentials: credentials.map((credential) => ({
          activeVersion:
            credential.activeVersion?.secretEnvelope && !credential.activeVersion.revokedAt
              ? {
                  envelope: credential.activeVersion.secretEnvelope,
                  id: credential.activeVersion.id,
                  version: credential.activeVersion.version
                }
              : null,
          draftSecretEnvelope: credential.draftSecretEnvelope,
          draftVersion: credential.draftVersion,
          enabled: credential.enabled,
          id: credential.id
        })),
        models: models.map((model) => ({
          configuration: model.draftConfig,
          draftVersion: model.draftVersion,
          id: model.id
        }))
      };
    },

    async loadActiveRefreshCandidate(input) {
      const [connection, model, credential] = await Promise.all([
        prisma.providerConnection.findUnique({
          select: {
            activeConfig: true,
            activeVersion: true,
            displayName: true,
            family: true,
            id: true
          },
          where: { id: input.connectionId }
        }),
        prisma.providerModel.findFirst({
          select: {
            activeConfig: true,
            activeVersion: true,
            connectionId: true,
            displayName: true,
            id: true
          },
          where: { connectionId: input.connectionId, id: input.providerModelId }
        }),
        prisma.providerCredential.findFirst({
          include: {
            activeVersion: {
              select: { id: true, revokedAt: true, secretEnvelope: true }
            }
          },
          where: { connectionId: input.connectionId, id: input.credentialId }
        })
      ]);
      if (
        !connection?.activeConfig || connection.activeVersion < 1 || connection.family === "fake" ||
        !model?.activeConfig || model.activeVersion < 1 ||
        !credential?.activeVersionId || credential.activeVersionId !== credential.activeVersion?.id ||
        credential.activeVersion.revokedAt || !credential.activeVersion.secretEnvelope
      ) {
        return null;
      }
      return {
        connection: {
          configuration: connection.activeConfig,
          displayName: connection.displayName,
          family: connection.family,
          id: connection.id,
          version: connection.activeVersion
        },
        credential: {
          envelope: credential.activeVersion.secretEnvelope,
          id: credential.id,
          versionId: credential.activeVersion.id
        },
        model: {
          configuration: model.activeConfig,
          displayName: model.displayName,
          id: model.id,
          version: model.activeVersion
        }
      };
    },

    async recordActiveRefreshFailureCas(input) {
      return repeatableRead(prisma, async (tx) => {
        const [connection, model, credential] = await Promise.all([
          tx.providerConnection.findUnique({
            select: { activeVersion: true },
            where: { id: input.candidate.connection.id }
          }),
          tx.providerModel.findFirst({
            select: { activeVersion: true },
            where: {
              connectionId: input.candidate.connection.id,
              id: input.candidate.model.id
            }
          }),
          tx.providerCredential.findFirst({
            include: { activeVersion: { select: { revokedAt: true, secretEnvelope: true } } },
            where: {
              connectionId: input.candidate.connection.id,
              id: input.candidate.credential.id
            }
          })
        ]);
        if (
          connection?.activeVersion !== input.candidate.connection.version ||
          model?.activeVersion !== input.candidate.model.version ||
          credential?.activeVersionId !== input.candidate.credential.versionId ||
          credential.activeVersion?.revokedAt || !credential.activeVersion?.secretEnvelope
        ) return "stale" as const;
        await tx.providerModelCredentialCheck.updateMany({
          data: {
            latestRefreshError: json({ code: "provider_refresh_failed", version: 1 }),
            refreshFailedAt: input.failedAt
          },
          where: {
            connectionId: input.candidate.connection.id,
            connectionVersion: input.candidate.connection.version,
            credentialId: input.candidate.credential.id,
            credentialVersionId: input.candidate.credential.versionId,
            modelVersion: input.candidate.model.version,
            providerModelId: input.candidate.model.id
          }
        });
        return "stored" as const;
      });
    },

    async storeActiveRefreshCas(input) {
      return repeatableRead(prisma, async (tx) => {
        const [connection, model, credential] = await Promise.all([
          tx.providerConnection.findUnique({
            select: { activeVersion: true },
            where: { id: input.candidate.connection.id }
          }),
          tx.providerModel.findFirst({
            select: { activeVersion: true },
            where: {
              connectionId: input.candidate.connection.id,
              id: input.candidate.model.id
            }
          }),
          tx.providerCredential.findFirst({
            include: { activeVersion: { select: { revokedAt: true, secretEnvelope: true } } },
            where: {
              connectionId: input.candidate.connection.id,
              id: input.candidate.credential.id
            }
          })
        ]);
        if (
          connection?.activeVersion !== input.candidate.connection.version ||
          model?.activeVersion !== input.candidate.model.version ||
          credential?.activeVersionId !== input.candidate.credential.versionId ||
          credential.activeVersion?.revokedAt || !credential.activeVersion?.secretEnvelope
        ) return "stale" as const;
        await tx.providerModelCredentialCheck.upsert({
          create: {
            checkedAt: input.checkedAt,
            connectionId: input.candidate.connection.id,
            connectionVersion: input.candidate.connection.version,
            credentialId: input.candidate.credential.id,
            credentialVersionId: input.candidate.credential.versionId,
            evidence: json(input.evidence),
            modelVersion: input.candidate.model.version,
            providerModelId: input.candidate.model.id,
            status: input.status
          },
          update: {
            checkedAt: input.checkedAt,
            evidence: json(input.evidence),
            latestRefreshError: Prisma.DbNull,
            refreshFailedAt: null,
            status: input.status
          },
          where: {
            providerModelId_credentialVersionId_connectionVersion_modelVersion: {
              connectionVersion: input.candidate.connection.version,
              credentialVersionId: input.candidate.credential.versionId,
              modelVersion: input.candidate.model.version,
              providerModelId: input.candidate.model.id
            }
          }
        });
        return "stored" as const;
      });
    },

    async loadDiscoveryCandidate(input) {
      const connection = await prisma.providerConnection.findUnique({
        select: { draftConfig: true, family: true, id: true },
        where: { id: input.connectionId }
      });
      if (!connection || connection.family === "fake") return null;
      const credential = await prisma.providerCredential.findFirst({
        include: {
          activeVersion: {
            select: { id: true, revokedAt: true, secretEnvelope: true }
          }
        },
        where: { connectionId: input.connectionId, id: input.credentialId }
      });
      if (!credential) return null;
      let keyless = false;
      try {
        keyless = normalizeProviderConnectionConfiguration(
          connection.draftConfig
        ).authenticationMode === "none";
      } catch {
        return null;
      }
      const activeNoAuth = keyless && Boolean(
        credential.activeVersion && !credential.activeVersion.revokedAt
      );
      const source = credential.draftSecretEnvelope
        ? {
            draftVersion: credential.draftVersion,
            envelope: credential.draftSecretEnvelope,
            kind: "draft" as const
          }
        : credential.activeVersion?.secretEnvelope && !credential.activeVersion.revokedAt
          ? {
              envelope: credential.activeVersion.secretEnvelope,
              kind: "active" as const,
              versionId: credential.activeVersion.id
            }
          : null;
      if (!source && !activeNoAuth) return null;
      return {
        connection: {
          configuration: connection.draftConfig,
          family: connection.family,
          id: connection.id
        },
        credential: { id: credential.id, source }
      };
    },

    async activateConnectionCas(input) {
      try {
        return await repeatableRead(prisma, async (tx) => {
        const connection = await tx.providerConnection.findUnique({
          select: {
            displayName: true,
            draftConfig: true,
            draftVersion: true,
            family: true,
            id: true,
            templateKey: true
          },
          where: { id: input.connection.id }
        });
        if (!connection) return "not_found" as const;
        if (connection.draftVersion !== input.connection.draftVersion) return "stale" as const;

        const [models, referencedCredentialIds, credentials] = await Promise.all([
          tx.providerModel.findMany({
            select: { draftVersion: true, id: true },
            where: { connectionId: input.connection.id, enabled: true }
          }),
          currentReferencedCredentialIds(tx, input.connection.id),
          tx.providerCredential.findMany({
            include: {
              activeVersion: {
                select: { id: true, revokedAt: true, secretEnvelope: true }
              }
            },
            where: {
              connectionId: input.connection.id,
              id: { in: input.credentials.map(({ id }) => id) }
            }
          })
        ]);
        if (
          !referencedCredentialIds ||
          !sameStrings(models.map(({ id }) => id), input.models.map(({ id }) => id)) ||
          !sameStrings(referencedCredentialIds, input.credentials.map(({ id }) => id)) ||
          !input.models.every((expected) =>
            models.some((current) => current.id === expected.id && current.draftVersion === expected.draftVersion)
          ) ||
          credentials.length !== input.credentials.length
        ) {
          return "stale" as const;
        }

        for (const expected of input.credentials) {
          const current = credentials.find(({ id }) => id === expected.id);
          if (!current?.enabled) return "stale" as const;
          if (expected.kind === "draft") {
            if (
              current.draftVersion !== expected.draftVersion ||
              current.draftSecretEnvelope === null
            ) {
              return "stale" as const;
            }
          } else if (
            current.activeVersionId !== expected.versionId ||
            current.activeVersion?.id !== expected.versionId ||
            current.activeVersion.revokedAt ||
            !current.activeVersion.secretEnvelope
          ) {
            return "stale" as const;
          }
        }

        if (
          input.checks.length !== input.models.length * input.credentials.length ||
          !input.models.every((model) => input.credentials.every((credential) =>
            input.checks.some((check) =>
              check.providerModelId === model.id &&
              checkMatchesWrite(check, model.draftVersion, credential, input.connection.draftVersion)
            )
          ))
        ) {
          return "stale" as const;
        }

        const activeVersionIds = new Map<string, string>();
        for (const credential of input.credentials) {
          if (credential.kind === "active") {
            const updated = await tx.providerCredential.updateMany({
              data: { testedAt: credential.checkedAt },
              where: {
                activeVersionId: credential.versionId,
                id: credential.id
              }
            });
            if (updated.count !== 1) throw new ProviderActivationStaleError();
            activeVersionIds.set(credential.id, credential.versionId);
            continue;
          }
          await tx.providerCredentialVersion.create({
            data: {
              activatedAt: input.now,
              credentialId: credential.id,
              id: credential.versionId,
              secretEnvelope: credential.versionEnvelope,
              testEvidence: json(credential.testEvidence),
              testedAt: credential.checkedAt,
              version: credential.draftVersion
            }
          });
          const updated = await tx.providerCredential.updateMany({
            data: {
              activatedAt: input.now,
              activeVersionId: credential.versionId,
              draftSecretEnvelope: null,
              testedAt: credential.checkedAt
            },
            where: {
              draftVersion: credential.draftVersion,
              id: credential.id
            }
          });
          if (updated.count !== 1) throw new ProviderActivationStaleError();
          activeVersionIds.set(credential.id, credential.versionId);
        }

        const connectionUpdated = await tx.providerConnection.updateMany({
          data: {
            activatedAt: input.now,
            activeConfig: json(input.connection.configuration),
            activeVersion: input.connection.draftVersion,
            enabled: input.connection.enable
          },
          where: {
            draftVersion: input.connection.draftVersion,
            id: input.connection.id
          }
        });
        if (connectionUpdated.count !== 1) throw new ProviderActivationStaleError();

        for (const model of input.models) {
          const updated = await tx.providerModel.updateMany({
            data: {
              activatedAt: input.now,
              activeConfig: json(model.configuration),
              activeVersion: model.draftVersion,
              ...modelColumns(model.configuration)
            },
            where: { draftVersion: model.draftVersion, id: model.id }
          });
          if (updated.count !== 1) throw new ProviderActivationStaleError();
        }
        await synchronizeProviderSearch(tx, input, connection);

        const tuples = input.checks.map((check) => ({
          connectionVersion: input.connection.draftVersion,
          credentialVersionId: activeVersionIds.get(check.credentialId) as string,
          modelVersion: check.modelDraftVersion,
          providerModelId: check.providerModelId
        }));
        await tx.providerModelCredentialCheck.deleteMany({
          where: { OR: tuples }
        });
        await tx.providerModelCredentialCheck.createMany({
          data: input.checks.map((check) => ({
            checkedAt: check.checkedAt,
            connectionId: input.connection.id,
            connectionVersion: input.connection.draftVersion,
            credentialId: check.credentialId,
            credentialVersionId: activeVersionIds.get(check.credentialId) as string,
            evidence: json(check.evidence),
            modelVersion: check.modelDraftVersion,
            providerModelId: check.providerModelId,
            status: check.status
          }))
        });
          await cleanupProviderReferences(tx, { connectionId: input.connection.id }, input.now);
          return "updated" as const;
        });
      } catch (error) {
        if (
          error instanceof ProviderActivationStaleError ||
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        ) {
          return "stale";
        }
        throw error;
      }
    },

    async assignGroupCredential(input) {
      return repeatableRead(prisma, async (tx) => {
        const [group, credential] = await Promise.all([
          tx.group.findFirst({
            select: { id: true },
            where: { archivedAt: null, id: input.groupId }
          }),
          tx.providerCredential.findFirst({
            select: { id: true },
            where: { connectionId: input.connectionId, id: input.credentialId }
          })
        ]);
        if (!group) return "group_not_found" as const;
        if (!credential) return "credential_not_found" as const;
        await tx.providerGroupCredentialAssignment.upsert({
          create: input,
          update: { credentialId: input.credentialId },
          where: {
            connectionId_groupId: {
              connectionId: input.connectionId,
              groupId: input.groupId
            }
          }
        });
        return "assigned" as const;
      });
    },

    async revokeGroupCredential(input) {
      const removed = await prisma.providerGroupCredentialAssignment.deleteMany({ where: input });
      return removed.count === 1 ? "revoked" : "not_found";
    },

    async setDefaultCredential(input) {
      return repeatableRead(prisma, async (tx) => {
        const connection = await tx.providerConnection.findUnique({
          select: { id: true },
          where: { id: input.connectionId }
        });
        if (!connection) return "not_found" as const;
        if (input.credentialId) {
          const credential = await tx.providerCredential.findFirst({
            select: { id: true },
            where: { connectionId: input.connectionId, id: input.credentialId }
          });
          if (!credential) return "credential_not_found" as const;
        }
        await tx.providerConnection.update({
          data: { defaultCredentialId: input.credentialId },
          where: { id: input.connectionId }
        });
        return "updated" as const;
      });
    },

    async disable(target, id) {
      const updated = target === "connection"
        ? await prisma.providerConnection.updateMany({
            data: { enabled: false },
            where: { family: { not: "fake" }, id }
          })
        : target === "credential"
          ? await prisma.providerCredential.updateMany({
              data: { enabled: false },
              where: { connection: { family: { not: "fake" } }, id }
            })
          : await prisma.providerModel.updateMany({
              data: { enabled: false },
              where: { connection: { family: { not: "fake" } }, id }
            });
      return updated.count === 1 ? "disabled" : "not_found";
    },

    async enable(target, id) {
      const updated = target === "connection"
        ? await prisma.providerConnection.updateMany({
            data: { enabled: true },
            where: { family: { not: "fake" }, id }
          })
        : target === "credential"
          ? await prisma.providerCredential.updateMany({
              data: { enabled: true },
              where: { connection: { family: { not: "fake" } }, id }
            })
          : await prisma.providerModel.updateMany({
              data: { enabled: true },
              where: { connection: { family: { not: "fake" } }, id }
            });
      return updated.count === 1 ? "enabled" : "not_found";
    },

    withLockedCredential(credentialId, credentialVersionId, consume) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          credentialId: string;
          id: string;
          revokedAt: Date | null;
          secretEnvelope: string | null;
        }>>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt", "secretEnvelope"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${credentialId}
            AND "id" = ${credentialVersionId}
          FOR SHARE
        `);
        return rows[0] ? consume(rows[0]) : null;
      });
    },

    async revokeCredentialVersion(input) {
      return repeatableRead(prisma, async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          credentialId: string;
          id: string;
          revokedAt: Date | null;
        }>>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${input.credentialId}
            AND "id" = ${input.versionId}
          FOR UPDATE
        `);
        if (!rows[0]) return "not_found" as const;
        await tx.providerCredentialVersion.update({
          data: {
            revokedAt: rows[0].revokedAt ?? input.now,
            ...(input.clearSecret ? { secretEnvelope: null } : {})
          },
          where: { id: input.versionId }
        });
        return "revoked" as const;
      });
    },

    async deleteModel(modelId) {
      return repeatableRead(prisma, async (tx) => {
        const model = await tx.providerModel.findUnique({
          select: { enabled: true, templateKey: true },
          where: { id: modelId }
        });
        if (!model) return { status: "not_found" } as const;
        // Use the same policy-first lock order as installation-default writes.
        // This closes the check/delete window in which a new restrictive
        // reference could otherwise turn a classified result into an FK error.
        await lockInstallationModelPolicies(tx);
        await cleanupProviderReferences(tx, { providerModelId: modelId });
        const [
          accessGrants,
          installationDefaults,
          systemModelRoles,
          userDefaults,
          chatDefaults,
          searchReferences,
          searchRevisionReferences,
          assistantRevisions,
          runBindings,
          memoryBindings
        ] = await Promise.all([
          tx.accessGrant.count({ where: { providerModelId: modelId } }),
          tx.modelPolicy.count({ where: { defaultProviderModelId: modelId } }),
          tx.systemModelPolicy.count({ where: { providerModelId: modelId } }),
          tx.userSettings.count({ where: { defaultProviderModelId: modelId } }),
          tx.chat.count({ where: { defaultProviderModelId: modelId } }),
          tx.searchStrategy.count({ where: { providerModelId: modelId } }),
          tx.searchIntegrationRevision.count({ where: { providerModelId: modelId } }),
          tx.assistantRevision.count({ where: { providerModelId: modelId } }),
          tx.providerRunBinding.count({ where: { providerModelId: modelId } }),
          countBlockingMemoryExecutionBindings(tx, { providerModelId: modelId })
        ]);
        const blocked = blockers([
          model.enabled ? { count: 1, kind: "resource_enabled" } : null,
          model.templateKey ? { count: 1, kind: "code_owned_template" } : null,
          accessGrants ? { count: accessGrants, kind: "access_grants" } : null,
          installationDefaults
            ? { count: installationDefaults, kind: "installation_default" }
            : null,
          systemModelRoles ? { count: systemModelRoles, kind: "system_model" } : null,
          userDefaults ? { count: userDefaults, kind: "user_defaults" } : null,
          chatDefaults ? { count: chatDefaults, kind: "chat_defaults" } : null,
          searchReferences ? { count: searchReferences, kind: "search_references" } : null,
          searchRevisionReferences
            ? { count: searchRevisionReferences, kind: "search_revision_references" }
            : null,
          assistantRevisions ? { count: assistantRevisions, kind: "assistant_revisions" } : null,
          runBindings ? { count: runBindings, kind: "run_bindings" } : null,
          memoryBindings ? { count: memoryBindings, kind: "memory_bindings" } : null
        ]);
        const blockedResult = conflict(blocked);
        if (blockedResult) return blockedResult;
        await tx.providerModel.delete({ where: { id: modelId } });
        return { status: "deleted" } as const;
      });
    },

    async deleteCredential(credentialId) {
      return repeatableRead(prisma, async (tx) => {
        const credential = await tx.providerCredential.findUnique({
          select: { enabled: true },
          where: { id: credentialId }
        });
        if (!credential) return { status: "not_found" } as const;
        await cleanupProviderReferences(tx, { credentialId });
        const [
          connectionDefault,
          groupAssignments,
          userAssignments,
          runBindings,
          memoryBindings
        ] = await Promise.all([
          tx.providerConnection.count({ where: { defaultCredentialId: credentialId } }),
          tx.providerGroupCredentialAssignment.count({ where: { credentialId } }),
          tx.providerUserCredentialAssignment.count({ where: { credentialId } }),
          tx.providerRunBinding.count({ where: { credentialId } }),
          countBlockingMemoryExecutionBindings(tx, { credentialId })
        ]);
        const blocked = blockers([
          credential.enabled ? { count: 1, kind: "resource_enabled" } : null,
          connectionDefault ? { count: connectionDefault, kind: "connection_default" } : null,
          groupAssignments ? { count: groupAssignments, kind: "group_assignments" } : null,
          userAssignments ? { count: userAssignments, kind: "user_assignments" } : null,
          runBindings ? { count: runBindings, kind: "run_bindings" } : null,
          memoryBindings ? { count: memoryBindings, kind: "memory_bindings" } : null
        ]);
        const blockedResult = conflict(blocked);
        if (blockedResult) return blockedResult;
        await tx.providerCredential.update({
          data: { activeVersionId: null },
          where: { id: credentialId }
        });
        await tx.providerCredentialVersion.deleteMany({ where: { credentialId } });
        await tx.providerCredential.delete({ where: { id: credentialId } });
        return { status: "deleted" } as const;
      });
    },

    async deleteConnection(connectionId) {
      return serializable(prisma, async (tx) => {
        const connection = await tx.providerConnection.findUnique({
          select: { enabled: true, family: true, templateKey: true },
          where: { id: connectionId }
        });
        if (!connection) return { status: "not_found" } as const;
        await lockInstallationModelPolicies(tx);
        await cleanupProviderReferences(tx, { connectionId });

        if (connection.family === "openai_compatible" && !connection.templateKey) {
          const [
            models,
            credentials,
            logicalSearchReferences,
            runBindings,
            memoryBindings
          ] = await Promise.all([
            tx.providerModel.findMany({
              select: { id: true },
              where: { connectionId }
            }),
            tx.providerCredential.findMany({
              select: { id: true },
              where: { connectionId }
            }),
            tx.searchOption.count({
              where: { sourceConnectionId: connectionId }
            }),
            tx.providerRunBinding.count({ where: { connectionId } }),
            countBlockingMemoryExecutionBindings(tx, { connectionId })
          ]);
          const modelIds = models.map(({ id }) => id);
          const credentialIds = credentials.map(({ id }) => id);
          const [searchReferences, searchRevisionReferences, assistantRevisions] = await Promise.all([
            tx.searchStrategy.count({
              where: { providerModelId: { in: modelIds } }
            }),
            tx.searchIntegrationRevision.count({
              where: { providerModelId: { in: modelIds } }
            }),
            tx.assistantRevision.count({
              where: { providerModelId: { in: modelIds } }
            })
          ]);
          const totalSearchReferences = logicalSearchReferences + searchReferences;
          const hardBlockers = blockers([
            totalSearchReferences
              ? { count: totalSearchReferences, kind: "search_references" }
              : null,
            searchRevisionReferences
              ? { count: searchRevisionReferences, kind: "search_revision_references" }
              : null,
            assistantRevisions
              ? { count: assistantRevisions, kind: "assistant_revisions" }
              : null,
            runBindings ? { count: runBindings, kind: "run_bindings" } : null,
            memoryBindings ? { count: memoryBindings, kind: "memory_bindings" } : null
          ]);
          const hardConflict = conflict(hardBlockers);
          if (hardConflict) return hardConflict;

          await tx.userSettings.updateMany({
            data: { defaultProviderModelId: null },
            where: { defaultProviderModelId: { in: modelIds } }
          });
          await tx.modelPolicy.updateMany({
            data: {
              defaultProviderModelId: null,
              updatedByUserId: null,
              version: { increment: 1 }
            },
            where: { defaultProviderModelId: { in: modelIds } }
          });
          await tx.systemModelPolicy.updateMany({
            data: {
              providerModelId: null,
              updatedByUserId: null,
              version: { increment: 1 }
            },
            where: { providerModelId: { in: modelIds } }
          });
          await tx.chat.updateMany({
            data: { defaultProviderModelId: null },
            where: { defaultProviderModelId: { in: modelIds } }
          });
          await tx.providerConnection.update({
            data: { defaultCredentialId: null },
            where: { id: connectionId }
          });
          await tx.providerGroupCredentialAssignment.deleteMany({ where: { connectionId } });
          await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId } });
          await tx.accessGrant.deleteMany({
            where: {
              OR: [
                { providerConnectionId: connectionId },
                { providerModelId: { in: modelIds } }
              ]
            }
          });
          await tx.providerDraftCheck.deleteMany({ where: { connectionId } });
          await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
          await tx.providerCredential.updateMany({
            data: { activeVersionId: null },
            where: { id: { in: credentialIds } }
          });
          await tx.providerCredentialVersion.deleteMany({
            where: { credentialId: { in: credentialIds } }
          });
          await tx.providerCredential.deleteMany({ where: { connectionId } });
          await tx.providerModel.deleteMany({ where: { connectionId } });
          await tx.providerConnection.delete({ where: { id: connectionId } });
          return { status: "deleted" } as const;
        }

        const [
          models,
          credentials,
          accessGrants,
          activeChildren,
          searchReferences,
          runBindings,
          memoryBindings
        ] = await Promise.all([
          tx.providerModel.count({ where: { connectionId } }),
          tx.providerCredential.count({ where: { connectionId } }),
          tx.accessGrant.count({ where: { providerConnectionId: connectionId } }),
          tx.providerModel.count({ where: { activeVersion: { gt: 0 }, connectionId } }),
          tx.searchOption.count({ where: { sourceConnectionId: connectionId } }),
          tx.providerRunBinding.count({ where: { connectionId } }),
          countBlockingMemoryExecutionBindings(tx, { connectionId })
        ]);
        const blocked = blockers([
          connection.enabled ? { count: 1, kind: "resource_enabled" } : null,
          connection.templateKey ? { count: 1, kind: "code_owned_template" } : null,
          models ? { count: models, kind: "models" } : null,
          credentials ? { count: credentials, kind: "credentials" } : null,
          accessGrants ? { count: accessGrants, kind: "access_grants" } : null,
          activeChildren ? { count: activeChildren, kind: "active_child_configuration" } : null,
          searchReferences ? { count: searchReferences, kind: "search_references" } : null,
          runBindings ? { count: runBindings, kind: "run_bindings" } : null,
          memoryBindings ? { count: memoryBindings, kind: "memory_bindings" } : null
        ]);
        const blockedResult = conflict(blocked);
        if (blockedResult) return blockedResult;
        await tx.providerConnection.delete({ where: { id: connectionId } });
        return { status: "deleted" } as const;
      });
    }
  };
}

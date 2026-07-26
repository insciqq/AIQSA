import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { RunProfileId } from "../../../contracts/runProfiles";
import { defaultProviderModels } from "../../../domain/catalog";
import {
  providerModelTemplateId,
  type ProviderModelTemplateKey
} from "../../../domain/providerTemplates";
import {
  DEFAULT_RUN_PROFILE_CONFIGURATIONS,
  isRunProfileId
} from "../../../domain/runProfiles";
import {
  filterAvailableProviderModels,
  filterExposedProviderModels,
  type CatalogProviderModelRow
} from "../../catalog/prismaCatalogData";
import { resolveEntitlements } from "../../auth/entitlements";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import {
  adminProviderQuickSetupPolicy,
  providerModelConfigurationFromCatalogEntry
} from "./quickSetupPolicy";
import type {
  AdminProviderQuickSetupActor,
  AdminProviderQuickSetupCommitPlan,
  AdminProviderQuickSetupCommitResult,
  AdminProviderQuickSetupInspection,
  AdminProviderQuickSetupRepository
} from "./quickSetupRepositoryContract";

type QuickSetupDb = Pick<
  Prisma.TransactionClient,
  | "accessGrant"
  | "authSession"
  | "providerConnection"
  | "providerCredential"
  | "providerCredentialVersion"
  | "providerDraftCheck"
  | "providerModel"
  | "providerModelCredentialCheck"
  | "runProfile"
  | "user"
  | "userGroup"
  | "userSettings"
>;

type QuickSetupRepositoryOptions = Readonly<{
  exposeFake?: boolean;
}>;

class QuickSetupCatalogUnavailableError extends Error {}

function isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  return error.code === "P2034" || (
    error.code === "P2010" &&
    error.meta?.code === "40001"
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalConnectionConfig(value: unknown, expected: unknown): boolean {
  try {
    return sameJson(
      normalizeProviderConnectionConfiguration(value),
      normalizeProviderConnectionConfiguration(expected)
    );
  } catch {
    return false;
  }
}

function canonicalModelConfig(value: unknown, expected: ProviderModelConfiguration): boolean {
  try {
    return sameJson(normalizeProviderModelConfiguration(value), expected);
  } catch {
    return false;
  }
}

function codeOwnedModel(templateKey: string, provider: string) {
  const id = providerModelTemplateId(templateKey);
  if (!id) return null;
  const [templateProvider, ...modelParts] = templateKey.split(":");
  if (templateProvider !== provider) return null;
  const upstreamModelId = modelParts.join(":");
  const model = defaultProviderModels.find(
    (candidate) => candidate.provider === provider && candidate.modelId === upstreamModelId
  );
  if (!model || model.adapterKind === "fake") return null;
  return {
    configuration: providerModelConfigurationFromCatalogEntry(model),
    id,
    model,
    templateKey: templateKey as ProviderModelTemplateKey
  };
}

function modelLegacyFields(configuration: ProviderModelConfiguration) {
  return {
    capabilities: json(configuration.capabilities),
    contextWindow: configuration.capabilities.contextWindow ?? 1,
    defaultParams: json(configuration.defaultParams),
    modelId: configuration.upstreamModelId,
    supportsNativeSearch: configuration.capabilities.nativeSearch,
    supportsPdf: configuration.capabilities.pdf,
    supportsReasoning: configuration.capabilities.reasoning,
    supportsVision: configuration.capabilities.vision
  };
}

type QuickSetupProfileFill = Readonly<{
  id: RunProfileId;
  reasoningEffort: string;
  reasoningMode: string;
}>;

export function planAdminProviderQuickSetupProfileFills(input: Readonly<{
  mode: "initial" | "recovery" | "replacement";
  profiles: ReadonlyArray<Readonly<{
    enabled: boolean;
    id: string;
    providerModelId: string | null;
    updatedByUserId: string | null;
    version: number;
  }>>;
  templateKey: ProviderModelTemplateKey;
}>): QuickSetupProfileFill[] {
  if (input.mode !== "initial") return [];
  return input.profiles.flatMap((profile) => {
    if (!isRunProfileId(profile.id)) return [];
    const recipe = DEFAULT_RUN_PROFILE_CONFIGURATIONS.find(
      (candidate) => candidate.id === profile.id &&
        candidate.targetTemplateKey === input.templateKey
    );
    if (!recipe || profile.enabled || profile.providerModelId !== null ||
      profile.version !== 1 || profile.updatedByUserId !== null) {
      return [];
    }
    return [{
      id: profile.id,
      reasoningEffort: recipe.reasoningEffort,
      reasoningMode: recipe.reasoningMode
    }];
  });
}

async function loadQuickSetupState(
  db: QuickSetupDb,
  input: AdminProviderQuickSetupActor & Readonly<{
    now: Date;
    provider: "anthropic" | "openai" | "openrouter";
  }>
) {
  const policy = adminProviderQuickSetupPolicy(input.provider);
  const [actor, session, settings, profiles, connections, grants] = await Promise.all([
    db.user.findUnique({
      select: { id: true, role: true, status: true, updatedAt: true },
      where: { id: input.userId }
    }),
    db.authSession.findUnique({
      select: { expiresAt: true, id: true, revokedAt: true, userId: true },
      where: { id: input.sessionId }
    }),
    db.userSettings.findUnique({
      select: { defaultProviderModelId: true, id: true, updatedAt: true },
      where: { userId: input.userId }
    }),
    db.runProfile.findMany({ orderBy: { id: "asc" } }),
    db.providerConnection.findMany({
      include: {
        credentials: {
          include: {
            activeVersion: {
              select: {
                id: true,
                revokedAt: true,
                secretEnvelope: true,
                testedAt: true,
                version: true
              }
            },
            groupAssignments: {
              orderBy: [{ groupId: "asc" }, { credentialId: "asc" }],
              select: { connectionId: true, credentialId: true, groupId: true, updatedAt: true }
            },
            versions: {
              orderBy: [{ version: "asc" }, { id: "asc" }],
              select: {
                activatedAt: true,
                credentialId: true,
                id: true,
                revokedAt: true,
                secretEnvelope: true,
                testedAt: true,
                version: true
              }
            }
          },
          orderBy: { id: "asc" }
        },
        models: {
          include: {
            activeCredentialChecks: {
              orderBy: [{ checkedAt: "desc" }, { id: "asc" }],
              select: {
                checkedAt: true,
                connectionId: true,
                connectionVersion: true,
                credentialId: true,
                credentialVersionId: true,
                id: true,
                modelVersion: true,
                providerModelId: true,
                status: true
              }
            },
            draftChecks: {
              orderBy: { id: "asc" },
              select: {
                checkedAt: true,
                connectionDraftVersion: true,
                connectionId: true,
                credentialDraftVersion: true,
                credentialId: true,
                credentialVersionId: true,
                evidence: true,
                fingerprint: true,
                id: true,
                modelDraftVersion: true,
                providerModelId: true,
                status: true
              }
            }
          },
          orderBy: { id: "asc" }
        }
      },
      orderBy: { id: "asc" },
      where: {
        OR: [
          { family: policy.provider },
          { id: policy.connection.id },
          { templateKey: policy.connection.templateKey }
        ]
      }
    }),
    db.accessGrant.findMany({
      orderBy: { id: "asc" },
      where: {
        OR: [
          { providerConnection: { family: policy.provider } },
          { providerModel: { connection: { family: policy.provider } } }
        ]
      }
    })
  ]);

  const canonicalConnections = connections.filter((candidate) =>
    candidate.id === policy.connection.id ||
    candidate.templateKey === policy.connection.templateKey
  );
  const connection = canonicalConnections.length === 1 ? canonicalConnections[0] : null;
  let advancedReason: "ambiguous" | "custom" | "team" | null =
    connections.length > 1 || canonicalConnections.length > 1
      ? "ambiguous"
      : connections.length === 1 && canonicalConnections.length === 0
        ? "custom"
        : null;
  if (connection && (
    connection.id !== policy.connection.id ||
    connection.templateKey !== policy.connection.templateKey ||
    connection.family !== policy.provider ||
    connection.displayName !== policy.connection.displayName ||
    connection.unassignedPolicy !== "use_default" ||
    connection.draftVersion !== 1 ||
    !canonicalConnectionConfig(connection.draftConfig, policy.connection.configuration) ||
    (connection.activeConfig === null && (
      connection.activeVersion !== 0 || connection.activatedAt !== null
    )) ||
    (connection.activeConfig !== null && (
      connection.activeVersion !== connection.draftVersion ||
      !canonicalConnectionConfig(connection.activeConfig, policy.connection.configuration)
    ))
  )) {
    advancedReason = "custom";
  }

  const credentials = connection?.credentials ?? [];
  if (credentials.length > 1) advancedReason = "ambiguous";
  const primary = credentials.length === 1 ? credentials[0] : null;
  const canonicalVersionHistory = !primary || (
    Number.isSafeInteger(primary.draftVersion) && primary.draftVersion >= 0 &&
    primary.versions.length === primary.draftVersion &&
    primary.versions.every((version, index) =>
      version.credentialId === primary.id &&
      version.version === index + 1 &&
      version.secretEnvelope !== null &&
      version.revokedAt === null
    )
  );
  const canonicalActiveVersion = !primary
    ? true
    : primary.activeVersion === null
      ? primary.activeVersionId === null && primary.draftVersion === 0
      : primary.activeVersionId === primary.activeVersion.id &&
        primary.activeVersion.version === primary.draftVersion &&
        primary.activeVersion.secretEnvelope !== null &&
        primary.activeVersion.revokedAt === null;
  if (primary && (
    primary.label !== "Primary" ||
    primary.draftSecretEnvelope !== null ||
    primary.groupAssignments.length > 0 ||
    !canonicalVersionHistory ||
    !canonicalActiveVersion ||
    (connection?.defaultCredentialId !== null && connection?.defaultCredentialId !== primary.id)
  )) {
    advancedReason = primary.groupAssignments.length > 0 ? "team" : "custom";
  }

  if (grants.some((grant) => grant.groupId !== null || grant.userId !== input.userId)) {
    advancedReason = "team";
  }

  const activeModels = [] as Array<{
    checkedAt: Date | null;
    displayName: string;
    enabled: boolean;
    id: string;
    templateKey: ProviderModelTemplateKey;
  }>;
  for (const model of connection?.models ?? []) {
    const canonical = model.templateKey
      ? codeOwnedModel(model.templateKey, policy.provider)
      : null;
    if (
      !canonical || model.id !== canonical.id || model.provider !== policy.provider ||
      model.displayName !== canonical.model.displayName || model.draftVersion !== 1 ||
      !canonicalModelConfig(model.draftConfig, canonical.configuration)
    ) {
      advancedReason = "custom";
      continue;
    }
    if (model.draftChecks.length > 0) {
      advancedReason = "custom";
    }
    const pristine = !model.enabled && model.activeVersion === 0 &&
      model.activeConfig === null && model.activatedAt === null &&
      model.activeCredentialChecks.length === 0 && model.draftChecks.length === 0;
    if (pristine) continue;
    const activeCanonical = model.activeVersion === model.draftVersion &&
      model.activeVersion > 0 && model.activeConfig !== null &&
      model.activatedAt !== null && canonicalModelConfig(model.activeConfig, canonical.configuration);
    const policyCandidate = policy.candidates.some(
      (candidate) => candidate.templateKey === canonical.templateKey
    );
    if (!activeCanonical || !policyCandidate) {
      advancedReason = "custom";
      continue;
    }
    const activeVersionId = primary?.activeVersion?.id ?? null;
    const matchingCheck = activeVersionId
      ? model.activeCredentialChecks.find((check) =>
          check.status === "available" &&
          check.connectionId === connection?.id &&
          check.providerModelId === model.id &&
          check.credentialId === primary?.id &&
          check.credentialVersionId === activeVersionId &&
          check.connectionVersion === connection?.activeVersion &&
          check.modelVersion === model.activeVersion
        )
      : null;
    activeModels.push({
      checkedAt: matchingCheck?.checkedAt ?? null,
      displayName: model.displayName,
      enabled: model.enabled,
      id: model.id,
      templateKey: canonical.templateKey
    });
  }
  if (activeModels.length > 1) advancedReason = "ambiguous";
  const selectedModel = activeModels.length === 1 ? activeModels[0] : null;

  const actingUserGrants = grants.filter(
    (grant) => grant.userId === input.userId && grant.groupId === null
  );
  const directModelGrants = selectedModel
    ? actingUserGrants.filter((grant) => grant.providerModelId === selectedModel.id)
    : [];
  if (
    actingUserGrants.some((grant) =>
      grant.providerConnectionId !== null ||
      grant.searchStrategy !== null ||
      !selectedModel || grant.providerModelId !== selectedModel.id
    ) ||
    (selectedModel && (
      directModelGrants.length !== 1 || !directModelGrants[0]?.enabled
    ))
  ) {
    advancedReason = directModelGrants.length > 1 ? "ambiguous" : "custom";
  }
  const directGrantReady = directModelGrants.length === 1 && directModelGrants[0].enabled;
  const credentialReady = Boolean(
    primary?.enabled && primary.activeVersion && !primary.activeVersion.revokedAt &&
    primary.activeVersion.secretEnvelope
  );
  const ready = Boolean(
    connection?.enabled && connection.activeConfig && connection.activeVersion > 0 &&
    connection.activatedAt &&
    connection.defaultCredentialId === primary?.id && selectedModel && selectedModel.checkedAt &&
    selectedModel.enabled && credentialReady && directGrantReady
  );
  const configured = Boolean(
    connection && (connection.enabled || connection.activeVersion > 0 || primary || selectedModel)
  );
  const state = advancedReason
    ? "advanced_required" as const
    : ready
      ? "ready" as const
      : configured
        ? "needs_attention" as const
        : "not_configured" as const;

  const actorAuthorized = actor?.role === "admin" && actor.status === "active" &&
    session?.userId === input.userId && !session.revokedAt && session.expiresAt > input.now;
  const mode = advancedReason || !actorAuthorized || !settings
    ? null
    : ready
      ? "replacement" as const
      : configured
        ? "recovery" as const
        : "initial" as const;

  const safeFingerprint = fingerprint({
    actor: actor ? {
      id: actor.id,
      role: actor.role,
      status: actor.status,
      updatedAt: actor.updatedAt
    } : null,
    connections: connections.map((candidateConnection) => ({
      activeConfig: candidateConnection.activeConfig,
      activeVersion: candidateConnection.activeVersion,
      activatedAt: candidateConnection.activatedAt,
      credentials: candidateConnection.credentials.map((credential) => ({
        activeVersion: credential.activeVersion ? {
          id: credential.activeVersion.id,
          revokedAt: credential.activeVersion.revokedAt,
          secretEnvelopeFingerprint: credential.activeVersion.secretEnvelope === null
            ? null
            : fingerprint(credential.activeVersion.secretEnvelope),
          testedAt: credential.activeVersion.testedAt,
          version: credential.activeVersion.version
        } : null,
        activeVersionId: credential.activeVersionId,
        draftSecretConfigured: credential.draftSecretEnvelope !== null,
        draftVersion: credential.draftVersion,
        enabled: credential.enabled,
        groupAssignments: credential.groupAssignments,
        id: credential.id,
        label: credential.label,
        updatedAt: credential.updatedAt,
        versions: credential.versions.map((version) => ({
          activatedAt: version.activatedAt,
          credentialId: version.credentialId,
          id: version.id,
          revokedAt: version.revokedAt,
          secretEnvelopeFingerprint: version.secretEnvelope === null
            ? null
            : fingerprint(version.secretEnvelope),
          testedAt: version.testedAt,
          version: version.version
        }))
      })),
      defaultCredentialId: candidateConnection.defaultCredentialId,
      displayName: candidateConnection.displayName,
      draftConfig: candidateConnection.draftConfig,
      draftVersion: candidateConnection.draftVersion,
      enabled: candidateConnection.enabled,
      family: candidateConnection.family,
      id: candidateConnection.id,
      models: candidateConnection.models.map((model) => ({
        activeChecks: model.activeCredentialChecks,
        activeConfig: model.activeConfig,
        activeVersion: model.activeVersion,
        activatedAt: model.activatedAt,
        displayName: model.displayName,
        draftConfig: model.draftConfig,
        draftVersion: model.draftVersion,
        enabled: model.enabled,
        id: model.id,
        draftChecks: model.draftChecks.map((check) => ({
          checkedAt: check.checkedAt,
          connectionDraftVersion: check.connectionDraftVersion,
          connectionId: check.connectionId,
          credentialDraftVersion: check.credentialDraftVersion,
          credentialId: check.credentialId,
          credentialVersionId: check.credentialVersionId,
          evidenceFingerprint: check.evidence === null ? null : fingerprint(check.evidence),
          fingerprint: check.fingerprint,
          id: check.id,
          modelDraftVersion: check.modelDraftVersion,
          providerModelId: check.providerModelId,
          status: check.status
        })),
        templateKey: model.templateKey,
        updatedAt: model.updatedAt
      })),
      templateKey: candidateConnection.templateKey,
      unassignedPolicy: candidateConnection.unassignedPolicy,
      updatedAt: candidateConnection.updatedAt
    })),
    grants: grants.map((grant) => ({
      enabled: grant.enabled,
      groupId: grant.groupId,
      id: grant.id,
      providerConnectionId: grant.providerConnectionId,
      providerModelId: grant.providerModelId,
      updatedAt: grant.updatedAt,
      userId: grant.userId
    })),
    profiles: mode === "initial"
      ? profiles.map((profile) => ({
          description: profile.description,
          enabled: profile.enabled,
          id: profile.id,
          providerModelId: profile.providerModelId,
          reasoningEffort: profile.reasoningEffort,
          reasoningMode: profile.reasoningMode,
          updatedAt: profile.updatedAt,
          updatedByUserId: profile.updatedByUserId,
          version: profile.version
        }))
      : [],
    provider: input.provider,
    session: session ? {
      expiresAt: session.expiresAt,
      id: session.id,
      revokedAt: session.revokedAt,
      userId: session.userId
    } : null,
    settings: settings ? {
      defaultProviderModelId: settings.defaultProviderModelId,
      id: settings.id
    } : null,
    version: 1
  });

  const inspection: AdminProviderQuickSetupInspection = {
    actingUserDefault: Boolean(selectedModel && settings?.defaultProviderModelId === selectedModel.id),
    authorized: Boolean(actorAuthorized),
    configured,
    fingerprint: safeFingerprint,
    mode,
    model: selectedModel,
    primaryCredential: primary ? { draftVersion: primary.draftVersion, id: primary.id } : null,
    provider: input.provider,
    state: advancedReason || !actorAuthorized || !settings ? "advanced_required" : state
  };
  return { connection, inspection, profiles, settings };
}

export async function lockAdminProviderQuickSetupState(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan
): Promise<void> {
  const policy = adminProviderQuickSetupPolicy(plan.provider);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${plan.actor.userId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "UserSettings" WHERE "userId" = ${plan.actor.userId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "AuthSession" WHERE "id" = ${plan.actor.sessionId} FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "ProviderConnection"
    WHERE "family" = ${policy.provider}
       OR "id" = ${policy.connection.id}
       OR "templateKey" = ${policy.connection.templateKey}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT credential."id" FROM "ProviderCredential" AS credential
    JOIN "ProviderConnection" AS connection ON connection."id" = credential."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY credential."id" FOR UPDATE OF credential
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT version."id" FROM "ProviderCredentialVersion" AS version
    JOIN "ProviderCredential" AS credential ON credential."id" = version."credentialId"
    JOIN "ProviderConnection" AS connection ON connection."id" = credential."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY version."id" FOR UPDATE OF version
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT model."id" FROM "ProviderModel" AS model
    JOIN "ProviderConnection" AS connection ON connection."id" = model."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY model."id" FOR UPDATE OF model
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT check_row."id" FROM "ProviderModelCredentialCheck" AS check_row
    JOIN "ProviderConnection" AS connection ON connection."id" = check_row."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY check_row."id" FOR UPDATE OF check_row
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT check_row."id" FROM "ProviderDraftCheck" AS check_row
    JOIN "ProviderConnection" AS connection ON connection."id" = check_row."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY check_row."id" FOR UPDATE OF check_row
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT assignment."connectionId", assignment."groupId"
    FROM "ProviderGroupCredentialAssignment" AS assignment
    JOIN "ProviderConnection" AS connection ON connection."id" = assignment."connectionId"
    WHERE connection."family" = ${policy.provider}
    ORDER BY assignment."connectionId", assignment."groupId"
    FOR UPDATE OF assignment
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT grant_row."id" FROM "AccessGrant" AS grant_row
    LEFT JOIN "ProviderModel" AS model ON model."id" = grant_row."providerModelId"
    LEFT JOIN "ProviderConnection" AS connection
      ON connection."id" = grant_row."providerConnectionId"
    WHERE connection."family" = ${policy.provider}
       OR model."connectionId" IN (
         SELECT "id" FROM "ProviderConnection" WHERE "family" = ${policy.provider}
       )
    ORDER BY grant_row."id" FOR UPDATE OF grant_row
  `);
  if (plan.mode === "initial") {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "RunProfile"
      ORDER BY CASE "id"
        WHEN 'fast' THEN 1
        WHEN 'balanced' THEN 2
        WHEN 'deep' THEN 3
        ELSE 4
      END
      FOR UPDATE
    `);
  }
}

async function eligibleProviderModelIds(
  tx: Prisma.TransactionClient,
  userId: string,
  exposeFake: boolean
): Promise<Set<string>> {
  const [memberships, grants, models] = await Promise.all([
    tx.userGroup.findMany({
      include: { group: { select: { archivedAt: true } } },
      where: { userId }
    }),
    tx.accessGrant.findMany({
      include: { providerModel: { select: { connectionId: true } } },
      where: {
        OR: [
          { userId },
          { group: { archivedAt: null, users: { some: { userId } } } }
        ]
      }
    }),
    tx.providerModel.findMany({
      include: {
        activeCredentialChecks: {
          select: {
            connectionId: true,
            connectionVersion: true,
            credentialId: true,
            credentialVersionId: true,
            modelVersion: true,
            providerModelId: true,
            status: true
          }
        },
        connection: {
          include: {
            credentials: {
              select: {
                activeVersion: { select: { id: true, revokedAt: true } },
                enabled: true,
                groupAssignments: { select: { credentialId: true, groupId: true } },
                id: true
              }
            }
          }
        }
      },
      where: { enabled: true, connection: { enabled: true } }
    })
  ]);
  const groupIds = memberships
    .filter((membership) => !membership.group.archivedAt)
    .map((membership) => membership.groupId);
  const entitlements = resolveEntitlements(userId, groupIds, grants.map((grant) => ({
    ...grant,
    providerModelConnectionId: grant.providerModel?.connectionId ?? null
  })));
  const available = filterAvailableProviderModels({
    exposeFake,
    memberships,
    models: models as CatalogProviderModelRow[]
  });
  return new Set(filterExposedProviderModels({ entitlements, models: available }).map(({ id }) => id));
}

async function applyQuickSetupPlan(
  tx: Prisma.TransactionClient,
  plan: AdminProviderQuickSetupCommitPlan,
  exposeFake: boolean
): Promise<Exclude<AdminProviderQuickSetupCommitResult, "catalog_unavailable">> {
  await lockAdminProviderQuickSetupState(tx, plan);
  const current = await loadQuickSetupState(tx, {
    ...plan.actor,
    now: plan.now,
    provider: plan.provider
  });
  if (!current.inspection.authorized) return "advanced_required";
  if (current.inspection.mode === null || current.inspection.state === "advanced_required") {
    return "advanced_required";
  }
  if (current.inspection.fingerprint !== plan.expectedFingerprint) return "stale";
  if (
    current.inspection.mode !== plan.mode ||
    (current.inspection.primaryCredential === null) !== plan.credential.isNew ||
    (!plan.credential.isNew && (
      current.inspection.primaryCredential?.id !== plan.credential.id ||
      current.inspection.primaryCredential.draftVersion + 1 !== plan.credential.draftVersion
    )) ||
    (current.inspection.mode !== "initial" && current.inspection.model &&
      current.inspection.model?.templateKey !== plan.candidate.templateKey)
  ) {
    return "stale";
  }

  const directGrants = await tx.accessGrant.findMany({
    where: {
      groupId: null,
      providerConnectionId: null,
      providerModelId: plan.candidate.modelId,
      searchStrategy: null,
      userId: plan.actor.userId
    }
  });
  if (directGrants.length > 1) return "advanced_required";

  const policy = adminProviderQuickSetupPolicy(plan.provider);
  if (plan.mode !== "replacement") {
    if (!current.connection) {
      await tx.providerConnection.create({
        data: {
          activeConfig: json(policy.connection.configuration),
          activeVersion: 1,
          activatedAt: plan.now,
          defaultCredentialId: null,
          displayName: policy.connection.displayName,
          draftConfig: json(policy.connection.configuration),
          draftVersion: 1,
          enabled: true,
          family: policy.provider,
          id: policy.connection.id,
          templateKey: policy.connection.templateKey,
          unassignedPolicy: "use_default"
        }
      });
    } else {
      await tx.providerConnection.update({
        data: {
          activeConfig: json(policy.connection.configuration),
          activeVersion: current.connection.draftVersion,
          activatedAt: plan.now,
          enabled: true,
          unassignedPolicy: "use_default"
        },
        where: { id: policy.connection.id }
      });
    }
  }

  const existingModel = await tx.providerModel.findUnique({
    where: { id: plan.candidate.modelId }
  });
  if (plan.mode === "replacement" && !existingModel) return "stale";
  if (plan.mode !== "replacement") {
    if (!existingModel) {
      await tx.providerModel.create({
        data: {
          activeConfig: json(plan.candidate.configuration),
          activeVersion: 1,
          activatedAt: plan.now,
          connectionId: policy.connection.id,
          displayName: plan.candidate.displayName,
          draftConfig: json(plan.candidate.configuration),
          draftVersion: 1,
          enabled: true,
          id: plan.candidate.modelId,
          inputTokenPriceMicros: plan.candidate.model.inputTokenPriceMicros,
          outputTokenPriceMicros: plan.candidate.model.outputTokenPriceMicros,
          provider: policy.provider,
          templateKey: plan.candidate.templateKey,
          ...modelLegacyFields(plan.candidate.configuration)
        }
      });
    } else {
      await tx.providerModel.update({
        data: {
          activeConfig: json(plan.candidate.configuration),
          activeVersion: existingModel.draftVersion,
          activatedAt: plan.now,
          enabled: true,
          ...modelLegacyFields(plan.candidate.configuration)
        },
        where: { id: plan.candidate.modelId }
      });
    }
  }
  const modelVersion = existingModel?.draftVersion ?? 1;

  if (plan.credential.isNew) {
    await tx.providerCredential.create({
      data: {
        connectionId: policy.connection.id,
        draftSecretEnvelope: null,
        draftVersion: plan.credential.draftVersion,
        enabled: true,
        id: plan.credential.id,
        label: "Primary"
      }
    });
  }
  await tx.providerCredentialVersion.create({
    data: {
      activatedAt: plan.now,
      credentialId: plan.credential.id,
      id: plan.credential.versionId,
      secretEnvelope: plan.credential.versionEnvelope,
      testEvidence: json({
        method: "models_catalog",
        policyVersion: policy.version,
        version: 1
      }),
      testedAt: plan.checkedAt,
      version: plan.credential.draftVersion
    }
  });
  await tx.providerCredential.update({
    data: {
      activatedAt: plan.now,
      activeVersionId: plan.credential.versionId,
      draftSecretEnvelope: null,
      draftVersion: plan.credential.draftVersion,
      enabled: true,
      testedAt: plan.checkedAt
    },
    where: { id: plan.credential.id }
  });
  const connectionVersion = current.connection?.draftVersion ?? 1;
  if (plan.mode !== "replacement") {
    await tx.providerConnection.update({
      data: { defaultCredentialId: plan.credential.id },
      where: { id: policy.connection.id }
    });
  }
  await tx.providerModelCredentialCheck.create({
    data: {
      checkedAt: plan.checkedAt,
      connectionId: policy.connection.id,
      connectionVersion,
      credentialId: plan.credential.id,
      credentialVersionId: plan.credential.versionId,
      evidence: json({
        detail: "ok",
        method: "models_catalog",
        selectedProviders: plan.candidate.configuration.openRouterRouting?.providers ?? [],
        upstreamModelId: plan.candidate.configuration.upstreamModelId
      }),
      modelVersion,
      providerModelId: plan.candidate.modelId,
      status: "available"
    }
  });

  if (!directGrants[0]) {
    await tx.accessGrant.create({
      data: {
        enabled: true,
        groupId: null,
        id: plan.grantId,
        providerConnectionId: null,
        providerModelId: plan.candidate.modelId,
        searchStrategy: null,
        userId: plan.actor.userId
      }
    });
  }

  const eligibleModelIds = await eligibleProviderModelIds(tx, plan.actor.userId, exposeFake);
  if (!eligibleModelIds.has(plan.candidate.modelId)) {
    throw new QuickSetupCatalogUnavailableError();
  }
  const priorDefault = current.settings?.defaultProviderModelId ?? null;
  const priorDefaultUsable = Boolean(priorDefault && eligibleModelIds.has(priorDefault));
  const defaultChanged = plan.mode !== "replacement" &&
    !priorDefaultUsable && priorDefault !== plan.candidate.modelId;
  if (plan.mode !== "replacement" && !priorDefaultUsable) {
    await tx.userSettings.update({
      data: { defaultProviderModelId: plan.candidate.modelId },
      where: { userId: plan.actor.userId }
    });
  }

  const profileFills = planAdminProviderQuickSetupProfileFills({
    mode: plan.mode,
    profiles: current.profiles,
    templateKey: plan.candidate.templateKey
  });
  const profilesFilled = [] as RunProfileId[];
  for (const profile of profileFills) {
    await tx.runProfile.update({
      data: {
        enabled: true,
        providerModelId: plan.candidate.modelId,
        reasoningEffort: profile.reasoningEffort,
        reasoningMode: profile.reasoningMode,
        updatedByUserId: plan.actor.userId,
        version: { increment: 1 }
      },
      where: { id: profile.id }
    });
    profilesFilled.push(profile.id);
  }
  return { defaultChanged, profilesFilled, status: "ready" };
}

export function createPrismaAdminProviderQuickSetupRepository(
  prisma: PrismaClient,
  options: QuickSetupRepositoryOptions = {}
): AdminProviderQuickSetupRepository {
  const exposeFake = options.exposeFake ?? false;
  return {
    async inspect(input) {
      return (await loadQuickSetupState(prisma as unknown as QuickSetupDb, input)).inspection;
    },

    async commit(plan) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(
            (tx) => applyQuickSetupPlan(tx, plan, exposeFake),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 30_000
            }
          );
        } catch (error) {
          if (error instanceof QuickSetupCatalogUnavailableError) {
            return "catalog_unavailable";
          }
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === "P2002" || error.code === "P2025" ||
              isSerializationConflict(error))
          ) {
            if (isSerializationConflict(error) && attempt < 2) continue;
            return "stale";
          }
          throw error;
        }
      }
      return "stale";
    }
  };
}

import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient
} from "@prisma/client";
import {
  decodeAssistantAvatarRecipe,
  type AssistantAvatarRecipe
} from "../../contracts/assistants";
import { SKILL_MAX_SELECTED } from "../../contracts/skills";
import {
  applySettingsUpdateInTransaction,
  type SettingsTransactionClient
} from "../settings/settingsTransaction";
import {
  ProviderAdmissionError,
  loadProviderAdmissionPlan,
  sameProviderAdmissionPlan,
  type ProviderAdmissionPlan,
  type ProviderAdmissionRole
} from "../providerRuntime/admission";
import type { McpRunPlanBinding } from "../mcp/runPlan";
import {
  KnowledgeRunAdmissionError,
  loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import {
  AssistantRunConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError,
  type AcceptedSkillRun,
  type AcceptedRunDefaults
} from "./runRepositoryContract";
import { isRecord, json } from "./prismaRepositoryShared";

function modelControlKey(input: { modelId: string; provider: string }): string {
  return `${input.provider}:${input.modelId}`;
}

export async function persistAcceptedRunDefaults(
  tx: SettingsTransactionClient,
  userId: string,
  defaults: AcceptedRunDefaults
): Promise<void> {
  if (defaults.userId !== userId) {
    throw new Error("Run defaults user does not match run owner");
  }

  const updatesSearchPreference = Object.prototype.hasOwnProperty.call(
    defaults,
    "searchPreferencePlan"
  );
  const result = await applySettingsUpdateInTransaction(
    tx,
    userId,
    {
      defaultControlValues: {
        [modelControlKey(defaults)]: { ...defaults.controlDefaults }
      },
      ...(updatesSearchPreference
        ? {
            defaultSearchPlan: defaults.searchPreferencePlan ?? null
          }
        : {})
    },
    [
      {
        modelId: defaults.modelId,
        provider: defaults.provider,
        searchStrategyIds: defaults.searchPreferencePlan?.optionIds.length
          ? [...defaults.searchPreferencePlan.optionIds]
          : []
      }
    ]
  );

  if (result.kind !== "updated") {
    throw new Error(`Run defaults persistence failed: ${result.kind}`);
  }
}

class AssistantProvenanceSerializationError extends Error {
  constructor() {
    super("assistant_provenance_serialization_conflict");
    this.name = "AssistantProvenanceSerializationError";
  }
}

class SkillProvenanceSerializationError extends Error {
  constructor() {
    super("skill_provenance_serialization_conflict");
    this.name = "SkillProvenanceSerializationError";
  }
}

function isPrismaSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" &&
        isRecord(error.meta) &&
        error.meta.code === "40001"));
}

/**
 * In-transaction Assistant acceptance recheck: the definition must still exist
 * unarchived, the revision must belong to it, and the runner must currently be
 * the owner or hold an active group/installation publication for that exact
 * revision. The locking reads serialize archive, publication, active-group, and
 * membership changes with acceptance. A concurrent revision advance is not a
 * conflict — the run records the revision resolved at admission — but access
 * loss, archive, and publication revocation fail with a stable privacy-safe
 * conflict.
 */
export async function assertAssistantRunProvenance(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    assistantId: string;
    revisionId: string;
    userId: string;
  }
): Promise<void> {
  try {
    const definitions = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT definition."ownerUserId"
      FROM "AssistantDefinition" AS definition
      INNER JOIN "AssistantRevision" AS revision
        ON revision."assistantId" = definition."id"
       AND revision."id" = ${input.revisionId}
      WHERE definition."id" = ${input.assistantId}
        AND definition."archivedAt" IS NULL
      FOR SHARE OF definition
    `;
    const definition = definitions[0];
    if (!definition) throw new AssistantRunConflictError();
    if (definition.ownerUserId === input.userId) return;

    const installationPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "AssistantPublication" AS publication
      WHERE publication."assistantId" = ${input.assistantId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'installation'
      ORDER BY publication."id"
      FOR SHARE OF publication
    `;
    if (installationPublications[0]) return;

    const groupPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "AssistantPublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${input.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."assistantId" = ${input.assistantId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'group'
      ORDER BY publication."id"
      FOR SHARE OF publication, membership, member_group
    `;
    if (!groupPublications[0]) throw new AssistantRunConflictError();
  } catch (error) {
    if (isPrismaSerializationConflict(error)) {
      throw new AssistantProvenanceSerializationError();
    }
    throw error;
  }
}

export function serializeRunAssistantIdentity(modelRun: {
  assistantRevision?: { avatar: unknown; name: string; revisionNumber: number } | null;
} | undefined): { avatar: AssistantAvatarRecipe; name: string; revisionNumber: number } | null {
  const revision = modelRun?.assistantRevision;
  if (!revision) return null;
  const avatar = decodeAssistantAvatarRecipe(revision.avatar);
  if (!avatar) return null;
  return {
    avatar,
    name: revision.name,
    revisionNumber: revision.revisionNumber
  };
}

export async function insertAcceptedMcpRunBindings(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  input: {
    bindings: McpRunPlanBinding[] | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  const bindings = input.bindings ?? [];
  const serverIds = new Set<string>();
  const generationIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const binding of bindings) {
    if (!binding.serverId || !binding.runtimeGenerationId || !binding.fingerprint ||
      serverIds.has(binding.serverId) || generationIds.has(binding.runtimeGenerationId) ||
      fingerprints.has(binding.fingerprint)) {
      throw new McpRunPlanConflictError();
    }
    serverIds.add(binding.serverId);
    generationIds.add(binding.runtimeGenerationId);
    fingerprints.add(binding.fingerprint);
  }

  for (const binding of bindings) {
    const inserted = await tx.$executeRaw`
      INSERT INTO "McpRunBinding" (
        "id",
        "modelRunId",
        "runtimeGenerationId",
        "runtimeGenerationFingerprint"
      )
      SELECT
        ${randomUUID()},
        ${input.runId},
        generation."id",
        generation."fingerprint"
      FROM "McpRuntimeGeneration" AS generation
      INNER JOIN "McpUserServer" AS preference
        ON preference."id" = generation."userServerId"
      INNER JOIN "McpServer" AS server
        ON server."id" = preference."serverId"
      INNER JOIN "User" AS owner
        ON owner."id" = preference."userId"
      WHERE owner."id" = ${input.userId}
        AND owner."status" = 'active'
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND EXISTS (
          SELECT 1
          FROM "McpGrant" AS mcp_grant
          WHERE mcp_grant."serverId" = server."id"
            AND mcp_grant."canUse" = true
            AND (
              mcp_grant."userId" = ${input.userId}
              OR mcp_grant."groupId" IN (
                SELECT membership."groupId"
                FROM "UserGroup" AS membership
                INNER JOIN "Group" AS member_group
                  ON member_group."id" = membership."groupId"
                  AND member_group."archivedAt" IS NULL
                WHERE membership."userId" = ${input.userId}
              )
            )
        )
    `;
    if (inserted !== 1) throw new McpRunPlanConflictError();
  }
}

export async function insertAcceptedSkillRunBindings(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">,
  input: {
    bindings: readonly AcceptedSkillRun[] | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  const bindings = input.bindings ?? [];
  if (bindings.length > SKILL_MAX_SELECTED ||
    new Set(bindings.map((binding) => binding.skillId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.revisionId)).size !== bindings.length ||
    bindings.some((binding) => !binding.skillId || !binding.revisionId)) {
    throw new SkillRunConflictError();
  }
  for (const binding of [...bindings].sort((left, right) =>
    left.skillId.localeCompare(right.skillId))) {
    await assertSkillRunProvenance(tx, {
      revisionId: binding.revisionId,
      skillId: binding.skillId,
      userId: input.userId
    });
    const inserted = await tx.$executeRaw`
      INSERT INTO "ModelRunSkillBinding" (
        "modelRunId",
        "skillId",
        "revisionId"
      )
      SELECT
        run."id",
        revision."skillId",
        revision."id"
      FROM "ModelRun" AS run
      INNER JOIN "User" AS runner
        ON runner."id" = run."userId"
      INNER JOIN "SkillRevision" AS revision
        ON revision."skillId" = ${binding.skillId}
       AND revision."id" = ${binding.revisionId}
      INNER JOIN "SkillDefinition" AS definition
        ON definition."id" = revision."skillId"
       AND definition."archivedAt" IS NULL
      WHERE run."id" = ${input.runId}
        AND run."userId" = ${input.userId}
        AND runner."status" = 'active'
        AND (
          definition."ownerUserId" = ${input.userId}
          OR EXISTS (
            SELECT 1
            FROM "SkillPublication" AS publication
            WHERE publication."skillId" = definition."id"
              AND publication."revisionId" = revision."id"
              AND (
                publication."scope" = 'installation'
                OR (
                  publication."scope" = 'group'
                  AND EXISTS (
                    SELECT 1
                    FROM "UserGroup" AS membership
                    INNER JOIN "Group" AS member_group
                      ON member_group."id" = membership."groupId"
                     AND member_group."archivedAt" IS NULL
                    WHERE membership."groupId" = publication."groupId"
                      AND membership."userId" = ${input.userId}
                  )
                )
              )
          )
        )
    `;
    if (inserted !== 1) throw new SkillRunConflictError();
  }
}

async function assertSkillRunProvenance(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: AcceptedSkillRun & { userId: string }
): Promise<void> {
  try {
    const definitions = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT definition."ownerUserId"
      FROM "SkillDefinition" AS definition
      INNER JOIN "SkillRevision" AS revision
        ON revision."skillId" = definition."id"
       AND revision."id" = ${input.revisionId}
      WHERE definition."id" = ${input.skillId}
        AND definition."archivedAt" IS NULL
      FOR SHARE OF definition
    `;
    const definition = definitions[0];
    if (!definition) throw new SkillRunConflictError();
    if (definition.ownerUserId === input.userId) return;

    const installationPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "SkillPublication" AS publication
      WHERE publication."skillId" = ${input.skillId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'installation'
      ORDER BY publication."id"
      FOR SHARE OF publication
    `;
    if (installationPublications[0]) return;

    const groupPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "SkillPublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${input.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."skillId" = ${input.skillId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'group'
      ORDER BY publication."id"
      FOR SHARE OF publication, membership, member_group
    `;
    if (!groupPublications[0]) throw new SkillRunConflictError();
  } catch (error) {
    if (isPrismaSerializationConflict(error)) {
      throw new SkillProvenanceSerializationError();
    }
    throw error;
  }
}

export async function assertCurrentSkillRunBindings(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    bindings: readonly AcceptedSkillRun[] | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  const bindings = input.bindings ?? [];
  const [{ count }] = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "ModelRunSkillBinding"
    WHERE "modelRunId" = ${input.runId}
  `;
  if (Number(count) !== bindings.length) throw new SkillRunConflictError();
  for (const binding of [...bindings].sort((left, right) =>
    left.skillId.localeCompare(right.skillId))) {
    await assertSkillRunProvenance(tx, {
      revisionId: binding.revisionId,
      skillId: binding.skillId,
      userId: input.userId
    });
    const rows = await tx.$queryRaw<Array<{ skillId: string }>>`
      SELECT run_skill."skillId"
      FROM "ModelRunSkillBinding" AS run_skill
      INNER JOIN "ModelRun" AS run
        ON run."id" = run_skill."modelRunId"
       AND run."userId" = ${input.userId}
      INNER JOIN "SkillDefinition" AS definition
        ON definition."id" = run_skill."skillId"
       AND definition."archivedAt" IS NULL
      WHERE run_skill."modelRunId" = ${input.runId}
        AND run_skill."skillId" = ${binding.skillId}
        AND run_skill."revisionId" = ${binding.revisionId}
        AND (
          definition."ownerUserId" = ${input.userId}
          OR EXISTS (
            SELECT 1
            FROM "SkillPublication" AS publication
            WHERE publication."skillId" = run_skill."skillId"
              AND publication."revisionId" = run_skill."revisionId"
              AND (
                publication."scope" = 'installation'
                OR (
                  publication."scope" = 'group'
                  AND EXISTS (
                    SELECT 1
                    FROM "UserGroup" AS membership
                    INNER JOIN "Group" AS member_group
                      ON member_group."id" = membership."groupId"
                     AND member_group."archivedAt" IS NULL
                    WHERE membership."groupId" = publication."groupId"
                      AND membership."userId" = ${input.userId}
                  )
                )
              )
          )
        )
      FOR SHARE OF run_skill, run, definition
    `;
    if (!rows[0]) throw new SkillRunConflictError();
  }
}

export async function lockKnowledgeRunAdmissionSources(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Readonly<{ plan: KnowledgeRunAdmissionPlan; userId: string }>
): Promise<void> {
  for (const knowledgeBaseId of input.plan.knowledgePlan.baseIds) {
    const bases = await tx.$queryRaw<Array<{
      indexGenerationId: string;
      ownerUserId: string;
    }>>`
      SELECT
        base."ownerUserId",
        generation."id" AS "indexGenerationId"
      FROM "KnowledgeBase" AS base
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."knowledgeBaseId" = base."id"
       AND generation."id" = base."activeIndexGenerationId"
       AND generation."status" = 'active'
      WHERE base."id" = ${knowledgeBaseId}
        AND base."archivedAt" IS NULL
      FOR SHARE OF base, generation
    `;
    const base = bases[0];
    if (!base) throw new KnowledgeRunPlanConflictError();
    if (base.ownerUserId === input.userId) continue;

    const installation = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "KnowledgeBasePublication" AS publication
      WHERE publication."knowledgeBaseId" = ${knowledgeBaseId}
        AND publication."scope" = 'installation'
      FOR SHARE OF publication
    `;
    if (installation[0]) continue;

    const group = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "KnowledgeBasePublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${input.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."knowledgeBaseId" = ${knowledgeBaseId}
        AND publication."scope" = 'group'
      ORDER BY publication."id"
      FOR SHARE OF publication, membership, member_group
    `;
    if (!group[0]) throw new KnowledgeRunPlanConflictError();
  }
}

export async function insertAcceptedKnowledgeRunBindings(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    plan: KnowledgeRunAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }>
): Promise<void> {
  if (!input.plan) return;
  await lockKnowledgeRunAdmissionSources(tx, {
    plan: input.plan,
    userId: input.userId
  });
  let current: KnowledgeRunAdmissionPlan;
  try {
    current = await loadKnowledgeRunAdmissionPlan(tx, {
      knowledgePlan: input.plan.knowledgePlan,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof KnowledgeRunAdmissionError || error instanceof ProviderAdmissionError) {
      throw new KnowledgeRunPlanConflictError();
    }
    throw error;
  }
  if (!sameKnowledgeRunAdmissionPlan(input.plan, current)) {
    throw new KnowledgeRunPlanConflictError();
  }
  for (const binding of current.bindings) {
    const snapshot = binding.embeddingExecutionSnapshot;
    if (!snapshot.credentialId || !snapshot.credentialVersionId) {
      throw new KnowledgeRunPlanConflictError();
    }
    await tx.knowledgeRunBinding.create({
      data: {
        baseContentRevision: binding.baseContentRevision,
        embeddingConnectionId: snapshot.connectionId,
        embeddingCredentialId: snapshot.credentialId,
        embeddingCredentialSource: binding.embeddingCredentialSource,
        embeddingCredentialVersionId: snapshot.credentialVersionId,
        embeddingExecutionSnapshot: json(snapshot),
        embeddingProviderModelId: binding.embeddingProviderModelId,
        indexedContentRevision: binding.indexedContentRevision,
        indexGenerationId: binding.indexGenerationId,
        knowledgeBaseId: binding.knowledgeBaseId,
        modelRunId: input.runId,
        ordinal: binding.ordinal,
        targetDimension: binding.targetDimension,
        vectorSpaceFingerprint: binding.vectorSpaceFingerprint
      }
    });
  }
}

function providerRecoveryHorizon(
  role: ProviderAdmissionRole,
  nativeBackgroundRequested: boolean
): Date | null {
  if (
    role.snapshot.model.adapterKind !== "openai_responses_native" ||
    !nativeBackgroundRequested
  ) {
    return null;
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1_000);
}

export async function insertAcceptedProviderRunBindings(
  tx: Prisma.TransactionClient,
  input: {
    nativeBackgroundRequested: boolean;
    plan: ProviderAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  if (!input.plan) return;
  let current: ProviderAdmissionPlan;
  try {
    current = await loadProviderAdmissionPlan(tx, {
      providerConnectionId: input.plan.selection.providerConnectionId,
      providerModelId: input.plan.selection.providerModelId,
      ...(input.plan.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      searchPlan: input.plan.requestedSearchPlan,
      ...(input.plan.requestedSearchPreferenceSource
        ? {
            searchPreferencePlan: input.plan.requestedSearchPreferencePlan,
            searchPreferenceSource: input.plan.requestedSearchPreferenceSource
          }
        : {}),
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof ProviderAdmissionError) {
      throw new ProviderAdmissionConflictError();
    }
    throw error;
  }
  if (!sameProviderAdmissionPlan(input.plan, current)) {
    throw new ProviderAdmissionConflictError();
  }

  const roles: Array<{
    bindingKey: string;
    role: "answer" | "search";
    value: ProviderAdmissionRole;
  }> = [
    { bindingKey: "answer", role: "answer", value: current.answer },
    ...current.searches.flatMap((search) =>
      search.role && search.bindingKey
        ? [{ bindingKey: search.bindingKey, role: "search" as const, value: search.role }]
        : [])
  ];
  await tx.providerRunBinding.createMany({
    data: roles.map(({ bindingKey, role, value }) => ({
      bindingKey,
      connectionId: value.snapshot.connectionId,
      credentialId: value.snapshot.credentialId,
      credentialSource: value.credentialSource,
      credentialVersionId: value.snapshot.credentialVersionId,
      executionSnapshot: json(value.snapshot),
      modelRunId: input.runId,
      providerModelId: value.snapshot.providerModelId,
      recoverableUntil: role === "answer"
        ? providerRecoveryHorizon(value, input.nativeBackgroundRequested)
        : null,
      role
    }))
  });
}

export async function repeatableReadTransaction<Value>(
  prismaClient: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prismaClient.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 120_000
      });
    } catch (error) {
      const assistantSerializationConflict =
        error instanceof AssistantProvenanceSerializationError;
      const skillSerializationConflict = error instanceof SkillProvenanceSerializationError;
      const serializationConflict = assistantSerializationConflict || skillSerializationConflict ||
        isPrismaSerializationConflict(error);
      if (serializationConflict) {
        if (attempt < 2) continue;
        if (assistantSerializationConflict) throw new AssistantRunConflictError();
        if (skillSerializationConflict) throw new SkillRunConflictError();
        throw new ProviderAdmissionConflictError();
      }
      throw error;
    }
  }
  throw new ProviderAdmissionConflictError();
}

import { randomInt, randomUUID } from "node:crypto";
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
import { DEFAULT_KNOWLEDGE_ANSWER_POLICY } from "../knowledge/answerPolicy";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  knowledgeSourceEvidenceKey
} from "../knowledge/evidencePackage";
import {
  KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT,
  KNOWLEDGE_ANSWER_ROUTE_RAG
} from "../knowledge/fullContext";
import {
  KnowledgeSourceSnapshotConflictError,
  materializeKnowledgeBaseSnapshot
} from "../knowledge/sourcePersistence";
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
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034" ||
      (error.code === "P2010" &&
        isRecord(error.meta) &&
        (error.meta.code === "40001" || error.meta.code === "40P01"));
  }
  // Prisma createMany can surface rollback-safe PostgreSQL conflicts as an
  // UnknownRequestError instead of P2010. Match the structured connector code,
  // never arbitrary query text, so unrelated database failures still escape.
  return error instanceof Prisma.PrismaClientUnknownRequestError &&
    /PostgresError\s*\{\s*code:\s*"(?:40001|40P01)"/u.test(error.message);
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

/** Project publication is its own Assistant authority. The exact pinned
 * binding and revision must still exist and the definition must be active,
 * but the initiating member never needs a matching personal publication. */
export async function assertProjectAssistantRunProvenance(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Readonly<{
    assistantId: string;
    projectId: string;
    revisionId: string;
  }>
): Promise<void> {
  const bindings = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT project_binding."id"
    FROM "ProjectAssistantBinding" AS project_binding
    INNER JOIN "AssistantDefinition" AS definition
      ON definition."id" = project_binding."assistantId"
     AND definition."archivedAt" IS NULL
    INNER JOIN "AssistantRevision" AS revision
      ON revision."id" = project_binding."revisionId"
     AND revision."assistantId" = definition."id"
    WHERE project_binding."projectId" = ${input.projectId}
      AND project_binding."assistantId" = ${input.assistantId}
      AND project_binding."revisionId" = ${input.revisionId}
    FOR SHARE OF project_binding, definition, revision
  `;
  if (!bindings[0]) throw new AssistantRunConflictError();
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
    projectId?: string;
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
    const inserted = input.projectId
      ? await tx.$executeRaw(Prisma.sql`
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
      INNER JOIN "McpRevision" AS revision
        ON revision."id" = generation."revisionId"
      INNER JOIN "ProjectMcpBinding" AS project_binding
        ON project_binding."serverId" = server."id"
       AND project_binding."projectId" = ${input.projectId}
      WHERE server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND (
          server."sharedConfigEnvelope" IS NOT NULL
          OR revision."configuration" #>> '{auth,mode}' = 'none'
        )
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND preference."personalConfigEnvelope" IS NULL
        AND generation."oauthConnectionId" IS NULL
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND NOT (generation."credentialSources" && ARRAY['oauth', 'personal']::TEXT[])
      `)
      : await tx.$executeRaw`
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
    projectId?: string;
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
    if (input.projectId) {
      const inserted = await tx.$executeRaw`
        INSERT INTO "ModelRunSkillBinding" ("modelRunId", "skillId", "revisionId")
        SELECT run."id", revision."skillId", revision."id"
        FROM "ModelRun" AS run
        INNER JOIN "ProjectSkillBinding" AS project_binding
          ON project_binding."projectId" = ${input.projectId}
         AND project_binding."skillId" = ${binding.skillId}
        INNER JOIN "SkillDefinition" AS definition
          ON definition."id" = project_binding."skillId"
         AND definition."archivedAt" IS NULL
         AND definition."deletedAt" IS NULL
         AND definition."currentRevisionId" = ${binding.revisionId}
        INNER JOIN "SkillRevision" AS revision
          ON revision."skillId" = definition."id"
         AND revision."id" = definition."currentRevisionId"
        WHERE run."id" = ${input.runId}
          AND run."userId" = ${input.userId}
      `;
      if (inserted !== 1) throw new SkillRunConflictError();
      continue;
    }
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
       AND definition."deletedAt" IS NULL
      WHERE run."id" = ${input.runId}
        AND run."userId" = ${input.userId}
        AND runner."status" = 'active'
        AND (
          definition."ownerUserId" = ${input.userId}
          OR EXISTS (
            SELECT 1
            FROM "SkillPublication" AS publication
            WHERE publication."skillId" = definition."id"
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
        AND definition."deletedAt" IS NULL
      FOR SHARE OF definition
    `;
    const definition = definitions[0];
    if (!definition) throw new SkillRunConflictError();
    if (definition.ownerUserId === input.userId) return;

    const installationPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "SkillPublication" AS publication
      WHERE publication."skillId" = ${input.skillId}
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
       AND definition."deletedAt" IS NULL
      WHERE run_skill."modelRunId" = ${input.runId}
        AND run_skill."skillId" = ${binding.skillId}
        AND run_skill."revisionId" = ${binding.revisionId}
        AND (
          definition."ownerUserId" = ${input.userId}
          OR EXISTS (
            SELECT 1
            FROM "SkillPublication" AS publication
            WHERE publication."skillId" = run_skill."skillId"
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
): Promise<ReadonlyMap<string, Readonly<{
  indexGenerationId: string;
  profileRevisionId: string | null;
}>>> {
  const lockedProfiles = new Map<string, Readonly<{
    indexGenerationId: string;
    profileRevisionId: string | null;
  }>>();
  for (const { indexGenerationId, knowledgeBaseId } of input.plan.bindings) {
    if (input.plan.projectId) {
      const projectBindings = await tx.$queryRaw<Array<{
        indexGenerationId: string;
        profileRevisionId: string | null;
      }>>`
        SELECT
          generation."id" AS "indexGenerationId",
          generation."profileRevisionId"
        FROM "ProjectKnowledgeBaseBinding" AS project_binding
        INNER JOIN "KnowledgeBase" AS base
          ON base."id" = project_binding."knowledgeBaseId"
         AND base."archivedAt" IS NULL
         AND base."trashedAt" IS NULL
         AND base."deletionRequestedAt" IS NULL
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = base."id"
         AND generation."id" = base."activeIndexGenerationId"
         AND generation."status" = 'active'
        WHERE project_binding."projectId" = ${input.plan.projectId}
          AND project_binding."knowledgeBaseId" = ${knowledgeBaseId}
          AND generation."id" = ${indexGenerationId}
        FOR SHARE OF project_binding, base, generation
      `;
      const projectBinding = projectBindings[0];
      if (!projectBinding) throw new KnowledgeRunPlanConflictError();
      lockedProfiles.set(knowledgeBaseId, projectBinding);
      continue;
    }
    const bases = await tx.$queryRaw<Array<{
      indexGenerationId: string;
      ownerUserId: string;
      profileRevisionId: string | null;
    }>>`
      SELECT
        base."ownerUserId",
        generation."id" AS "indexGenerationId",
        generation."profileRevisionId"
      FROM "KnowledgeBase" AS base
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."knowledgeBaseId" = base."id"
       AND generation."id" = base."activeIndexGenerationId"
       AND generation."status" = 'active'
      WHERE base."id" = ${knowledgeBaseId}
        AND base."archivedAt" IS NULL
        AND base."trashedAt" IS NULL
        AND base."deletionRequestedAt" IS NULL
        AND generation."id" = ${indexGenerationId}
      FOR SHARE OF base, generation
    `;
    const base = bases[0];
    if (!base) throw new KnowledgeRunPlanConflictError();
    lockedProfiles.set(knowledgeBaseId, {
      indexGenerationId: base.indexGenerationId,
      profileRevisionId: base.profileRevisionId
    });
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
  for (const source of input.plan.sources ?? []) {
    const rows = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT source."ownerUserId"
      FROM "KnowledgeSource" AS source
      INNER JOIN "KnowledgeSourceVersion" AS version
        ON version."sourceId" = source."id"
       AND version."id" = ${source.sourceVersionId}
      INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
        ON artifact."sourceVersionId" = version."id"
       AND artifact."id" = ${source.sourceArtifactId}
      INNER JOIN "KnowledgeIndexProfileRevision" AS profile
        ON profile."id" = artifact."profileRevisionId"
      WHERE source."id" = ${source.sourceId}
        AND source."currentVersionId" = version."id"
        AND source."trashedAt" IS NULL
        AND source."deletionRequestedAt" IS NULL
        AND artifact."profileRevisionId" = ${source.profileRevisionId}
        AND artifact."state" = 'ready'
      FOR SHARE OF source, version, artifact, profile
    `;
    const lockedSource = rows[0];
    if (!lockedSource || source.authority.owner && lockedSource.ownerUserId !== input.userId) {
      throw new KnowledgeRunPlanConflictError();
    }
    if (source.authority.projectId) {
      const projectBindings = await tx.$queryRaw<Array<{ sourceId: string }>>`
        SELECT binding."sourceId"
        FROM "ProjectKnowledgeSourceBinding" AS binding
        WHERE binding."projectId" = ${source.authority.projectId}
          AND binding."sourceId" = ${source.sourceId}
        FOR SHARE OF binding
      `;
      if (projectBindings.length !== 1) throw new KnowledgeRunPlanConflictError();
    }
  }
  return lockedProfiles;
}

type CanonicalKnowledgeBindingState = Readonly<{
  baseProfileBindingIds: ReadonlyMap<string, string>;
  profiles: readonly Readonly<{
    id: string;
    value: NonNullable<KnowledgeRunAdmissionPlan["profiles"]>[number];
  }>[];
  sources: readonly Readonly<{
    profileBindingId: string;
    selectionKind: "all_my_knowledge" | "assistant" | "base" | "direct" | "project";
    value: NonNullable<KnowledgeRunAdmissionPlan["sources"]>[number];
  }>[];
}>;

function canonicalJsonForComparison(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForComparison).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonForComparison(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function profileMatchesLegacyBinding(
  profile: NonNullable<KnowledgeRunAdmissionPlan["profiles"]>[number],
  binding: KnowledgeRunAdmissionPlan["bindings"][number]
): boolean {
  const profileSnapshot = profile.embeddingExecutionSnapshot;
  const bindingSnapshot = binding.embeddingExecutionSnapshot;
  return profile.embeddingCredentialSource === binding.embeddingCredentialSource &&
    profile.embeddingProviderModelId === binding.embeddingProviderModelId &&
    profile.targetDimension === binding.targetDimension &&
    profile.vectorSpaceFingerprint === binding.vectorSpaceFingerprint &&
    profileSnapshot.connectionId === bindingSnapshot.connectionId &&
    profileSnapshot.credentialId === bindingSnapshot.credentialId &&
    profileSnapshot.credentialVersionId === bindingSnapshot.credentialVersionId &&
    profileSnapshot.providerModelId === bindingSnapshot.providerModelId &&
    canonicalJsonForComparison(profileSnapshot) === canonicalJsonForComparison(bindingSnapshot);
}

function sourceSelectionKind(
  plan: KnowledgeRunAdmissionPlan,
  source: NonNullable<KnowledgeRunAdmissionPlan["sources"]>[number]
): CanonicalKnowledgeBindingState["sources"][number]["selectionKind"] {
  if (plan.knowledgePlan.mode === "inherited") {
    return plan.knowledgePlan.inheritedFrom === "assistant" ? "assistant" : "project";
  }
  if (plan.projectId) return "project";
  if (source.selectionProvenance.includes("all_my_knowledge")) {
    return "all_my_knowledge";
  }
  return source.directSelected ? "direct" : "base";
}

function prepareCanonicalKnowledgeBindings(
  plan: KnowledgeRunAdmissionPlan,
  lockedProfiles: ReadonlyMap<string, Readonly<{
    indexGenerationId: string;
    profileRevisionId: string | null;
  }>>
): CanonicalKnowledgeBindingState | null {
  if (plan.profiles === undefined && plan.sources === undefined) return null;
  if (plan.profiles === undefined || plan.sources === undefined) {
    throw new KnowledgeRunPlanConflictError();
  }
  if (plan.sources.length !== plan.resolvedSourceCount) {
    throw new KnowledgeRunPlanConflictError();
  }

  const profileIdsByOrdinal = new Map<number, string>();
  const profileIdsByRevision = new Map<string, string>();
  const profiles = plan.profiles.map((profile, ordinal) => {
    const snapshot = profile.embeddingExecutionSnapshot;
    if (
      profile.ordinal !== ordinal ||
      !isNonemptyString(profile.profileRevisionId) ||
      profileIdsByRevision.has(profile.profileRevisionId) ||
      !isNonemptyString(snapshot.connectionId) ||
      !isNonemptyString(snapshot.credentialId) ||
      !isNonemptyString(snapshot.credentialVersionId) ||
      snapshot.providerModelId !== profile.embeddingProviderModelId
    ) {
      throw new KnowledgeRunPlanConflictError();
    }
    const id = randomUUID();
    profileIdsByOrdinal.set(ordinal, id);
    profileIdsByRevision.set(profile.profileRevisionId, id);
    return { id, value: profile };
  });

  const baseProfileBindingIds = new Map<string, string>();
  for (const binding of plan.bindings) {
    const locked = lockedProfiles.get(binding.knowledgeBaseId);
    if (
      !locked ||
      locked.indexGenerationId !== binding.indexGenerationId ||
      !locked.profileRevisionId
    ) {
      throw new KnowledgeRunPlanConflictError();
    }
    const matchingProfiles = profiles.filter(({ value }) =>
      value.profileRevisionId === locked.profileRevisionId &&
      profileMatchesLegacyBinding(value, binding));
    if (matchingProfiles.length !== 1) throw new KnowledgeRunPlanConflictError();
    baseProfileBindingIds.set(binding.knowledgeBaseId, matchingProfiles[0]!.id);
  }

  const tupleKeys = new Set<string>();
  const aliases = new Set<string>();
  const sources = plan.sources.map((source, ordinal) => {
    const profile = plan.profiles?.[source.profileOrdinal];
    const profileBindingId = profileIdsByOrdinal.get(source.profileOrdinal);
    const tupleKey = canonicalJsonForComparison([
      source.sourceId,
      source.sourceVersionId,
      source.sourceArtifactId
    ]);
    const authorityBaseIds = new Set(source.authority.knowledgeBaseIds);
    const baseProvenanceIds = new Set<string>();
    const projectAuthorityMatches = plan.projectId
      ? source.authority.projectId === plan.projectId
      : source.authority.projectId === null;
    if (
      source.ordinal !== ordinal ||
      source.sourceAlias !== `S${ordinal + 1}` ||
      aliases.has(source.sourceAlias) ||
      tupleKeys.has(tupleKey) ||
      !profile ||
      !profileBindingId ||
      source.profileRevisionId !== profile.profileRevisionId ||
      !isNonemptyString(source.sourceId) ||
      !isNonemptyString(source.sourceVersionId) ||
      !isNonemptyString(source.sourceArtifactId) ||
      !Number.isSafeInteger(source.approxTokens) ||
      source.approxTokens < 1 ||
      !Number.isSafeInteger(source.passageCount) ||
      source.passageCount < 1 ||
      !Number.isSafeInteger(source.sourceVersionNumber) ||
      source.sourceVersionNumber < 1 ||
      source.selectionProvenance.length === 0 ||
      new Set(source.selectionProvenance).size !== source.selectionProvenance.length ||
      authorityBaseIds.size !== source.authority.knowledgeBaseIds.length ||
      !projectAuthorityMatches ||
      (!source.authority.owner && !source.authority.projectId && authorityBaseIds.size === 0)
    ) {
      throw new KnowledgeRunPlanConflictError();
    }
    for (const provenance of source.baseProvenance) {
      const acceptedBase = plan.bindings.find((binding) =>
        binding.knowledgeBaseId === provenance.knowledgeBaseId);
      if (
        baseProvenanceIds.has(provenance.knowledgeBaseId) ||
        !authorityBaseIds.has(provenance.knowledgeBaseId) ||
        !acceptedBase ||
        acceptedBase.indexGenerationId !== provenance.indexGenerationId
      ) {
        throw new KnowledgeRunPlanConflictError();
      }
      baseProvenanceIds.add(provenance.knowledgeBaseId);
    }
    aliases.add(source.sourceAlias);
    tupleKeys.add(tupleKey);
    return {
      profileBindingId,
      selectionKind: sourceSelectionKind(plan, source),
      value: source
    };
  });

  return { baseProfileBindingIds, profiles, sources };
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
  const lockedProfiles = await lockKnowledgeRunAdmissionSources(tx, {
    plan: input.plan,
    userId: input.userId
  });
  let current: KnowledgeRunAdmissionPlan;
  try {
    current = await loadKnowledgeRunAdmissionPlan(tx, {
      ...(input.plan.executionScope ? { executionScope: input.plan.executionScope } : {}),
      knowledgePlan: input.plan.knowledgePlan,
      ...(input.plan.projectId ? { projectId: input.plan.projectId } : {}),
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
  const canonicalBindings = prepareCanonicalKnowledgeBindings(current, lockedProfiles);
  const answerPolicy = current.answerPolicy ?? DEFAULT_KNOWLEDGE_ANSWER_POLICY;
  const answeringPlan = input.plan.answeringPlan;
  const fullContextPlan = answeringPlan?.route === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT
    ? answeringPlan
    : null;
  const answerRoute = fullContextPlan
    ? KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT
    : KNOWLEDGE_ANSWER_ROUTE_RAG;
  if (fullContextPlan && (!canonicalBindings || fullContextPlan.evidenceItems.length < 1)) {
    throw new KnowledgeRunPlanConflictError();
  }
  await tx.knowledgeRunScope.create({
    data: {
      answerPolicy: json(answerPolicy),
      answerRoute,
      budgetPolicy: json(current.budgetPolicy),
      exclusions: json(current.exclusions),
      modelRunId: input.runId,
      resolvedBaseCount: current.bindings.length,
      resolvedSourceCount: current.resolvedSourceCount,
      selection: json(current.knowledgePlan)
    }
  });
  const excludedResources = current.exclusions.reduce(
    (total, exclusion) => total + exclusion.count,
    0
  );
  const retrievalSessionId = randomUUID();
  await tx.knowledgeRetrievalSession.create({
    data: {
      citationContract: json(KNOWLEDGE_EVIDENCE_CITATION_CONTRACT),
      degradedFlags: excludedResources > 0 ? ["partial_readiness"] : [],
      id: retrievalSessionId,
      modelRunId: input.runId,
      nextEvidenceOrdinal: fullContextPlan
        ? fullContextPlan.evidenceItems.length + 1
        : 1,
      originalIntent: json({ kind: answerRoute === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT
        ? "full_context_v1"
        : "tool_loop_v1" }),
      readinessSummary: json({
        excludedResources,
        readyBases: current.bindings.length,
        readySources: current.resolvedSourceCount
      }),
      scopeSnapshot: json({
        answerPolicy,
        answerRoute,
        budgetPolicy: current.budgetPolicy,
        exclusions: current.exclusions,
        resolvedBaseCount: current.bindings.length,
        resolvedSourceCount: current.resolvedSourceCount,
        selection: current.knowledgePlan
      }),
      version: 2
    }
  });
  for (const profile of canonicalBindings?.profiles ?? []) {
    const snapshot = profile.value.embeddingExecutionSnapshot;
    await tx.knowledgeRunProfileBinding.create({
      data: {
        embeddingConnectionId: snapshot.connectionId,
        embeddingCredentialId: snapshot.credentialId!,
        embeddingCredentialSource: profile.value.embeddingCredentialSource,
        embeddingCredentialVersionId: snapshot.credentialVersionId!,
        embeddingExecutionSnapshot: json(snapshot),
        embeddingProviderModelId: profile.value.embeddingProviderModelId,
        id: profile.id,
        modelRunId: input.runId,
        ordinal: profile.value.ordinal,
        profileRevisionId: profile.value.profileRevisionId,
        targetDimension: profile.value.targetDimension,
        vectorSpaceFingerprint: profile.value.vectorSpaceFingerprint
      }
    });
  }
  for (const binding of current.bindings) {
    const snapshot = binding.embeddingExecutionSnapshot;
    if (!snapshot.credentialId || !snapshot.credentialVersionId) {
      throw new KnowledgeRunPlanConflictError();
    }
    let sourceSnapshot: Awaited<ReturnType<typeof materializeKnowledgeBaseSnapshot>>;
    try {
      sourceSnapshot = await materializeKnowledgeBaseSnapshot(tx, {
        indexGenerationId: binding.indexGenerationId,
        knowledgeBaseId: binding.knowledgeBaseId
      });
    } catch (error) {
      if (error instanceof KnowledgeSourceSnapshotConflictError) {
        throw new KnowledgeRunPlanConflictError();
      }
      throw error;
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
        includeWholeBase: binding.includeWholeBase,
        knowledgeBaseId: binding.knowledgeBaseId,
        knowledgeBaseSnapshotId: sourceSnapshot.snapshotId,
        modelRunId: input.runId,
        ordinal: binding.ordinal,
        ...(canonicalBindings
          ? {
              profileBindingId: canonicalBindings.baseProfileBindingIds.get(
                binding.knowledgeBaseId
              )!
            }
          : {}),
        selectedSourceIds: [...binding.selectedSourceIds],
        targetDimension: binding.targetDimension,
        vectorSpaceFingerprint: binding.vectorSpaceFingerprint
      }
    });
  }
  for (const source of canonicalBindings?.sources ?? []) {
    await tx.knowledgeRunSourceBinding.create({
      data: {
        accessProvenance: json({
          authority: source.value.authority,
          selectionProvenance: [...source.value.selectionProvenance]
        }),
        baseProvenance: json([...source.value.baseProvenance]),
        directSelected: source.value.directSelected,
        fileNameSnapshot: source.value.privateLabels.fileName,
        modelRunId: input.runId,
        ordinal: source.value.ordinal,
        profileBindingId: source.profileBindingId,
        readinessState: "ready",
        selectionKind: source.selectionKind,
        sourceAlias: source.value.sourceAlias,
        sourceArtifactId: source.value.sourceArtifactId,
        sourceId: source.value.sourceId,
        sourceNameSnapshot: source.value.privateLabels.sourceName,
        sourceVersionId: source.value.sourceVersionId,
        sourceVersionNumber: source.value.sourceVersionNumber
      }
    });
  }

  if (fullContextPlan && canonicalBindings) {
    const evidenceItems = fullContextPlan.evidenceItems;
    if (new Set(evidenceItems.map((item) => item.id)).size !== evidenceItems.length ||
      new Set(evidenceItems.map((item) => item.evidenceId)).size !== evidenceItems.length ||
      evidenceItems.some((item, index) => item.handle !== `K${index + 1}`)) {
      throw new KnowledgeRunPlanConflictError();
    }
    const persistedPassages = await tx.knowledgeArtifactPassageIndex.findMany({
      select: {
        contentHash: true,
        documentContext: true,
        headingPath: true,
        id: true,
        indexArtifact: {
          select: {
            sourceArtifactId: true,
            sourceVersionId: true,
            state: true
          }
        },
        ordinal: true,
        page: true,
        pageEnd: true,
        sectionId: true,
        text: true,
        tokenCount: true
      },
      where: { id: { in: evidenceItems.map((item) => item.passageId) } }
    });
    const passageById = new Map(persistedPassages.map((passage) => [passage.id, passage]));
    for (const item of evidenceItems) {
      const passage = passageById.get(item.passageId);
      if (!passage || passage.indexArtifact.state !== "ready" ||
        passage.indexArtifact.sourceArtifactId !== item.sourceArtifactId ||
        passage.indexArtifact.sourceVersionId !== item.sourceVersionId ||
        passage.ordinal !== item.passageOrdinal || passage.page !== item.page ||
        passage.pageEnd !== item.pageEnd || passage.sectionId !== item.sectionId ||
        passage.text !== item.text || passage.tokenCount !== item.tokenCount ||
        passage.contentHash !== item.contentHash ||
        canonicalJsonForComparison(passage.headingPath) !==
          canonicalJsonForComparison(item.headingPath) ||
        canonicalJsonForComparison(passage.documentContext) !==
          canonicalJsonForComparison(item.documentContext)) {
        throw new KnowledgeRunPlanConflictError();
      }
    }
    const profileBindingIdBySourceOrdinal = new Map(
      canonicalBindings.sources.map((source) => [source.value.ordinal, source.profileBindingId])
    );
    await tx.knowledgeEvidenceItem.createMany({
      data: evidenceItems.map((item, index) => {
        const profileBindingId = profileBindingIdBySourceOrdinal.get(item.sourceOrdinal);
        if (!profileBindingId) throw new KnowledgeRunPlanConflictError();
        const excerptBytes = Buffer.byteLength(item.text, "utf8");
        return {
          baseName: item.baseName,
          contentHash: item.contentHash,
          contextBoundaries: json({
            ...(item.documentContext ? { documentContext: item.documentContext } : {}),
            expanded: false,
            excerptBytes,
            ...(item.documentContext
              ? { layoutKind: item.documentContext.locator.kind }
              : { layoutKind: "body" }),
            sourceTextBytes: excerptBytes
          }),
          documentId: item.sourceId,
          documentVersionId: item.sourceVersionId,
          evidenceKey: knowledgeSourceEvidenceKey({
            documentVersionId: item.sourceVersionId,
            excerpt: item.text,
            passageId: item.passageId,
            sourceArtifactId: item.sourceArtifactId,
            sourceId: item.sourceId,
            sourceVersionId: item.sourceVersionId
          }),
          excerpt: item.text,
          excerptBytes,
          fileName: item.sourceFileName,
          handle: item.handle,
          headingPath: [...item.headingPath],
          id: item.id,
          knowledgeBaseId: profileBindingId,
          locator: json({ page: item.page }),
          ordinal: index + 1,
          page: item.page,
          passageId: item.passageId,
          retrievalSessionId,
          sectionId: item.sectionId,
          sourceArtifactId: item.sourceArtifactId,
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          sourceTextBytes: excerptBytes,
          sourceVersionId: item.sourceVersionId,
          sourceVersionNumber: item.sourceVersionNumber,
          state: "available",
          textTruncated: false
        };
      })
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
      ...(input.plan.executionScope ? { executionScope: input.plan.executionScope } : {}),
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

export class RunTransactionDeadlineError extends Error {
  constructor() {
    super("run_transaction_deadline_exceeded");
    this.name = "RunTransactionDeadlineError";
  }
}

export type RunTransactionOptions = Readonly<{
  clock?: () => number;
  deadlineAtMs?: number;
  serializationRetryDelay?: (retryOrdinal: number) => Promise<void>;
}>;

async function waitForRunSerializationRetry(retryOrdinal: number): Promise<void> {
  const ceiling = Math.min(100, 10 * (2 ** Math.max(0, retryOrdinal - 1)));
  await new Promise<void>((resolve) =>
    setTimeout(resolve, randomInt(1, ceiling + 1)));
}

function runTransactionRemainingMs(options: RunTransactionOptions): number | null {
  if (options.deadlineAtMs === undefined) return null;
  const remaining = Math.floor(options.deadlineAtMs - (options.clock ?? Date.now)());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new RunTransactionDeadlineError();
  }
  return remaining;
}

function runTransactionTimedOut(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2028") return true;
  return error.code === "P2010" &&
    typeof error.meta === "object" && error.meta !== null &&
    "code" in error.meta &&
    (error.meta.code === "57014" || error.meta.code === "55P03");
}

export async function repeatableReadTransaction<Value>(
  prismaClient: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>,
  options: RunTransactionOptions = {}
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remainingMs = runTransactionRemainingMs(options);
    try {
      return await prismaClient.$transaction(async (tx) => {
        if (remainingMs !== null) {
          const timeout = `${Math.max(1, remainingMs)}ms`;
          await tx.$queryRaw(Prisma.sql`
            SELECT
              set_config('lock_timeout', ${timeout}, true),
              set_config('statement_timeout', ${timeout}, true)
          `);
        }
        return operation(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: remainingMs ?? 10_000,
        timeout: remainingMs ?? 120_000
      });
    } catch (error) {
      if (options.deadlineAtMs !== undefined && (
        runTransactionTimedOut(error) ||
        (options.clock ?? Date.now)() >= options.deadlineAtMs
      )) {
        throw new RunTransactionDeadlineError();
      }
      const assistantSerializationConflict =
        error instanceof AssistantProvenanceSerializationError;
      const skillSerializationConflict = error instanceof SkillProvenanceSerializationError;
      const serializationConflict = assistantSerializationConflict || skillSerializationConflict ||
        isPrismaSerializationConflict(error);
      if (serializationConflict) {
        if (attempt < 2) {
          await (options.serializationRetryDelay ?? waitForRunSerializationRetry)(attempt + 1);
          continue;
        }
        if (assistantSerializationConflict) throw new AssistantRunConflictError();
        if (skillSerializationConflict) throw new SkillRunConflictError();
        throw new ProviderAdmissionConflictError();
      }
      throw error;
    }
  }
  throw new ProviderAdmissionConflictError();
}

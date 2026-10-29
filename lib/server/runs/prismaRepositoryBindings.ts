import { createMcpGuardPlanResolver, type AcceptedMcpGuardPlan } from "../providerRuntime/mcpGuardPlan";
import { createVisionAnalysisPlanResolver, type AcceptedVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { assertMcpToolAccess } from "../mcp/toolAccess";
import {
  createImageModelRoleResolver,
  sameAcceptedImageGenerationPlan,
  type AcceptedImageGenerationPlan
} from "../providerRuntime/imageModelRole";
import { randomInt, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient
} from "@prisma/client";
import {
  decodeAssistantIdentity,
  type AssistantIdentity
} from "../../contracts/assistants";
import {
  decodeStoredChatAssistantOverrides,
  storedChatAssistantOverrides
} from "../../contracts/chats";
import { SKILL_MAX_SELECTED } from "../../contracts/skills";
import { nextChatAssistantOverrides } from "../chats/assistantOverrides";
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
  AssistantRunConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError,
  type AcceptedChatAssistant,
  type AcceptedSkillRun,
  type AcceptedRunDefaults
} from "./runRepositoryContract";
import { isPrismaSerializationConflict, json } from "./prismaRepositoryShared";

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

  const result = await applySettingsUpdateInTransaction(
    tx,
    userId,
    {
      defaultControlValues: {
        [modelControlKey(defaults)]: { ...defaults.controlDefaults }
      }
    },
    [
      {
        modelId: defaults.modelId,
        provider: defaults.provider,
        searchStrategyIds: []
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

/** Recheck live authority and the complete resolved definition at first
 * acceptance. A concurrent edit fails closed before any external dispatch. */
export async function assertAssistantRunProvenance(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    assistantId: string;
    definitionVersion: number;
    userId: string;
  }
): Promise<void> {
  try {
    const definitions = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT definition."ownerUserId"
      FROM "AssistantDefinition" AS definition
      WHERE definition."id" = ${input.assistantId}
        AND definition."version" = ${input.definitionVersion}
        AND definition."archivedAt" IS NULL
      FOR SHARE OF definition
    `;
    const definition = definitions[0];
    if (!definition) throw new AssistantRunConflictError();
    const dependencies = await tx.$queryRaw<Array<{ skillId: string; revisionId: string | null }>>`
      SELECT link."skillId", CASE WHEN skill."ownerUserId" = ${input.userId}
        THEN skill."currentRevisionId" ELSE skill."sharedRevisionId" END AS "revisionId"
      FROM "AssistantSkill" AS link
      INNER JOIN "SkillDefinition" AS skill ON skill."id" = link."skillId"
      WHERE link."assistantId" = ${input.assistantId}
      ORDER BY link."skillId"
      FOR SHARE OF link, skill
    `;
    for (const dependency of dependencies) {
      if (!dependency.revisionId) throw new AssistantRunConflictError();
      try {
        await assertSkillRunProvenance(tx, { ...dependency, revisionId: dependency.revisionId,
          userId: input.userId, admission: true });
      } catch (error) {
        if (error instanceof SkillRunConflictError) throw new AssistantRunConflictError();
        throw error;
      }
    }
    if (definition.ownerUserId === input.userId) return;

    const installationPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "AssistantPublication" AS publication
      WHERE publication."assistantId" = ${input.assistantId}
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

/**
 * Rechecks a personal Assistant run's chat binding under the chat lock and
 * stores the run's override change. The chat must still be bound to the
 * prepared Assistant, or still be unbound when this run binds it; a deleted
 * Assistant's marker or another binding fails closed with the neutral
 * conflict. Stored controls follow their model through `nextChatAssistantOverrides`.
 */
export async function applyAcceptedChatAssistant(
  tx: Pick<Prisma.TransactionClient, "chat">,
  chatId: string,
  accepted: AcceptedChatAssistant
): Promise<void> {
  const chat = await tx.chat.findUnique({
    select: { assistantId: true, assistantOverrides: true },
    where: { id: chatId }
  });
  if (!chat) throw new AssistantRunConflictError();
  const stored = decodeStoredChatAssistantOverrides(chat.assistantOverrides);
  if (stored?.kind === "deleted") throw new AssistantRunConflictError();
  const binding = accepted.bind && chat.assistantId === null;
  if (!binding && chat.assistantId !== accepted.assistantId) throw new AssistantRunConflictError();
  if (!binding && Object.keys(accepted.overridesPatch).length === 0) return;
  // An undecodable stored value counts as none and is replaced.
  const current = !binding && stored?.kind === "overrides" ? stored.overrides : {};
  const next = storedChatAssistantOverrides(nextChatAssistantOverrides(current, accepted.overridesPatch));
  try {
    await tx.chat.update({
      data: {
        ...(binding ? { assistantId: accepted.assistantId } : {}),
        assistantOverrides: next === null ? Prisma.DbNull : next as Prisma.InputJsonValue
      },
      where: { id: chatId }
    });
  } catch (error) {
    // Retried like a provenance conflict; exhausted retries end neutral.
    if (isPrismaSerializationConflict(error)) throw new AssistantProvenanceSerializationError();
    throw error;
  }
}

export function serializeRunAssistantIdentity(modelRun: {
  assistantIdentity?: unknown;
} | undefined): AssistantIdentity | null {
  return decodeAssistantIdentity(modelRun?.assistantIdentity);
}

export async function insertAcceptedMcpRunBindings(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "user" | "mcpToolAccessPolicy">,
  input: {
    bindings: McpRunPlanBinding[] | undefined;
    tools: readonly import("../mcp/toolAccess").McpToolIdentity[];
    runId: string;
    userId: string;
  }
): Promise<void> {
  await assertMcpToolAccess(tx, input.userId, input.tools);
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
        AND (server."ownerUserId" IS NULL OR server."ownerUserId" = ${input.userId})
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
      userId: input.userId,
      admission: true
    });
    const inserted = await tx.$executeRaw`
      INSERT INTO "ModelRunSkillBinding" (
        "modelRunId",
        "skillId",
        "revisionId",
        "alias"
      )
      SELECT
        run."id",
        revision."skillId",
        revision."id",
        ${binding.alias ?? ""}
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
  input: AcceptedSkillRun & { userId: string; admission?: boolean }
): Promise<void> {
  try {
    const definitions = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT definition."ownerUserId"
      FROM "SkillDefinition" AS definition
      INNER JOIN "SkillRevision" AS revision
        ON revision."skillId" = definition."id"
       AND revision."id" = ${input.revisionId}
       AND revision."bundleReady" = true
      WHERE definition."id" = ${input.skillId}
        AND definition."archivedAt" IS NULL
        AND definition."deletedAt" IS NULL
        AND (${input.admission === true} = false OR revision."id" = CASE
          WHEN definition."ownerUserId" = ${input.userId} THEN definition."currentRevisionId"
          ELSE definition."sharedRevisionId" END)
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
    imagePlan?: AcceptedImageGenerationPlan;
    visionAnalysis?: AcceptedVisionAnalysisPlan;
    mcpGuard?: AcceptedMcpGuardPlan;
    plan: ProviderAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  if (input.mcpGuard?.available) {
    const current = await createMcpGuardPlanResolver(tx)();
    if (hashCanonicalMcpValue(current) !== hashCanonicalMcpValue(input.mcpGuard)) throw new ProviderAdmissionConflictError();
    const accepted = input.mcpGuard;
    await tx.providerRunBinding.create({ data: {
      modelRunId: input.runId, bindingKey: "mcp_guard", role: "mcp_guard", credentialSource: "default",
      connectionId: accepted.authority.connectionId, providerModelId: accepted.authority.providerModelId,
      credentialId: accepted.authority.credentialId, credentialVersionId: accepted.authority.credentialVersionId,
      executionSnapshot: json(accepted.snapshot)
    } });
  }
  if (input.visionAnalysis) {
    const current = await createVisionAnalysisPlanResolver(tx)();
    if (hashCanonicalMcpValue(current) !== hashCanonicalMcpValue(input.visionAnalysis)) throw new ProviderAdmissionConflictError();
    const accepted = input.visionAnalysis;
    if (accepted.available) await tx.providerRunBinding.create({ data: {
      modelRunId: input.runId, bindingKey: "vision_analysis", role: "vision_analysis", credentialSource: "default",
      connectionId: accepted.authority.connectionId, providerModelId: accepted.authority.providerModelId,
      credentialId: accepted.authority.credentialId, credentialVersionId: accepted.authority.credentialVersionId,
      executionSnapshot: json(accepted.snapshot)
    } });
  }
  if (input.imagePlan) {
    const accepted = input.imagePlan;
    // The model is still published and the initiating user's current
    // effective choice, fencing the policy version, parameters and exact
    // authority revision.
    const current = await createImageModelRoleResolver(tx).resolveFor({ kind: "personal", userId: input.userId });
    if (!current.ok || !sameAcceptedImageGenerationPlan(current.plan, accepted)) {
      throw new ProviderAdmissionConflictError();
    }
    await tx.providerRunBinding.create({ data: {
      modelRunId: input.runId, bindingKey: "image", role: "image", credentialSource: "default",
      connectionId: accepted.authority.connectionId, providerModelId: accepted.authority.providerModelId,
      credentialId: accepted.authority.credentialId, credentialVersionId: accepted.authority.credentialVersionId,
      executionSnapshot: json(accepted.snapshot)
    } });
  }
  if (!input.plan) return;
  let current: ProviderAdmissionPlan;
  try {
    current = await loadProviderAdmissionPlan(tx, {
      providerConnectionId: input.plan.selection.providerConnectionId,
      providerModelId: input.plan.selection.providerModelId,
      ...(input.plan.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      ...(input.plan.requiresClientSearchRoutes ? { requiresClientSearchRoutes: true } : {}),
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

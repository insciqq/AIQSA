import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_INDEX_PROFILE_ID } from "../../knowledge/knowledgeProfile";
import { MemoryExecutionError } from "../execution";
import { MemoryPersistenceError } from "../persistence/errors";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { createPrismaMemoryRebuildRepository } from "../rebuild/repository";
import { createMemoryRebuildService, MemoryRebuildServiceError } from "../rebuild/service";
import { probeCurrentMemoryEmbeddingPin } from "./handler";

type Settings = Readonly<{
  activeIndexGenerationId: string | null;
  embeddingProviderModelId: string | null;
  memoryRevision: number;
  settingsRevision: number;
  useMemoryFacts: boolean;
}>;

type Generation = Readonly<{
  embeddingProviderModelId: string | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
}>;

export type MemoryEmbeddingSetupDependencies = Readonly<{
  readSettings(userId: string): Promise<Settings>;
  readDefault(): Promise<string | null>;
  readGeneration(userId: string, generationId: string): Promise<Generation | null>;
  hasPendingRebuild(userId: string): Promise<boolean>;
  hasStoppedRebuild(userId: string, generationId: string, modelId: string): Promise<boolean>;
  select(userId: string, modelId: string, settings: Settings): Promise<Settings>;
  rebuild(userId: string, modelId: string, settings: Settings): Promise<void>;
}>;

export type MemoryEmbeddingSetupOutcome =
  "current" | "disabled" | "pending" | "preserved" | "queued" | "unavailable";

/** Initial installation defaults are not a live fallback. Once selected, the
 * owner's embedding space remains independent of later Knowledge changes.
 * A nonzero settings revision may include an explicit clear; never guess. */
export async function ensureMemoryEmbeddingSetup(
  dependencies: MemoryEmbeddingSetupDependencies,
  userId: string
): Promise<MemoryEmbeddingSetupOutcome> {
  try {
    let settings = await dependencies.readSettings(userId);
    if (!settings.useMemoryFacts) return "disabled";
    if (await dependencies.hasPendingRebuild(userId)) return "pending";
    let modelId = settings.embeddingProviderModelId;
    if (!modelId) {
      if (settings.settingsRevision !== 0) return "preserved";
      modelId = await dependencies.readDefault();
      if (!modelId) return "unavailable";
      // The normal repository revalidates this owner's exact entitlement,
      // credential, protocol evidence and both revisions under its lock.
      settings = await dependencies.select(userId, modelId, settings);
    }
    const generation = settings.activeIndexGenerationId
      ? await dependencies.readGeneration(userId, settings.activeIndexGenerationId)
      : null;
    if (generation?.indexMode === "HYBRID" && generation.embeddingProviderModelId === modelId) {
      return "current";
    }
    if (settings.activeIndexGenerationId && await dependencies.hasStoppedRebuild(
      userId, settings.activeIndexGenerationId, modelId
    )) return "preserved";
    // Settings selection and admission are separately durable. A crash between
    // them is repaired next pass without selecting again or replaying a job.
    await dependencies.rebuild(userId, modelId, settings);
    return "queued";
  } catch (error) {
    if (error instanceof MemoryPersistenceError || error instanceof MemoryRebuildServiceError ||
      error instanceof MemoryExecutionError) return "unavailable";
    throw error;
  }
}

const pendingStates = [
  "CLAIMED", "QUEUED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"
] as const;

export function createPrismaMemoryEmbeddingSetup(client: PrismaClient) {
  const settings = createPrismaMemorySettingsRepository(client);
  const rebuild = createMemoryRebuildService({
    probeEmbeddingPin: userId => probeCurrentMemoryEmbeddingPin({}, client, userId),
    repository: createPrismaMemoryRebuildRepository(client)
  });
  const dependencies: MemoryEmbeddingSetupDependencies = {
    readSettings: userId => settings.get(userId),
    readDefault: async () => {
      const profile = await client.knowledgeIndexProfile.findUnique({
        select: { activeRevision: { select: {
          embeddingProviderModelId: true, executionAuthority: true, preflightStatus: true
        } } },
        where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
      });
      const revision = profile?.activeRevision;
      return revision?.executionAuthority === "installation" && revision.preflightStatus === "ready"
        ? revision.embeddingProviderModelId : null;
    },
    readGeneration: (userId, id) => client.memoryIndexGeneration.findFirst({
      select: { embeddingProviderModelId: true, indexMode: true },
      where: { id, state: "ACTIVE", userId }
    }),
    hasPendingRebuild: async userId => Boolean(await client.memoryJob.findFirst({
      select: { id: true },
      where: { kind: "REBUILD_INDEX", state: { in: [...pendingStates] }, userId }
    })),
    hasStoppedRebuild: async (userId, sourceIndexGenerationId, embeddingProviderModelId) =>
      Boolean(await client.memoryIndexGeneration.findFirst({
        select: { id: true },
        where: { embeddingProviderModelId, indexMode: "HYBRID", sourceIndexGenerationId,
          state: { in: ["CANCELLED", "FAILED"] }, userId }
      })),
    select: (userId, modelId, before) => settings.patch(userId, {
      embeddingDeploymentId: modelId,
      expectedMemoryRevision: before.memoryRevision,
      expectedSettingsRevision: before.settingsRevision
    }),
    rebuild: async (userId, modelId, before) => {
      await rebuild.start(userId, {
        embeddingDeploymentId: modelId,
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        operation: "REEMBED"
      });
    }
  };
  let afterUserId = "";
  return Object.freeze({
    ensure: (userId: string) => ensureMemoryEmbeddingSetup(dependencies, userId),
    async reconcile(): Promise<void> {
      // A rotating keyset prevents unavailable owners from starving later
      // accounts. Restarting the scan is safe: settings and jobs are durable.
      const candidates = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        SELECT settings."userId"
        FROM "UserMemorySettings" AS settings
        JOIN "User" AS owner ON owner."id" = settings."userId" AND owner."status" = 'active'::"UserStatus"
        LEFT JOIN "MemoryIndexGeneration" AS active
          ON active."userId" = settings."userId" AND active."id" = settings."activeIndexGenerationId"
        WHERE settings."useMemoryFacts" = TRUE AND settings."userId" > ${afterUserId}
          AND ((settings."embeddingProviderModelId" IS NULL AND settings."settingsRevision" = 0)
            OR (settings."embeddingProviderModelId" IS NOT NULL AND
              (active."id" IS NULL OR active."indexMode" <> 'HYBRID'::"MemoryIndexMode"
                OR active."embeddingProviderModelId" IS DISTINCT FROM settings."embeddingProviderModelId")))
        ORDER BY settings."userId" LIMIT 25
      `);
      for (const candidate of candidates) {
        await ensureMemoryEmbeddingSetup(dependencies, candidate.userId);
        afterUserId = candidate.userId;
      }
      if (candidates.length < 25) afterUserId = "";
    }
  });
}

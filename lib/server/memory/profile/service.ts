import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeMemoryProfileResponse,
  type MemoryProfileContributor,
  type MemoryProfileResponse,
  type MemoryProfileViewState
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import type { LockedMemorySettings } from "../persistence/transaction";
import { memoryProfileAsOf, MEMORY_PROFILE_JOB_PREFIX } from "./contract";
import { prepareGlobalMemoryProfileInput } from "./repository";

export type MemoryProfileServiceErrorCode = "memory_action_failed";

export class MemoryProfileServiceError extends Error {
  readonly code: MemoryProfileServiceErrorCode;

  constructor(code: MemoryProfileServiceErrorCode) {
    super(code);
    this.code = code;
    this.name = "MemoryProfileServiceError";
  }
}
export type MemoryProfileService = Readonly<{
  get(userId: string, now?: Date): Promise<MemoryProfileResponse>;
}>;

type ProfileSettings = LockedMemorySettings & Readonly<{ ownerStatus: string }>;

type ProjectionRow = Readonly<{
  asOf: Date;
  createdAt: Date;
  createdByExecutionId: string;
  id: string;
  inputHash: string;
  languageCode: "en" | "ru";
  memoryGeneration: number;
  memoryRevision: number;
  outputHash: string;
  redactionState: "NOT_NEEDED" | "REDACTED";
  scopeId: string;
  summary: string | null;
}>;

type ContributorRow = MemoryProfileContributor & Readonly<{
  factVersionContentHash: string;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
}>;

function fail(): never {
  throw new MemoryProfileServiceError("memory_action_failed");
}

async function loadSettings(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<LockedMemorySettings | null> {
  const rows = await tx.$queryRaw<ProfileSettings[]>(Prisma.sql`
    SELECT
      settings."userId", settings."useMemoryFacts",
      settings."referenceChatHistory", settings."learnAutomatically",
      settings."memoryGeneration", settings."memoryRevision",
      settings."activeIndexGenerationId", settings."embeddingProviderModelId",
      settings."sensitiveAutomaticPolicy", settings."memoryUiLocale",
      settings."preferredProfileLanguage", settings."memoryConsentRevision",
      settings."settingsRevision", settings."acceptedUtilityEgressFingerprint",
      settings."acceptedUtilityPolicyVersion", settings."acceptedUtilityEgressAt",
      owner."status" AS "ownerStatus"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    WHERE settings."userId" = ${userId}
  `);
  const row = rows[0];
  if (!row || row.ownerStatus !== "active") return null;
  const { ownerStatus: _ownerStatus, ...settings } = row;
  return settings;
}

async function pendingState(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<MemoryProfileViewState> {
  const waiting = await tx.memoryJob.findFirst({
    select: { id: true },
    where: {
      idempotencyFingerprint: { startsWith: MEMORY_PROFILE_JOB_PREFIX },
      kind: "RECALCULATE_WORKING_SET",
      state: "WAITING_FOR_EGRESS_CONSENT",
      userId
    }
  });
  if (waiting) return "WAITING_FOR_EGRESS_CONSENT";
  const pending = await tx.memoryJob.findFirst({
    select: { id: true },
    where: {
      kind: "RECALCULATE_WORKING_SET",
      state: { in: ["CLAIMED", "QUEUED", "RETRYABLE_FAILED"] },
      userId
    }
  });
  return pending ? "PENDING" : "UNAVAILABLE";
}

async function contributors(
  tx: Prisma.TransactionClient,
  settings: LockedMemorySettings,
  projection: ProjectionRow,
  now: Date
): Promise<readonly ContributorRow[]> {
  if (!settings.activeIndexGenerationId) return [];
  return tx.$queryRaw<ContributorRow[]>(Prisma.sql`
    SELECT
      contributor."ordinal",
      contributor."factId",
      contributor."factVersionId",
      contributor."factVersionContentHash",
      contributor."sourceIdentitySnapshot",
      contributor."safetyIdentitySnapshot",
      contributor."suppressionIdentitySnapshot",
      version."displayText" AS "displayText",
      version."sourceMode"::text AS "sourceMode",
      fact."pinned",
      fact."temperatureClass"::text AS "temperatureClass"
    FROM "MemoryProfileProjectionFact" AS contributor
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = contributor."userId"
      AND fact."id" = contributor."factId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = contributor."userId"
      AND version."factId" = contributor."factId"
      AND version."id" = contributor."factVersionId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemorySearchEntry" AS search
      ON search."userId" = contributor."userId"
      AND search."indexGenerationId" = ${settings.activeIndexGenerationId}
      AND search."factVersionId" = contributor."factVersionId"
      AND search."safeContentHash" = contributor."factVersionContentHash"
      AND search."sourceIdentitySnapshot" = contributor."sourceIdentitySnapshot"
      AND search."safetyIdentitySnapshot" = contributor."safetyIdentitySnapshot"
      AND search."suppressionIdentitySnapshot" = contributor."suppressionIdentitySnapshot"
    WHERE contributor."userId" = ${settings.userId}
      AND contributor."projectionId" = ${projection.id}
      AND fact."scopeId" = ${projection.scopeId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."currentVersionId" = contributor."factVersionId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
      AND lower(split_part(version."languageCode", '-', 1)) = ${projection.languageCode}
      AND (version."validFrom" IS NULL OR version."validFrom" <= ${now})
      AND (version."validTo" IS NULL OR version."validTo" > ${now})
    ORDER BY contributor."ordinal"
  `);
}

async function executionIsValid(
  tx: Prisma.TransactionClient,
  settings: LockedMemorySettings,
  projection: ProjectionRow
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "MemoryExecutionBinding" AS binding
      INNER JOIN "UsageEvent" AS usage
        ON usage."userId" = binding."userId"
        AND usage."memoryExecutionBindingId" = binding."id"
      WHERE binding."userId" = ${settings.userId}
        AND binding."id" = ${projection.createdByExecutionId}
        AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
        AND binding."logicalRole" = 'MEMORY_PROFILE'
        AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
        AND binding."inputHash" = ${projection.inputHash}
        AND binding."acceptedOutputHash" = ${projection.outputHash}
    ) AS "valid"
  `);
  return rows[0]?.valid === true;
}

export function createMemoryProfileService(client: PrismaClient = prisma): MemoryProfileService {
  return Object.freeze({
    async get(userId, now = new Date()) {
      if (!userId || userId.length > 256 || !Number.isFinite(now.getTime())) return fail();
      return client.$transaction(async (tx) => {
        const settings = await loadSettings(tx, userId);
        if (!settings) return fail();
        if (!settings.useMemoryFacts) {
          return { memoryRevision: settings.memoryRevision, profile: null, state: "DISABLED" };
        }
        const currentInput = await prepareGlobalMemoryProfileInput(
          tx,
          settings,
          memoryProfileAsOf(now)
        );
        if (!currentInput) {
          return { memoryRevision: settings.memoryRevision, profile: null, state: "EMPTY" };
        }
        const projection = await tx.memoryProfileProjection.findFirst({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            asOf: true,
            createdAt: true,
            createdByExecutionId: true,
            id: true,
            inputHash: true,
            languageCode: true,
            memoryGeneration: true,
            memoryRevision: true,
            outputHash: true,
            redactionState: true,
            scopeId: true,
            summary: true
          },
          where: {
            languageCode: currentInput.languageCode,
            scopeId: currentInput.scopeId,
            state: "ACTIVE",
            userId
          }
        }) as ProjectionRow | null;
        if (projection?.summary && projection.memoryGeneration === settings.memoryGeneration) {
          const exactInput = await prepareGlobalMemoryProfileInput(tx, settings, projection.asOf);
          const rows = await contributors(tx, settings, projection, now);
          const candidateIds = new Set(exactInput?.candidates.map(({ factVersionId }) =>
            factVersionId) ?? []);
          const exact = exactInput?.inputHash === projection.inputHash &&
            rows.length > 0 && rows.length <= 6 &&
            rows.every((row, ordinal) =>
              row.ordinal === ordinal && candidateIds.has(row.factVersionId)) &&
            rows.map(({ displayText }) => displayText).join("\n") === projection.summary &&
            await executionIsValid(tx, settings, projection);
          if (exact) {
            const candidate = {
              memoryRevision: settings.memoryRevision,
              profile: {
                asOf: projection.asOf.toISOString(),
                contributors: rows.map((row) => ({
                  displayText: row.displayText,
                  factId: row.factId,
                  factVersionId: row.factVersionId,
                  ordinal: row.ordinal,
                  pinned: row.pinned,
                  sourceMode: row.sourceMode,
                  temperatureClass: row.temperatureClass
                })),
                createdAt: projection.createdAt.toISOString(),
                id: projection.id,
                languageCode: projection.languageCode,
                memoryRevision: projection.memoryRevision,
                redactionState: projection.redactionState,
                summary: projection.summary
              },
              state: "READY" as const
            };
            const decoded = decodeMemoryProfileResponse(candidate);
            return decoded.ok ? decoded.value : fail();
          }
        }
        const state = await pendingState(tx, userId);
        const candidate = { memoryRevision: settings.memoryRevision, profile: null, state };
        const decoded = decodeMemoryProfileResponse(candidate);
        return decoded.ok ? decoded.value : fail();
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
  });
}

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_DECAY_MAX_RETAINED_TOUCHES,
  MEMORY_DECAY_POLICY_VERSION,
  MEMORY_DECAY_TOUCH_INCREMENT
} from "../../../domain/memory/retrieval";
import { decodeMemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import { memoryReusableFactAuthorityPredicate } from "../synthesis/eligibility";

export type MemoryDecayTouchIdentity = Readonly<{
  bindingId?: string;
  modelRunId?: string;
  retrievalAttemptId?: string;
  userId: string;
}>;

export type MemoryDecayTouchResult = Readonly<{
  eligibleItems: number;
  touchedItems: number;
}>;

export type DirectMemoryFactAccessTouchInput = Readonly<{
  facts: readonly Readonly<{
    factId: string;
    factVersionId: string;
  }>[];
  now: Date;
  userId: string;
}>;

class MemoryDecayTouchIneligibleError extends Error {}

function exactIdentity(input: MemoryDecayTouchIdentity): boolean {
  return [input.bindingId, input.modelRunId, input.retrievalAttemptId]
    .filter((value) => value !== undefined).length === 1 &&
    input.userId.length > 0;
}

async function touchOne(
  client: PrismaClient,
  input: Readonly<{
    factVersionId: string;
    itemId: string;
    now: Date;
    userId: string;
  }>
): Promise<boolean> {
  try {
    return await client.$transaction(async (tx) => {
      const marked = await tx.modelRunMemoryItem.updateMany({
        data: {
          decayTouchedAt: input.now,
          decayTouchPolicyVersion: MEMORY_DECAY_POLICY_VERSION
        },
        where: {
          decayTouchedAt: null,
          factVersionId: input.factVersionId,
          id: input.itemId,
          itemType: "FACT_VERSION",
          userId: input.userId
        }
      });
      if (marked.count === 0) return false;
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "MemoryFact" AS fact
        SET
          "lastUsedAt" = CASE
            WHEN fact."lastUsedAt" IS NULL OR fact."lastUsedAt" < ${input.now}
              THEN ${input.now}
            ELSE fact."lastUsedAt"
          END,
          "temperatureScore" = LEAST(
            1::double precision,
            fact."temperatureScore" + ${MEMORY_DECAY_TOUCH_INCREMENT}
          ),
          "temperatureClass" = CASE
            WHEN LEAST(
              1::double precision,
              fact."temperatureScore" + ${MEMORY_DECAY_TOUCH_INCREMENT}
            ) >= 0.5
              THEN 'HOT'::"MemoryTemperatureClass"
            ELSE 'WARM'::"MemoryTemperatureClass"
          END
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = version."userId"
         AND scope."state" = 'ACTIVE'::"MemoryScopeState"
        WHERE version."userId" = ${input.userId}
          AND version."id" = ${input.factVersionId}
          AND fact."userId" = version."userId"
          AND fact."id" = version."factId"
          AND scope."id" = fact."scopeId"
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND version."state" IN (
            'ACTIVE'::"MemoryFactVersionState",
            'SUPERSEDED'::"MemoryFactVersionState"
          )
          AND version."contentPurgedAt" IS NULL
          AND version."safetyClassificationState" =
            'CLASSIFIED'::"MemorySafetyClassificationState"
          AND version."sensitivityClass" IN (
            'NORMAL'::"MemorySensitivityClass",
            'SENSITIVE'::"MemorySensitivityClass"
          )
          AND (version."expiresAt" IS NULL OR version."expiresAt" > ${input.now})
      `);
      if (updated !== 1) throw new MemoryDecayTouchIneligibleError();
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof MemoryDecayTouchIneligibleError) return false;
    throw error;
  }
}

/** Reads only the exact durable frozen pack. Candidate, RRF and reranker rows
 * are intentionally unreachable from this owner. */
export async function touchFrozenMemoryPack(
  client: PrismaClient,
  input: MemoryDecayTouchIdentity,
  now = new Date()
): Promise<MemoryDecayTouchResult> {
  if (!exactIdentity(input) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("memory_decay_touch_input_invalid");
  }
  const binding = await client.modelRunMemoryBinding.findFirst({
    select: { id: true, settingsSnapshot: true },
    where: {
      ...(input.bindingId ? { id: input.bindingId } : {}),
      ...(input.modelRunId ? { modelRunId: input.modelRunId } : {}),
      ...(input.retrievalAttemptId
        ? { retrievalAttemptId: input.retrievalAttemptId }
        : {}),
      userId: input.userId
    }
  });
  const settings = binding
    ? decodeMemoryPreparingSettingsSnapshot(binding.settingsSnapshot)
    : null;
  if (!binding || !settings?.decayEnabled ||
    settings.decayPolicyVersion !== MEMORY_DECAY_POLICY_VERSION) {
    return { eligibleItems: 0, touchedItems: 0 };
  }
  const items = await client.modelRunMemoryItem.findMany({
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    select: { factVersionId: true, id: true },
    take: MEMORY_DECAY_MAX_RETAINED_TOUCHES,
    where: {
      bindingId: binding.id,
      decayTouchedAt: null,
      factVersionId: { not: null },
      itemType: "FACT_VERSION",
      userId: input.userId
    }
  });
  let touchedItems = 0;
  for (const item of items) {
    if (!item.factVersionId) continue;
    if (await touchOne(client, {
      factVersionId: item.factVersionId,
      itemId: item.id,
      now,
      userId: input.userId
    })) touchedItems += 1;
  }
  return { eligibleItems: items.length, touchedItems };
}

export async function runMemoryDecayTouchWithRetry(
  operation: () => Promise<unknown>,
  maximumAttempts = 2
): Promise<boolean> {
  const attempts = Math.max(1, Math.min(2, Math.floor(maximumAttempts)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return true;
    } catch {
      // The frozen answer is already committed. Retry is bounded and failure
      // deliberately remains isolated from run dispatch.
    }
  }
  return false;
}

export function scheduleMemoryDecayTouch(
  client: PrismaClient,
  input: MemoryDecayTouchIdentity
): void {
  void runMemoryDecayTouchWithRetry(() => touchFrozenMemoryPack(client, input));
}

function boundedTouchIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Applies the same bounded fact-use temperature update as a finalized native
 * run, but from an already packed run-independent fact selection. No query or
 * result text is persisted. */
export async function touchDirectMemoryFactAccess(
  client: PrismaClient,
  input: DirectMemoryFactAccessTouchInput
): Promise<MemoryDecayTouchResult> {
  const facts = [...new Map(input.facts.map((fact) => [
    `${fact.factId}:${fact.factVersionId}`,
    fact
  ])).values()].slice(0, MEMORY_DECAY_MAX_RETAINED_TOUCHES);
  if (
    !boundedTouchIdentifier(input.userId) ||
    !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
    facts.length !== input.facts.length ||
    facts.some((fact) => !boundedTouchIdentifier(fact.factId) ||
      !boundedTouchIdentifier(fact.factVersionId))
  ) throw new Error("memory_decay_touch_input_invalid");
  if (facts.length === 0) return { eligibleItems: 0, touchedItems: 0 };

  const selected = Prisma.sql`(${Prisma.join(facts.map((fact) => Prisma.sql`(
    fact."id" = ${fact.factId} AND version."id" = ${fact.factVersionId}
  )`), " OR ")})`;
  const touchedItems = await client.$executeRaw(Prisma.sql`
    UPDATE "MemoryFact" AS fact
    SET
      "lastUsedAt" = CASE
        WHEN fact."lastUsedAt" IS NULL OR fact."lastUsedAt" < ${input.now}
          THEN ${input.now}
        ELSE fact."lastUsedAt"
      END,
      "temperatureScore" = LEAST(
        1::double precision,
        fact."temperatureScore" + ${MEMORY_DECAY_TOUCH_INCREMENT}
      ),
      "temperatureClass" = CASE
        WHEN LEAST(
          1::double precision,
          fact."temperatureScore" + ${MEMORY_DECAY_TOUCH_INCREMENT}
        ) >= 0.5
          THEN 'HOT'::"MemoryTemperatureClass"
        ELSE 'WARM'::"MemoryTemperatureClass"
      END
    FROM "MemoryFactVersion" AS version,
      "MemoryScope" AS scope,
      "UserMemorySettings" AS settings
    WHERE ${selected}
      AND settings."decayEnabled" = TRUE
      AND settings."decayPolicyVersion" = ${MEMORY_DECAY_POLICY_VERSION}
      AND ${memoryReusableFactAuthorityPredicate(input.userId, {
        fact: Prisma.sql`fact`,
        includePatterns: false,
        lifecycle: "CURRENT",
        scope: Prisma.sql`scope`,
        settings: Prisma.sql`settings`,
        version: Prisma.sql`version`
      })}
  `);
  return { eligibleItems: facts.length, touchedItems };
}

export function scheduleDirectMemoryFactAccessTouch(
  client: PrismaClient,
  input: DirectMemoryFactAccessTouchInput
): void {
  void runMemoryDecayTouchWithRetry(() => touchDirectMemoryFactAccess(client, input));
}

import { Prisma } from "@prisma/client";

export const MEMORY_TEMPERATURE_FEATURE_VERSION = "memory-temperature-features-v1";
export const MEMORY_TEMPERATURE_HOT_THRESHOLD = 0.7;
export const MEMORY_TEMPERATURE_WARM_THRESHOLD = 0.35;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type MemoryTemperatureFeatureInput = Readonly<{
  asOf: Date;
  confidence: number;
  importance: number;
  lastConfirmedAt: Date | null;
  lastUsedAt: Date | null;
  modality:
    | "CONSIDERATION"
    | "CONSTRAINT"
    | "EVENT"
    | "HABIT"
    | "INTENTION"
    | "PLAN"
    | "PREFERENCE"
    | "STATE"
    | "WORKFLOW";
  pinned: boolean;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  validFrom: Date | null;
  validTo: Date | null;
}>;

export type MemoryTemperature = Readonly<{
  temperatureClass: "COLD" | "HOT" | "WARM";
  temperatureScore: number;
}>;

const modalityWeight: Readonly<Record<MemoryTemperatureFeatureInput["modality"], number>> =
  Object.freeze({
    CONSIDERATION: 0.03,
    CONSTRAINT: 0.22,
    EVENT: 0.02,
    HABIT: 0.1,
    INTENTION: 0.18,
    PLAN: 0.18,
    PREFERENCE: 0.1,
    STATE: 0.08,
    WORKFLOW: 0.1
  });

function recencyWeight(value: Date | null, asOf: Date, weights: readonly number[]): number {
  if (!value || value > asOf) return 0;
  const ageDays = (asOf.getTime() - value.getTime()) / DAY_MS;
  if (ageDays <= 7) return weights[0]!;
  if (ageDays <= 30) return weights[1]!;
  if (ageDays <= 180) return weights[2]!;
  return 0;
}
function boundedScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

export function memoryTemperatureClass(
  score: number
): MemoryTemperature["temperatureClass"] {
  if (score >= MEMORY_TEMPERATURE_HOT_THRESHOLD) return "HOT";
  if (score >= MEMORY_TEMPERATURE_WARM_THRESHOLD) return "WARM";
  return "COLD";
}

export function calculateMemoryTemperature(
  input: MemoryTemperatureFeatureInput
): MemoryTemperature {
  if (
    !Number.isFinite(input.asOf.getTime()) ||
    !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 ||
    !Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1
  ) throw new Error("memory_temperature_input_invalid");
  if (
    (input.validFrom && input.validFrom > input.asOf) ||
    (input.validTo && input.validTo <= input.asOf)
  ) return { temperatureClass: "COLD", temperatureScore: 0 };
  if (input.pinned) return { temperatureClass: "HOT", temperatureScore: 1 };
  const score = boundedScore(
    input.importance * 0.3 +
    input.confidence * 0.15 +
    modalityWeight[input.modality] +
    (input.sourceMode === "EXPLICIT" ? 0.1 : 0) +
    recencyWeight(input.lastConfirmedAt, input.asOf, [0.18, 0.12, 0.05]) +
    recencyWeight(input.lastUsedAt, input.asOf, [0.15, 0.1, 0.04])
  );
  return { temperatureClass: memoryTemperatureClass(score), temperatureScore: score };
}

/** SQL equivalent of calculateMemoryTemperature for aliases `fact` and `version`. */
export function memoryTemperatureScoreSql(asOf: Date): Prisma.Sql {
  if (!Number.isFinite(asOf.getTime())) throw new Error("memory_temperature_input_invalid");
  return Prisma.sql`
    CASE
      WHEN (version."validFrom" IS NOT NULL AND version."validFrom" > ${asOf})
        OR (version."validTo" IS NOT NULL AND version."validTo" <= ${asOf})
        THEN 0::double precision
      WHEN fact."pinned" THEN 1::double precision
      ELSE round(least(1::numeric, greatest(0::numeric,
        version."importance"::numeric * 0.30 +
        version."confidence"::numeric * 0.15 +
        CASE version."modality"
          WHEN 'CONSTRAINT'::"MemoryFactModality" THEN 0.22
          WHEN 'INTENTION'::"MemoryFactModality" THEN 0.18
          WHEN 'PLAN'::"MemoryFactModality" THEN 0.18
          WHEN 'HABIT'::"MemoryFactModality" THEN 0.10
          WHEN 'PREFERENCE'::"MemoryFactModality" THEN 0.10
          WHEN 'WORKFLOW'::"MemoryFactModality" THEN 0.10
          WHEN 'STATE'::"MemoryFactModality" THEN 0.08
          WHEN 'CONSIDERATION'::"MemoryFactModality" THEN 0.03
          ELSE 0.02
        END +
        CASE WHEN version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
          THEN 0.10 ELSE 0 END +
        CASE
          WHEN fact."lastConfirmedAt" IS NULL OR fact."lastConfirmedAt" > ${asOf} THEN 0
          WHEN fact."lastConfirmedAt" >= ${asOf} - interval '7 days' THEN 0.18
          WHEN fact."lastConfirmedAt" >= ${asOf} - interval '30 days' THEN 0.12
          WHEN fact."lastConfirmedAt" >= ${asOf} - interval '180 days' THEN 0.05
          ELSE 0
        END +
        CASE
          WHEN fact."lastUsedAt" IS NULL OR fact."lastUsedAt" > ${asOf} THEN 0
          WHEN fact."lastUsedAt" >= ${asOf} - interval '7 days' THEN 0.15
          WHEN fact."lastUsedAt" >= ${asOf} - interval '30 days' THEN 0.10
          WHEN fact."lastUsedAt" >= ${asOf} - interval '180 days' THEN 0.04
          ELSE 0
        END
      )), 6)::double precision
    END
  `;
}

export function memoryTemperatureClassSql(score: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN ${score} >= ${MEMORY_TEMPERATURE_HOT_THRESHOLD}
        THEN 'HOT'::"MemoryTemperatureClass"
      WHEN ${score} >= ${MEMORY_TEMPERATURE_WARM_THRESHOLD}
        THEN 'WARM'::"MemoryTemperatureClass"
      ELSE 'COLD'::"MemoryTemperatureClass"
    END
  `;
}

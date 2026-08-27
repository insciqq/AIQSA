import type {
  MemorySemanticTemporalPerspective,
  MemoryTemporalNormalization,
  MemoryTemporalPointNormalization
} from "../extraction/contract";
import {
  addMemoryCalendar,
  canonicalMemoryTimeZone,
  memoryIsoWeekday,
  memoryLocalDateTimeParts,
  memoryZonedInstant
} from "../../../../domain/memory/temporal/calendar";
import { parseMemoryLocalDate, parseMemoryLocalTime } from "./format";

export const MEMORY_TEMPORAL_RESOLVER_VERSION =
  "memory-temporal-resolution-v3";

export type MemoryTemporalProposal = Readonly<{
  expirationIntent: "EXPLICIT" | "NONE" | "UNKNOWN";
  normalization: MemoryTemporalNormalization;
  perspective: MemorySemanticTemporalPerspective;
  rawExpression: string | null;
}>;

export type ResolvedMemoryTemporal = Readonly<{
  expectedAt: string | null;
  expiresAt: string | null;
  occurredAt: string | null;
  rawExpression: string | null;
  resolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
}>;

function pointInstant(
  normalization: MemoryTemporalPointNormalization,
  observedAt: Date,
  sourceTimeZone: string
): Date | null {
  if (normalization.kind === "NONE") return null;
  if (normalization.kind === "ABSOLUTE") {
    const date = parseMemoryLocalDate(normalization.localDate);
    const time = parseMemoryLocalTime(normalization.localTime);
    const zone = normalization.zone ?? sourceTimeZone;
    if (!date || !time) throw new Error("memory_fact_temporal_invalid");
    if (!canonicalMemoryTimeZone(zone)) throw new Error("memory_fact_temporal_invalid");
    return memoryZonedInstant({ ...date, ...time }, zone);
  }
  if (normalization.kind === "CALENDAR_OFFSET") {
    if (!Number.isSafeInteger(normalization.amount) ||
      normalization.amount < -10_000 || normalization.amount > 10_000) {
      throw new Error("memory_fact_temporal_invalid");
    }
    return addMemoryCalendar(
      observedAt,
      normalization.amount,
      normalization.unit,
      sourceTimeZone
    );
  }
  if (!Number.isSafeInteger(normalization.weekday) ||
    normalization.weekday < 1 || normalization.weekday > 7) {
    throw new Error("memory_fact_temporal_invalid");
  }
  const current = memoryLocalDateTimeParts(observedAt, sourceTimeZone);
  const currentWeekday = memoryIsoWeekday(current.year, current.month, current.day);
  const delta = normalization.direction === "CURRENT"
    ? normalization.weekday - currentWeekday
    : normalization.direction === "NEXT"
      ? (normalization.weekday - currentWeekday + 7) % 7 || 7
      : -((currentWeekday - normalization.weekday + 7) % 7 || 7);
  const start = memoryZonedInstant(
    { ...current, hour: 0, minute: 0, second: 0 },
    sourceTimeZone
  );
  return addMemoryCalendar(start, delta, "DAY", sourceTimeZone);
}

function unresolved(
  proposal: MemoryTemporalProposal,
  resolution: "NONE" | "INVALID"
): ResolvedMemoryTemporal {
  return {
    expectedAt: null,
    expiresAt: null,
    occurredAt: null,
    rawExpression: proposal.rawExpression,
    resolutionEvidence: proposal.normalization.kind === "NONE" &&
      proposal.expirationIntent === "NONE"
      ? null
      : {
          resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
          resolution
        },
    validFrom: null,
    validTo: null
  };
}

/** Resolves only language-independent calendar operations. Invalid optional
 * temporal metadata degrades to null; callers reject when a safe TTL is a
 * prerequisite for candidate eligibility. */
export function resolveMemoryTemporal(input: Readonly<{
  observedAt: Date;
  proposal: MemoryTemporalProposal;
  timeZone: string;
}>): ResolvedMemoryTemporal {
  if (!Number.isFinite(input.observedAt.getTime())) {
    return unresolved(input.proposal, "INVALID");
  }
  try {
    if (!canonicalMemoryTimeZone(input.timeZone)) {
      throw new Error("memory_fact_temporal_invalid");
    }
    if (input.proposal.normalization.kind === "NONE") {
      return unresolved(input.proposal, "NONE");
    }
    let occurredAt: Date | null = null;
    let expectedAt: Date | null = null;
    let expiresAt: Date | null = null;
    let validFrom: Date | null = null;
    let validTo: Date | null = null;

    if (input.proposal.normalization.kind === "INTERVAL") {
      validFrom = pointInstant(
        input.proposal.normalization.start,
        input.observedAt,
        input.timeZone
      );
      validTo = pointInstant(
        input.proposal.normalization.end,
        input.observedAt,
        input.timeZone
      );
      if (!validFrom || !validTo || validTo <= validFrom) {
        throw new Error("memory_fact_temporal_invalid");
      }
      if (input.proposal.expirationIntent === "EXPLICIT") expiresAt = validTo;
    } else {
      const point = pointInstant(
        input.proposal.normalization,
        input.observedAt,
        input.timeZone
      );
      if (!point) throw new Error("memory_fact_temporal_invalid");
      if (input.proposal.expirationIntent === "EXPLICIT") {
        expiresAt = point;
      } else if (input.proposal.perspective === "FUTURE") {
        expectedAt = point;
      } else if (input.proposal.perspective === "FORMER" ||
        input.proposal.perspective === "EVENT") {
        occurredAt = point;
      } else {
        validFrom = point;
      }
    }
    if (expiresAt !== null && expiresAt <= input.observedAt) {
      throw new Error("memory_fact_temporal_invalid");
    }
    return {
      expectedAt: expectedAt?.toISOString() ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      occurredAt: occurredAt?.toISOString() ?? null,
      rawExpression: input.proposal.rawExpression,
      resolutionEvidence: {
        expirationIntent: input.proposal.expirationIntent,
        normalizationKind: input.proposal.normalization.kind,
        perspective: input.proposal.perspective,
        resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
        timeZone: input.timeZone
      },
      validFrom: validFrom?.toISOString() ?? null,
      validTo: validTo?.toISOString() ?? null
    };
  } catch {
    return unresolved(input.proposal, "INVALID");
  }
}

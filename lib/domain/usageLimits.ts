import type {
  EffectiveUsageLimit,
  EffectiveUsageLimits,
  UsageLimitRefusalCode,
  UsageLimitRefusalFacts,
  UsageLimitSource,
  UsageLimitValues,
  UsageUserLimits
} from "../contracts/usageLimits";

export const USAGE_HOUR_MS = 60 * 60 * 1000;
export const USAGE_DAY_MS = 24 * USAGE_HOUR_MS;

/** Budgets follow the UTC calendar month: the installation has no time zone of its own. */
export function utcMonthPeriod(now: Date): Readonly<{ periodStart: Date; resetsAt: Date }> {
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  };
}

export type UsageLimitGroupInput = Readonly<{
  groupId: string;
  limits: UsageLimitValues;
  name: string;
}>;

type LimitField = keyof UsageLimitValues;

const NONE: EffectiveUsageLimit = { source: null, value: null };

function effectiveField(
  field: LimitField,
  input: Readonly<{ groups: readonly UsageLimitGroupInput[]; installation: UsageLimitValues; user: UsageUserLimits | null }>
): EffectiveUsageLimit {
  const own = input.user?.[field] ?? null;
  if (own !== null) return { source: { kind: "user" }, value: own };
  let best: Readonly<{ group: UsageLimitGroupInput; value: number }> | null = null;
  for (const group of input.groups) {
    const value = group.limits[field];
    if (value === null) continue;
    // The most generous configured group wins, like entitlement unions; ties keep a stable name order.
    if (!best || value > best.value || (value === best.value && group.name.localeCompare(best.group.name) < 0)) {
      best = { group, value };
    }
  }
  if (best) {
    const source: UsageLimitSource = { groupId: best.group.groupId, kind: "group", name: best.group.name };
    return { source, value: best.value };
  }
  const fallback = input.installation[field];
  return fallback === null ? NONE : { source: { kind: "installation" }, value: fallback };
}

/**
 * Per-user limits: a set override field wins; otherwise the most generous of
 * the user's active groups that configure the field; otherwise the
 * installation default. Groups without a value do not participate. `exempt`
 * drops every per-user limit; the pooled installation cap is separate.
 */
export function resolveEffectiveUsageLimits(input: Readonly<{
  /** Only the user's active (non-archived) groups. */
  groups: readonly UsageLimitGroupInput[];
  installation: UsageLimitValues;
  user: UsageUserLimits | null;
}>): EffectiveUsageLimits {
  if (input.user?.exempt) {
    return { exempt: true, messagesPerDay: NONE, messagesPerHour: NONE, monthlyBudgetMicros: NONE };
  }
  return {
    exempt: false,
    messagesPerDay: effectiveField("messagesPerDay", input),
    messagesPerHour: effectiveField("messagesPerHour", input),
    monthlyBudgetMicros: effectiveField("monthlyBudgetMicros", input)
  };
}

export type UsageMessageWindow = Readonly<{
  count: number;
  /**
   * When the trailing window next has room under its limit: the counted run
   * that must age out plus the window length. `null` when under the limit or
   * the limit is zero.
   */
  freesAt: Date | null;
}>;

export type UsageAdmissionFacts = Readonly<{
  effective: EffectiveUsageLimits;
  installationCapMicros: number | null;
  installationSpentMicros: number;
  /** Scheduled runs skip message limits; budgets apply to every run. */
  interactive: boolean;
  lastDay: UsageMessageWindow;
  lastHour: UsageMessageWindow;
  now: Date;
  userSpentMicros: number;
}>;

export type UsageAdmissionDecision =
  | Readonly<{ ok: true }>
  | Readonly<{ code: UsageLimitRefusalCode; facts: UsageLimitRefusalFacts; ok: false; retryAfterSeconds: number }>;

function refusal(
  code: UsageLimitRefusalCode,
  facts: Omit<UsageLimitRefusalFacts, "resetsAt">,
  resetsAt: Date,
  now: Date
): UsageAdmissionDecision {
  return {
    code,
    facts: { ...facts, resetsAt: resetsAt.toISOString() },
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))
  };
}

/**
 * Admission-time guard over settled known spend and admitted runs. It is not a
 * spend guarantee: concurrent admissions and accepted runs may overshoot.
 */
export function decideUsageAdmission(facts: UsageAdmissionFacts): UsageAdmissionDecision {
  const { resetsAt } = utcMonthPeriod(facts.now);
  if (facts.installationCapMicros !== null && facts.installationSpentMicros >= facts.installationCapMicros) {
    return refusal("installation_budget_exhausted",
      { limit: null, scope: "installation", used: null, window: "month" }, resetsAt, facts.now);
  }
  const budget = facts.effective.monthlyBudgetMicros.value;
  if (budget !== null && facts.userSpentMicros >= budget) {
    return refusal("usage_budget_exhausted",
      { limit: budget, scope: "user", used: facts.userSpentMicros, window: "month" }, resetsAt, facts.now);
  }
  if (!facts.interactive) return { ok: true };
  const windows = [
    { length: USAGE_HOUR_MS, limit: facts.effective.messagesPerHour.value, name: "hour" as const, observed: facts.lastHour },
    { length: USAGE_DAY_MS, limit: facts.effective.messagesPerDay.value, name: "day" as const, observed: facts.lastDay }
  ];
  for (const { length, limit, name, observed } of windows) {
    if (limit === null || observed.count < limit) continue;
    const freesAt = observed.freesAt ?? new Date(facts.now.getTime() + length);
    return refusal("message_rate_limited",
      { limit, scope: "user", used: observed.count, window: name }, freesAt, facts.now);
  }
  return { ok: true };
}

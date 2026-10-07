import type { ErrorResponse } from "./http";

/**
 * Administrator usage limits. A monthly budget caps the known estimated cost
 * (USD micro-dollars) of settled usage in the current UTC calendar month;
 * message limits cap a user's interactive runs (sends, edits, regenerations;
 * scheduled runs excluded) in the trailing hour and day. Limits guard
 * admission only: accepted runs finish, so spend can overshoot, and usage
 * without a known price is not counted. `null` means "not set".
 */
export const USAGE_LIMIT_BOUNDS = {
  budgetMicros: { min: 0, max: 1_000_000_000_000 },
  messagesPerDay: { min: 0, max: 100_000 },
  messagesPerHour: { min: 0, max: 10_000 }
} as const;

/** Users are warned from this share of a limit. */
export const USAGE_LIMIT_WARNING_RATIO = 0.8;

export type UsageLimitValues = {
  messagesPerDay: number | null;
  messagesPerHour: number | null;
  monthlyBudgetMicros: number | null;
};

/** Installation singleton: a pooled cap for everyone plus per-user defaults. */
export type UsageInstallationLimits = UsageLimitValues & {
  monthlyCapMicros: number | null;
  version: number;
};

export type UsageGroupLimits = UsageLimitValues & { groupId: string };

/** A per-user override. Each set field wins; `exempt` drops every per-user limit, never the pooled cap. */
export type UsageUserLimits = UsageLimitValues & { exempt: boolean; userId: string };

export type UsageLimitSource =
  | { kind: "group"; groupId: string; name: string }
  | { kind: "installation" }
  | { kind: "user" };

export type EffectiveUsageLimit = {
  source: UsageLimitSource | null;
  value: number | null;
};

export type EffectiveUsageLimits = {
  exempt: boolean;
  messagesPerDay: EffectiveUsageLimit;
  messagesPerHour: EffectiveUsageLimit;
  monthlyBudgetMicros: EffectiveUsageLimit;
};

export type UsageMonthPeriod = {
  /** Start of the current UTC calendar month. */
  periodStart: string;
  /** Start of the next UTC calendar month. */
  resetsAt: string;
};

export type AdminUsageLimitGroupRow = UsageLimitValues & {
  archivedAt: string | null;
  groupId: string;
  memberCount: number;
  name: string;
  /** The saved allowance's version; `null` when the group has none. */
  version: number | null;
};

/** A saved user override with the version its next save or removal expects. */
export type AdminUsageUserOverride = UsageUserLimits & { version: number };

export type AdminUsageLimitUserRow = {
  displayName: string;
  effective: EffectiveUsageLimits;
  email: string | null;
  messagesLastDay: number;
  messagesLastHour: number;
  /** Known estimated cost of the user's personal usage in the current UTC month (system usage excluded). */
  monthSpentMicros: number;
  override: AdminUsageUserOverride | null;
  status: string;
  userId: string;
};

export type AdminUsageLimits = UsageMonthPeriod & {
  groups: AdminUsageLimitGroupRow[];
  installation: UsageInstallationLimits;
  /** Known estimated cost of every user in the current UTC month, system usage included. */
  installationSpentMicros: number;
  users: AdminUsageLimitUserRow[];
};

export type AdminUsageLimitsResponse = { limits: AdminUsageLimits };

export type AdminUsageInstallationLimitsInput = Omit<UsageInstallationLimits, "version"> & { expectedVersion: number };

/**
 * Group and user saves name the version they were edited from; `null` (absent
 * on the wire) expects that nothing is saved yet. A different saved version
 * answers `usage_limits_stale`.
 */
export type AdminUsageGroupLimitsInput = UsageLimitValues & { expectedVersion: number | null };
export type AdminUsageUserLimitsInput = UsageLimitValues & { exempt: boolean; expectedVersion: number | null };

export type AdminUsageLimitsErrorCode =
  | "forbidden"
  | "group_not_found"
  | "json_required"
  | "unauthorized"
  | "usage_limits_action_failed"
  | "usage_limits_input_invalid"
  | "usage_limits_stale"
  | "user_not_found";

export type AdminUsageLimitsErrorResponse = ErrorResponse<AdminUsageLimitsErrorCode>;

/** What a user may see about their own limits. Installation amounts stay private. */
export type UserUsageLimitStatus = UsageMonthPeriod & {
  /** The pooled installation cap is reached: no new messages until it resets or is raised. */
  installationExhausted: boolean;
  messages: {
    dayFreesAt: string | null;
    hourFreesAt: string | null;
    lastDay: number;
    lastHour: number;
    perDay: number | null;
    perHour: number | null;
  };
  monthlyBudgetMicros: number | null;
  /** Known estimated cost of the user's personal usage in the current UTC month. */
  monthSpentMicros: number;
};

export type UserUsageLimitStatusResponse = { usageLimits: UserUsageLimitStatus };

export const USAGE_LIMIT_REFUSAL_CODES = [
  "installation_budget_exhausted",
  "message_rate_limited",
  "usage_budget_exhausted"
] as const;
export type UsageLimitRefusalCode = (typeof USAGE_LIMIT_REFUSAL_CODES)[number];

/** Facts of an admission refusal; the response also carries `retry-after`. */
export type UsageLimitRefusalFacts = {
  /** Micro-dollars for budgets, messages for rate limits; installation amounts are never disclosed. */
  limit: number | null;
  resetsAt: string;
  scope: "installation" | "user";
  used: number | null;
  window: "day" | "hour" | "month";
};

export type UsageLimitRefusalResponse = ErrorResponse<UsageLimitRefusalCode> & { usageLimit: UsageLimitRefusalFacts };

export function isUsageLimitRefusalCode(value: unknown): value is UsageLimitRefusalCode {
  return typeof value === "string" && (USAGE_LIMIT_REFUSAL_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, bound: Readonly<{ min: number; max: number }>): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= bound.min && value <= bound.max;
}

function nullableBounded(value: unknown, bound: Readonly<{ min: number; max: number }>): value is number | null {
  return value === null || bounded(value, bound);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const VERSION_BOUND = { min: 1, max: Number.MAX_SAFE_INTEGER } as const;

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || instant(value);
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** Decodes the three limit fields, rejecting keys other than those and `extraKeys`. */
export function decodeUsageLimitValues(value: unknown, extraKeys: readonly string[] = []): UsageLimitValues | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["messagesPerDay", "messagesPerHour", "monthlyBudgetMicros", ...extraKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!nullableBounded(value.monthlyBudgetMicros, USAGE_LIMIT_BOUNDS.budgetMicros) ||
    !nullableBounded(value.messagesPerHour, USAGE_LIMIT_BOUNDS.messagesPerHour) ||
    !nullableBounded(value.messagesPerDay, USAGE_LIMIT_BOUNDS.messagesPerDay)) return null;
  return {
    messagesPerDay: value.messagesPerDay,
    messagesPerHour: value.messagesPerHour,
    monthlyBudgetMicros: value.monthlyBudgetMicros
  };
}

export function decodeAdminUsageInstallationLimitsInput(value: unknown): AdminUsageInstallationLimitsInput | null {
  const values = decodeUsageLimitValues(value, ["expectedVersion", "monthlyCapMicros"]);
  if (!values || !isRecord(value) || !bounded(value.expectedVersion, VERSION_BOUND) ||
    !nullableBounded(value.monthlyCapMicros, USAGE_LIMIT_BOUNDS.budgetMicros)) return null;
  return { ...values, expectedVersion: value.expectedVersion, monthlyCapMicros: value.monthlyCapMicros };
}

/** `null` for an absent or null `expectedVersion`, `undefined` for an invalid one. */
export function decodeExpectedUsageLimitVersion(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return bounded(value, VERSION_BOUND) ? value : undefined;
}

export function decodeAdminUsageGroupLimitsInput(value: unknown): AdminUsageGroupLimitsInput | null {
  const values = decodeUsageLimitValues(value, ["expectedVersion"]);
  const expectedVersion = isRecord(value) ? decodeExpectedUsageLimitVersion(value.expectedVersion) : undefined;
  if (!values || expectedVersion === undefined) return null;
  return { ...values, expectedVersion };
}

export function decodeAdminUsageUserLimitsInput(value: unknown): AdminUsageUserLimitsInput | null {
  const values = decodeUsageLimitValues(value, ["exempt", "expectedVersion"]);
  if (!values || !isRecord(value) || typeof value.exempt !== "boolean") return null;
  const expectedVersion = decodeExpectedUsageLimitVersion(value.expectedVersion);
  if (expectedVersion === undefined) return null;
  return { ...values, exempt: value.exempt, expectedVersion };
}

function source(value: unknown): value is UsageLimitSource | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "group") return text(value.groupId, 128) && text(value.name, 256);
  return value.kind === "installation" || value.kind === "user";
}

function effectiveLimit(value: unknown, bound: Readonly<{ min: number; max: number }>): value is EffectiveUsageLimit {
  return isRecord(value) && source(value.source) && nullableBounded(value.value, bound) &&
    (value.value === null) === (value.source === null);
}

function effectiveLimits(value: unknown): value is EffectiveUsageLimits {
  return isRecord(value) && typeof value.exempt === "boolean" &&
    effectiveLimit(value.monthlyBudgetMicros, USAGE_LIMIT_BOUNDS.budgetMicros) &&
    effectiveLimit(value.messagesPerHour, USAGE_LIMIT_BOUNDS.messagesPerHour) &&
    effectiveLimit(value.messagesPerDay, USAGE_LIMIT_BOUNDS.messagesPerDay);
}

function userOverride(value: unknown): value is AdminUsageUserOverride | null {
  if (value === null) return true;
  return isRecord(value) && text(value.userId, 128) && typeof value.exempt === "boolean" &&
    bounded(value.version, VERSION_BOUND) && decodeUsageLimitValues(value, ["exempt", "userId", "version"]) !== null;
}

export function decodeAdminUsageLimitsResponse(value: unknown): AdminUsageLimitsResponse | null {
  if (!isRecord(value) || !isRecord(value.limits)) return null;
  const limits = value.limits;
  const installation = limits.installation;
  if (!instant(limits.periodStart) || !instant(limits.resetsAt) || !count(limits.installationSpentMicros) ||
    !isRecord(installation) || !bounded(installation.version, VERSION_BOUND) ||
    !nullableBounded(installation.monthlyCapMicros, USAGE_LIMIT_BOUNDS.budgetMicros) ||
    decodeUsageLimitValues(installation, ["monthlyCapMicros", "version"]) === null ||
    !Array.isArray(limits.groups) || !limits.groups.every((row) => isRecord(row) &&
      text(row.groupId, 128) && text(row.name, 256) && nullableInstant(row.archivedAt) && count(row.memberCount) &&
      nullableBounded(row.version, VERSION_BOUND) &&
      decodeUsageLimitValues(row, ["archivedAt", "groupId", "memberCount", "name", "version"]) !== null) ||
    !Array.isArray(limits.users) || !limits.users.every((row) => isRecord(row) &&
      text(row.userId, 128) && text(row.displayName, 512) && (row.email === null || text(row.email, 512)) &&
      text(row.status, 64) && count(row.monthSpentMicros) && count(row.messagesLastHour) &&
      count(row.messagesLastDay) && effectiveLimits(row.effective) && userOverride(row.override))) {
    return null;
  }
  return value as AdminUsageLimitsResponse;
}

export function decodeUserUsageLimitStatusResponse(value: unknown): UserUsageLimitStatusResponse | null {
  if (!isRecord(value) || !isRecord(value.usageLimits)) return null;
  const status = value.usageLimits;
  const messages = status.messages;
  if (!instant(status.periodStart) || !instant(status.resetsAt) || typeof status.installationExhausted !== "boolean" ||
    !nullableBounded(status.monthlyBudgetMicros, USAGE_LIMIT_BOUNDS.budgetMicros) || !count(status.monthSpentMicros) ||
    !isRecord(messages) || !count(messages.lastHour) || !count(messages.lastDay) ||
    !nullableBounded(messages.perHour, USAGE_LIMIT_BOUNDS.messagesPerHour) ||
    !nullableBounded(messages.perDay, USAGE_LIMIT_BOUNDS.messagesPerDay) ||
    !nullableInstant(messages.hourFreesAt) || !nullableInstant(messages.dayFreesAt)) {
    return null;
  }
  return value as UserUsageLimitStatusResponse;
}

/** Facts of a 429 refusal body, or `null` when the body is not a usage-limit refusal. */
export function decodeUsageLimitRefusal(value: unknown): UsageLimitRefusalResponse | null {
  if (!isRecord(value) || !isUsageLimitRefusalCode(value.error) || !isRecord(value.usageLimit)) return null;
  const facts = value.usageLimit;
  if (!instant(facts.resetsAt) || !(facts.scope === "installation" || facts.scope === "user") ||
    !(facts.window === "day" || facts.window === "hour" || facts.window === "month") ||
    !(facts.limit === null || count(facts.limit)) || !(facts.used === null || count(facts.used))) return null;
  return value as UsageLimitRefusalResponse;
}

const USD_INPUT = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,6}))?\s*$/u;

/** Exact decimal USD text ("12", "12.5", "$0.25") to micro-dollars; `null` for invalid input. */
export function parseUsdToMicros(input: string): number | null {
  const match = USD_INPUT.exec(input);
  if (!match) return null;
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0") || "0");
  return bounded(micros, USAGE_LIMIT_BOUNDS.budgetMicros) ? micros : null;
}

/** Micro-dollars as editable USD text without trailing zeros beyond cents. */
export function formatMicrosAsUsdInput(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction.length < 2 ? fraction.padEnd(2, "0") : fraction}`;
}

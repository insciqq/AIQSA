import { formatEstimatedCostMicros } from "@/lib/domain/formatEstimatedCost";
import {
  formatMicrosAsUsdInput,
  parseUsdToMicros,
  USAGE_LIMIT_BOUNDS,
  USAGE_LIMIT_WARNING_RATIO,
  type AdminUsageLimitUserRow,
  type EffectiveUsageLimit,
  type UsageLimitValues
} from "@/lib/contracts/usageLimits";

export type UsageLimitField = keyof UsageLimitValues;
export type UsageLimitDraft = Readonly<Record<UsageLimitField, string>>;
export type UsageLimitFieldErrors = Partial<Record<UsageLimitField, string>>;

export const USAGE_LIMIT_FIELDS: readonly UsageLimitField[] = ["monthlyBudgetMicros", "messagesPerHour", "messagesPerDay"];

/** Exact administrator amounts: `$1,250.50`, `$0.25`, `$0.000001`. */
export function formatUsdLimit(micros: number): string {
  const [whole = "0", fraction = "00"] = formatMicrosAsUsdInput(micros).split(".");
  return `$${Number(whole).toLocaleString("en-US")}.${fraction}`;
}

/** Spend is an estimate; a month without known cost is plainly zero. */
export function formatSpend(micros: number): string {
  return micros === 0 ? "$0.00" : formatEstimatedCostMicros(micros);
}

export function formatLimitValue(field: UsageLimitField, value: number | null): string | null {
  if (value === null) return null;
  return field === "monthlyBudgetMicros" ? formatUsdLimit(value) : value.toLocaleString("en-US");
}

export type UsageBudgetState = "near" | "none" | "ok" | "reached" | "zero";

/** A zero budget blocks on purpose; it is not a budget that ran out. */
export function usageBudgetState(spent: number, budget: number | null): UsageBudgetState {
  if (budget === null) return "none";
  if (budget === 0) return "zero";
  if (spent >= budget) return "reached";
  return spent >= budget * USAGE_LIMIT_WARNING_RATIO ? "near" : "ok";
}

export function usagePercent(spent: number, limit: number): number {
  return limit > 0 ? Math.floor((spent / limit) * 100) : 100;
}

export function limitSourceLabel(limit: EffectiveUsageLimit, exempt: boolean): string {
  if (exempt) return "Exempt";
  const { source } = limit;
  if (!source) return "No limit";
  if (source.kind === "user") return "Override";
  if (source.kind === "group") return `Group: ${source.name}`;
  return "Default";
}

function budgetShare(user: AdminUsageLimitUserRow): number {
  const budget = user.effective.monthlyBudgetMicros.value;
  if (budget === null) return -1;
  return budget === 0 ? 1 : user.monthSpentMicros / budget;
}

/** Most of their budget used first; people without a budget follow by spend. */
export function sortUsersByBudgetShare(users: readonly AdminUsageLimitUserRow[]): AdminUsageLimitUserRow[] {
  return [...users].sort((left, right) =>
    budgetShare(right) - budgetShare(left) ||
    right.monthSpentMicros - left.monthSpentMicros ||
    left.displayName.localeCompare(right.displayName) ||
    left.userId.localeCompare(right.userId));
}

export function budgetStateCounts(users: readonly AdminUsageLimitUserRow[]): Readonly<{ near: number; reached: number; withBudget: number }> {
  let near = 0;
  let reached = 0;
  let withBudget = 0;
  for (const user of users) {
    if (user.status !== "active") continue;
    const state = usageBudgetState(user.monthSpentMicros, user.effective.monthlyBudgetMicros.value);
    if (state === "none") continue;
    withBudget += 1;
    if (state === "near") near += 1;
    if (state === "reached") reached += 1;
  }
  return { near, reached, withBudget };
}

export function draftFromValues(values: UsageLimitValues): UsageLimitDraft {
  return {
    messagesPerDay: values.messagesPerDay === null ? "" : String(values.messagesPerDay),
    messagesPerHour: values.messagesPerHour === null ? "" : String(values.messagesPerHour),
    monthlyBudgetMicros: values.monthlyBudgetMicros === null ? "" : formatMicrosAsUsdInput(values.monthlyBudgetMicros)
  };
}

const MESSAGE_BOUNDS = {
  messagesPerDay: USAGE_LIMIT_BOUNDS.messagesPerDay,
  messagesPerHour: USAGE_LIMIT_BOUNDS.messagesPerHour
} as const;

export const USD_FIELD_ERROR = "Enter a dollar amount from 0 to 1,000,000, like 25 or 12.50.";

/** Empty means not set; anything else must be an exact USD amount. */
export function parseUsdField(text: string): Readonly<{ error: string } | { value: number | null }> {
  if (!text.trim()) return { value: null };
  const micros = parseUsdToMicros(text);
  return micros === null ? { error: USD_FIELD_ERROR } : { value: micros };
}

export function parseMessageField(
  field: "messagesPerDay" | "messagesPerHour",
  text: string
): Readonly<{ error: string } | { value: number | null }> {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  const bound = MESSAGE_BOUNDS[field];
  const value = /^\d{1,7}$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(value) && value >= bound.min && value <= bound.max
    ? { value }
    : { error: `Enter a whole number from 0 to ${bound.max.toLocaleString("en-US")}.` };
}

export function parseLimitDraft(draft: UsageLimitDraft):
  Readonly<{ errors: UsageLimitFieldErrors; values: UsageLimitValues | null }> {
  const budget = parseUsdField(draft.monthlyBudgetMicros);
  const perHour = parseMessageField("messagesPerHour", draft.messagesPerHour);
  const perDay = parseMessageField("messagesPerDay", draft.messagesPerDay);
  const errors: UsageLimitFieldErrors = {
    ...("error" in budget ? { monthlyBudgetMicros: budget.error } : {}),
    ...("error" in perHour ? { messagesPerHour: perHour.error } : {}),
    ...("error" in perDay ? { messagesPerDay: perDay.error } : {})
  };
  if ("error" in budget || "error" in perHour || "error" in perDay) return { errors, values: null };
  return { errors, values: { messagesPerDay: perDay.value, messagesPerHour: perHour.value, monthlyBudgetMicros: budget.value } };
}

export function sameDraft(left: UsageLimitDraft, right: UsageLimitDraft): boolean {
  return USAGE_LIMIT_FIELDS.every((field) => left[field] === right[field]);
}

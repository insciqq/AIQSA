import {
  formatMicrosAsUsdInput,
  USAGE_LIMIT_WARNING_RATIO,
  type UserUsageLimitStatus
} from "@/lib/contracts/usageLimits";
import { formatEstimatedCostMicros } from "@/lib/domain/formatEstimatedCost";

/** Viewer formatting; tests pin both, the browser leaves them to the device. */
export type UsageLimitFormat = Readonly<{ locale?: string; now: Date; timeZone?: string }>;

export type UsageLimitTone = "caution" | "critical" | "ok";

export type UsageLimitNotice = Readonly<{ text: string; tone: Exclude<UsageLimitTone, "ok"> }>;

type Window = Readonly<{ count: number; freesAt: string | null; limit: number; name: "day" | "hour" }>;

const WINDOW_PHRASE: Readonly<Record<Window["name"], string>> = {
  day: "in the last 24 hours",
  hour: "in the last hour"
};

/** Exact administrator amounts: `$1,250.50`, `$0.25`, `$0.000001`. */
export function formatUsageBudget(micros: number): string {
  const [whole = "0", fraction = "00"] = formatMicrosAsUsdInput(micros).split(".");
  return `$${Number(whole).toLocaleString("en-US")}.${fraction}`;
}

/** Spend is an estimate of known cost; a month without known cost is plainly zero. */
export function formatUsageSpend(micros: number): string {
  return micros === 0 ? "$0.00" : formatEstimatedCostMicros(micros);
}

function dayKey(date: Date, format: UsageLimitFormat): string {
  return new Intl.DateTimeFormat(format.locale, {
    day: "numeric",
    month: "numeric",
    timeZone: format.timeZone,
    year: "numeric"
  }).format(date);
}

/** "at 12:20 PM" today in the viewer's zone, otherwise "on Nov 1 at 3:00 AM". */
export function formatUsageResetTime(iso: string, format: UsageLimitFormat): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat(format.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: format.timeZone
  }).format(date);
  if (dayKey(date, format) === dayKey(format.now, format)) return `at ${time}`;
  const day = new Intl.DateTimeFormat(format.locale, {
    day: "numeric",
    month: "short",
    timeZone: format.timeZone
  }).format(date);
  return `on ${day} at ${time}`;
}

function windows(status: UserUsageLimitStatus): Window[] {
  const { messages } = status;
  const result: Window[] = [];
  if (messages.perHour !== null) {
    result.push({ count: messages.lastHour, freesAt: messages.hourFreesAt, limit: messages.perHour, name: "hour" });
  }
  if (messages.perDay !== null) {
    result.push({ count: messages.lastDay, freesAt: messages.dayFreesAt, limit: messages.perDay, name: "day" });
  }
  return result;
}

function share(used: number, limit: number): number {
  return limit > 0 ? used / limit : 1;
}

function budgetReached(status: UserUsageLimitStatus): boolean {
  return status.monthlyBudgetMicros !== null && status.monthSpentMicros >= status.monthlyBudgetMicros;
}

/** Whether Settings has anything to say: a personal limit applies or the shared cap is reached. */
export function usageLimitsApply(status: UserUsageLimitStatus): boolean {
  return status.installationExhausted || status.monthlyBudgetMicros !== null ||
    status.messages.perHour !== null || status.messages.perDay !== null;
}

export function usageLimitTone(used: number, limit: number): UsageLimitTone {
  if (used >= limit) return "critical";
  return share(used, limit) >= USAGE_LIMIT_WARNING_RATIO ? "caution" : "ok";
}

function reachedWindowNotice(reached: readonly Window[], format: UsageLimitFormat): UsageLimitNotice {
  const closed = reached.find((window) => window.limit === 0);
  if (closed) {
    return {
      text: `Your administrator allows no messages ${closed.name === "hour" ? "per hour" : "per day"}. Ask them to raise the limit.`,
      tone: "critical"
    };
  }
  // Both windows full: sending resumes only when the later one has room.
  const binding = reached.reduce((latest, window) =>
    (window.freesAt ?? "") > (latest.freesAt ?? "") ? window : latest);
  const when = binding.freesAt
    ? `You can send again ${formatUsageResetTime(binding.freesAt, format)}.`
    : "You can send again once earlier messages leave the window.";
  return {
    text: `You've sent ${binding.count} of ${binding.limit} messages allowed ${WINDOW_PHRASE[binding.name]}. ${when}`,
    tone: "critical"
  };
}

/**
 * The composer's notice: critical when the shared cap, the budget or a
 * message window is reached, caution from the warning share, nothing
 * otherwise. Informational only: admission stays with the server.
 */
export function usageLimitNotice(status: UserUsageLimitStatus | null, format: UsageLimitFormat): UsageLimitNotice | null {
  if (!status) return null;
  const resets = formatUsageResetTime(status.resetsAt, format);
  if (status.installationExhausted) {
    return {
      text: `New messages are paused: the shared monthly usage limit is reached. It resets ${resets}, or sooner if your administrator raises it.`,
      tone: "critical"
    };
  }
  const budget = status.monthlyBudgetMicros;
  if (budget !== null && budgetReached(status)) {
    return {
      text: budget === 0
        ? "Your monthly budget is $0.00, so new messages are unavailable. Ask your administrator to raise it."
        : `You've used your monthly budget (${formatUsageSpend(status.monthSpentMicros)} of ${formatUsageBudget(budget)}). New messages resume ${resets}.`,
      tone: "critical"
    };
  }
  const limited = windows(status);
  const reached = limited.filter((window) => window.count >= window.limit);
  if (reached.length > 0) return reachedWindowNotice(reached, format);

  type Candidate = Readonly<{ share: number; text: string }>;
  const candidates: Candidate[] = [];
  if (budget !== null) {
    candidates.push({
      share: share(status.monthSpentMicros, budget),
      text: `You've used ${formatUsageSpend(status.monthSpentMicros)} of your ${formatUsageBudget(budget)} monthly budget. It resets ${resets}.`
    });
  }
  for (const window of limited) {
    candidates.push({
      share: share(window.count, window.limit),
      text: `You've sent ${window.count} of ${window.limit} messages allowed ${WINDOW_PHRASE[window.name]}.`
    });
  }
  // The most pressing limit speaks; ties keep the budget first.
  const pressing = candidates
    .filter((candidate) => candidate.share >= USAGE_LIMIT_WARNING_RATIO)
    .reduce<Candidate | null>((best, candidate) => !best || candidate.share > best.share ? candidate : best, null);
  return pressing ? { text: pressing.text, tone: "caution" } : null;
}

export type UsageLimitsSettingsView = Readonly<{
  budget: Readonly<{
    percent: number;
    resets: string;
    text: string;
    tone: UsageLimitTone;
  }> | null;
  /** The shared cap is reached; no installation amounts are known here. */
  installation: string | null;
  messages: Readonly<{ text: string; tone: UsageLimitTone }> | null;
}>;

/** Settings → Account: `null` when no limit applies to the user. */
export function usageLimitsSettingsView(status: UserUsageLimitStatus, format: UsageLimitFormat): UsageLimitsSettingsView | null {
  if (!usageLimitsApply(status)) return null;
  const resets = formatUsageResetTime(status.resetsAt, format);
  const budget = status.monthlyBudgetMicros;
  const limited = windows(status);
  const tones = limited.map((window) => usageLimitTone(window.count, window.limit));
  return {
    budget: budget === null ? null : {
      percent: budget > 0 ? Math.min(100, Math.floor((status.monthSpentMicros / budget) * 100)) : 100,
      resets: `Resets ${resets}. Months follow UTC.`,
      text: `${formatUsageSpend(status.monthSpentMicros)} of ${formatUsageBudget(budget)}`,
      tone: usageLimitTone(status.monthSpentMicros, budget)
    },
    installation: status.installationExhausted
      ? `New messages are paused for everyone: the shared monthly usage limit is reached. It resets ${resets}.`
      : null,
    messages: limited.length === 0 ? null : {
      text: limited.map((window) => `${window.count} of ${window.limit} ${WINDOW_PHRASE[window.name]}`).join(" · "),
      tone: tones.includes("critical") ? "critical" : tones.includes("caution") ? "caution" : "ok"
    }
  };
}

/**
 * The next instant at which a reached limit frees up, so an open composer can
 * drop its notice without waiting for focus. `null` when nothing is reached.
 */
export function usageLimitNextChange(status: UserUsageLimitStatus): string | null {
  const instants: string[] = [];
  if (status.installationExhausted || (budgetReached(status) && status.monthlyBudgetMicros !== 0)) {
    instants.push(status.resetsAt);
  }
  for (const window of windows(status)) {
    if (window.count >= window.limit && window.freesAt) instants.push(window.freesAt);
  }
  return instants.reduce<string | null>((earliest, instant) =>
    earliest === null || Date.parse(instant) < Date.parse(earliest) ? instant : earliest, null);
}

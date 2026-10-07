import type { BrowserPushMessage } from "../../contracts/browserPush";
import { USAGE_LIMIT_WARNING_RATIO, type AdminUsageLimits } from "../../contracts/usageLimits";

export type UsageLimitAlertKind = "installation_cap_near" | "installation_cap_reached" | "user_budget_reached";
export type UsageLimitInstallationAlertKind = Exclude<UsageLimitAlertKind, "user_budget_reached">;

/** One alert per UTC month: the pooled cap thresholds have no user, a reached budget names its user. */
export type UsageLimitAlertKey = Readonly<{ kind: UsageLimitAlertKind; userId: string | null }>;

export type UsageLimitInstallationAlert = Readonly<{
  capMicros: number;
  kind: UsageLimitInstallationAlertKind;
  spentMicros: number;
}>;

export type UsageLimitUserAlert = Readonly<{
  budgetMicros: number;
  displayName: string;
  spentMicros: number;
  userId: string;
}>;

export type DueUsageLimitAlerts = Readonly<{
  installation: UsageLimitInstallationAlert | null;
  periodStart: Date;
  resetsAt: Date;
  users: readonly UsageLimitUserAlert[];
}>;

/** What every administrator receives for one alert: an email (the recipient is added per address) and a push. */
export type UsageLimitAlertContent = Readonly<{
  email: Readonly<{ subject: string; text: string }>;
  push: BrowserPushMessage;
}>;

/**
 * Users one check claims at most, counted among those still claimable, so the
 * rest are claimed by the next checks and settled users never fill a batch.
 */
export const USAGE_LIMIT_ALERT_USERS_PER_CHECK = 200;
/** Users an email names; the rest are counted. */
const EMAIL_USER_LINES = 50;
/** Users a push names; the rest are counted, keeping the encrypted message small. */
const PUSH_USER_NAMES = 3;
const NAME_MAX_CHARS = 80;
/** Control Center → Budgets & limits. */
export const USAGE_LIMITS_ADMIN_PATH = "/admin?section=limits";

/**
 * The alerts the current UTC month has reached, from the same facts and
 * thresholds as the Control Center attention items: the pooled cap at 80%
 * (below 100%) and at 100%, and every active user at a personal budget above
 * zero. A zero cap or budget blocks on purpose and is not alerted.
 */
export function dueUsageLimitAlerts(limits: AdminUsageLimits): DueUsageLimitAlerts {
  const cap = limits.installation.monthlyCapMicros;
  const spent = limits.installationSpentMicros;
  let installation: UsageLimitInstallationAlert | null = null;
  if (cap !== null && cap > 0 && spent >= cap * USAGE_LIMIT_WARNING_RATIO) {
    installation = { capMicros: cap, kind: spent >= cap ? "installation_cap_reached" : "installation_cap_near", spentMicros: spent };
  }
  const users: UsageLimitUserAlert[] = [];
  for (const user of limits.users) {
    const budget = user.effective.monthlyBudgetMicros.value;
    if (user.status !== "active" || budget === null || budget <= 0 || user.monthSpentMicros < budget) continue;
    users.push({ budgetMicros: budget, displayName: user.displayName, spentMicros: user.monthSpentMicros, userId: user.userId });
  }
  return { installation, periodStart: new Date(limits.periodStart), resetsAt: new Date(limits.resetsAt), users };
}

const exactUsd = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 6, minimumFractionDigits: 2, style: "currency" });
const centsUsd = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const utcDate = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" });

/** Limits are shown exactly as configured; spend is an estimate shown to the cent. */
function limitUsd(micros: number): string {
  return exactUsd.format(micros / 1_000_000);
}

function spentUsd(micros: number): string {
  return centsUsd.format(micros / 1_000_000);
}

function resetDate(resetsAt: Date): string {
  return `${utcDate.format(resetsAt)} (UTC)`;
}

function displayName(value: string): string {
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim() || "Unnamed user";
  const characters = [...name];
  return characters.length > NAME_MAX_CHARS ? `${characters.slice(0, NAME_MAX_CHARS - 1).join("")}…` : name;
}

function adminLink(appBaseUrl: string): string {
  return new URL(USAGE_LIMITS_ADMIN_PATH, appBaseUrl).toString();
}

const ESTIMATE_NOTE = "Amounts are estimated from the configured model prices; usage without a known price is not counted.";

/**
 * The pooled cap alert. Plain facts only: spend, cap, reset date and a link
 * to Control Center; never prompts, chats or people.
 */
export function installationAlertContent(alert: UsageLimitInstallationAlert, input: Readonly<{ appBaseUrl: string; resetsAt: Date }>): UsageLimitAlertContent {
  const reached = alert.kind === "installation_cap_reached";
  const percent = Math.floor((alert.spentMicros / alert.capMicros) * 100);
  const used = `${spentUsd(alert.spentMicros)} of the ${limitUsd(alert.capMicros)} cap`;
  const resets = resetDate(input.resetsAt);
  return {
    email: {
      subject: reached ? "AIQSA monthly cap reached" : "AIQSA monthly cap almost used",
      text: [
        reached
          ? "The monthly cap for everyone in AIQSA is reached."
          : `The monthly cap for everyone in AIQSA is ${percent}% used.`,
        "",
        `Spent this month: ${used}.`,
        reached
          ? `New messages are refused for everyone until the cap resets on ${resets} or you raise it.`
          : `The cap resets on ${resets}. Once it is reached, new messages are refused for everyone until it resets or you raise it.`,
        ESTIMATE_NOTE,
        "",
        "Review budgets and limits in Control Center:",
        adminLink(input.appBaseUrl)
      ].join("\n")
    },
    push: {
      body: reached
        ? `${used}. New messages are refused for everyone until ${resets}.`
        : `${percent}% used: ${used}. Resets on ${resets}.`,
      tag: "aiqsa-usage-cap",
      title: reached ? "Monthly cap reached" : "Monthly cap almost used",
      url: USAGE_LIMITS_ADMIN_PATH,
      v: 1
    }
  };
}

/**
 * The users who reached their monthly budget, batched into one alert: each
 * user's display name with spend and budget. No other user details.
 */
export function usersAlertContent(users: readonly UsageLimitUserAlert[], input: Readonly<{ appBaseUrl: string; resetsAt: Date }>): UsageLimitAlertContent {
  const one = users.length === 1;
  const resets = resetDate(input.resetsAt);
  const lines = users.slice(0, EMAIL_USER_LINES)
    .map((user) => `- ${displayName(user.displayName)}: ${spentUsd(user.spentMicros)} of ${limitUsd(user.budgetMicros)}`);
  const moreLines = users.length - lines.length;
  const names = users.slice(0, PUSH_USER_NAMES).map((user) => displayName(user.displayName));
  const moreNames = users.length - names.length;
  return {
    email: {
      subject: one ? "AIQSA user reached their monthly budget" : "AIQSA users reached their monthly budget",
      text: [
        one
          ? `This person reached their monthly budget and cannot send new messages until it resets on ${resets} unless you raise their budget:`
          : `These ${users.length} people reached their monthly budget and cannot send new messages until it resets on ${resets} unless you raise their budget:`,
        "",
        ...lines,
        ...(moreLines > 0 ? [`- and ${moreLines} more`] : []),
        "",
        ESTIMATE_NOTE,
        "",
        "Review budgets and limits in Control Center:",
        adminLink(input.appBaseUrl)
      ].join("\n")
    },
    push: {
      body: `${names.join(", ")}${moreNames > 0 ? ` and ${moreNames} more` : ""} · no new messages until ${resets}`,
      tag: "aiqsa-usage-budgets",
      title: one ? "A user reached their monthly budget" : `${users.length} users reached their monthly budget`,
      url: USAGE_LIMITS_ADMIN_PATH,
      v: 1
    }
  };
}

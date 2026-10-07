"use client";

import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { usageLimitsErrorMessage } from "@/components/admin/limits/adminUsageLimitsApi";
import { AdminUsageInstallationForm } from "@/components/admin/limits/AdminUsageInstallationForm";
import { UsageLimitGroupsList, UsageLimitUsersList } from "@/components/admin/limits/AdminUsageLimitLists";
import { AdminUsageGroupLimitsSheet, AdminUsageUserLimitsSheet } from "@/components/admin/limits/AdminUsageLimitSheets";
import { UsageMeter } from "@/components/admin/limits/UsageLimitControls";
import { useAdminUsageLimits } from "@/components/admin/limits/useAdminUsageLimits";
import { budgetStateCounts, formatSpend, formatUsdLimit, usagePercent } from "@/components/admin/limits/usageLimitsView";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { UiV2Button } from "@/components/ui-v2";
import {
  USAGE_LIMIT_WARNING_RATIO,
  type AdminUsageLimitGroupRow,
  type AdminUsageLimits,
  type AdminUsageLimitUserRow
} from "@/lib/contracts/usageLimits";
import { useId, useState } from "react";

const topbar = { title: "Budgets & limits" };

/** The row as opened; an open sheet follows the row in the latest view while it still exists. */
type OpenSheet =
  | Readonly<{ group: AdminUsageLimitGroupRow; kind: "group" }>
  | Readonly<{ kind: "user"; user: AdminUsageLimitUserRow }>;

function users(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "user" : "users"}`;
}

function capStatus(spent: number, cap: number): Readonly<{ className: string; percent: number; text: string; tone: "near" | "ok" | "reached" }> {
  const percent = usagePercent(spent, cap);
  if (spent >= cap) {
    return { className: "text-critical", percent, text: "Cap reached · new messages are refused for everyone", tone: "reached" };
  }
  if (spent >= cap * USAGE_LIMIT_WARNING_RATIO) {
    return { className: "text-caution", percent, text: `${percent}% used · almost reached`, tone: "near" };
  }
  return { className: "text-ink-muted", percent, text: `${percent}% used`, tone: "ok" };
}

function MonthSummary({ limits }: Readonly<{ limits: AdminUsageLimits }>) {
  const headingId = useId();
  const cap = limits.installation.monthlyCapMicros;
  const spent = limits.installationSpentMicros;
  // Budgets follow the UTC calendar month; the date is shown in the viewer's locale.
  const resets = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(limits.resetsAt));
  const status = cap === null ? null : capStatus(spent, cap);
  const counts = budgetStateCounts(limits.users);
  const budgetParts = [
    counts.reached > 0 ? `${users(counts.reached)} reached their budget` : null,
    counts.near > 0 ? `${users(counts.near)} above 80%` : null
  ].filter((part): part is string => part !== null);
  return (
    <section aria-labelledby={headingId} className={`${cardClass} p-5`} data-testid="admin-usage-limits-summary">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={sectionHeadingClass} id={headingId}>This month</h2>
        <p className="text-xs text-ink-muted">Resets {resets} · UTC calendar month</p>
      </div>
      <div className="mt-4 grid min-w-0 gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">Spent by everyone</p>
          <p className="mt-1 break-words font-mono text-2xl font-semibold tabular-nums text-ink [overflow-wrap:anywhere]">{formatSpend(spent)}</p>
          {cap === null || status === null ? (
            <p className="mt-1 text-xs text-ink-muted">No monthly cap is set.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-ink-secondary">of the {formatUsdLimit(cap)} monthly cap for everyone</p>
              <div className="mt-2 max-w-md">
                <UsageMeter label="Monthly cap used" percent={status.percent} tone={status.tone} valueText={status.text} />
              </div>
              <p className={`mt-1 text-xs ${status.className}`} data-cap-state={status.tone}>{status.text}</p>
            </>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">Users at or near their budget</p>
          <p className="mt-1 text-sm text-ink">
            {counts.withBudget === 0
              ? "No active user has a monthly budget."
              : budgetParts.length > 0
                ? budgetParts.join(" · ")
                : "Everyone with a budget is below 80% of it."}
          </p>
          {counts.reached > 0 ? (
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              They cannot send new messages until the budget resets or you raise it.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function HowLimitsWork() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="max-w-3xl text-xs leading-5 text-ink-muted">
      <h2 className="font-medium text-ink-secondary" id={headingId}>How limits work</h2>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li>
          For each limit, a user&apos;s override wins; otherwise the most generous of their active groups that set it;
          otherwise the default. Exempt users have no per-user limits.
        </li>
        <li>The monthly cap applies to everyone together, exempt users included.</li>
        <li>Budgets count only usage with a known estimated cost, per UTC calendar month.</li>
        <li>
          Limits are checked when a message is sent. An answer that is already running finishes, so spending can go
          slightly over a limit.
        </li>
        <li>
          Message limits count messages, edits and regenerations in the last hour and day. Scheduled tasks don&apos;t
          count toward them; their runs are skipped while a budget or the cap is used up.
        </li>
        <li>
          Budgets count answers, Search and images. System features (Memory, Knowledge, titles) count only toward the
          monthly cap and are never stopped.
        </li>
      </ul>
    </section>
  );
}

/**
 * Budgets & limits (People): the month at a glance, the installation cap and
 * per-user defaults, group allowances and each user's effective limits with
 * an override sheet. The section owns its own resource; the dashboard is not
 * involved.
 */
export function AdminUsageLimitsSection({ reportNotice }: Readonly<{ reportNotice(message: string): void }>) {
  useAdminSectionTopbar(topbar);
  const controller = useAdminUsageLimits();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { limits, loadError, loading } = controller;
  const close = () => setSheet(null);
  const openGroup = sheet?.kind === "group"
    ? limits?.groups.find(({ groupId }) => groupId === sheet.group.groupId) ?? sheet.group
    : null;
  const openUser = sheet?.kind === "user"
    ? limits?.users.find(({ userId }) => userId === sheet.user.userId) ?? sheet.user
    : null;

  return (
    <div className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <p className="max-w-2xl text-sm leading-6 text-ink-secondary">
        Cap what the installation spends each month and give users monthly budgets and message allowances.
      </p>
      {limits ? (
        <>
          {loadError ? (
            <p className="text-xs text-caution" role="status">
              Could not refresh just now. Showing the values loaded earlier.
            </p>
          ) : null}
          <MonthSummary limits={limits} />
          <AdminUsageInstallationForm controller={controller} installation={limits.installation} reportNotice={reportNotice} />
          <UsageLimitGroupsList busy={controller.busy} groups={limits.groups} onEdit={(group) => setSheet({ group, kind: "group" })} />
          <UsageLimitUsersList busy={controller.busy} onEdit={(user) => setSheet({ kind: "user", user })} users={limits.users} />
          <HowLimitsWork />
        </>
      ) : loading ? (
        <p className="text-sm text-ink-muted" role="status">Loading budgets and limits…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
          <p className="min-w-0 text-sm text-ink">{usageLimitsErrorMessage(loadError ?? "usage_limits_action_failed")}</p>
          <UiV2Button
            busy={retrying}
            onClick={() => {
              setRetrying(true);
              void controller.refresh().finally(() => setRetrying(false));
            }}
            tone="ghost"
            type="button"
          >
            Try again
          </UiV2Button>
        </div>
      )}
      {openGroup ? (
        <AdminUsageGroupLimitsSheet
          controller={controller}
          group={openGroup}
          key={openGroup.groupId}
          onClose={close}
          reportNotice={reportNotice}
        />
      ) : null}
      {openUser ? (
        <AdminUsageUserLimitsSheet
          controller={controller}
          key={openUser.userId}
          onClose={close}
          reportNotice={reportNotice}
          user={openUser}
        />
      ) : null}
    </div>
  );
}

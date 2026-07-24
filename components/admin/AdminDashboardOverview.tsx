import type { AdminDashboardOverview as AdminDashboardOverviewModel } from "@/components/admin/adminDashboardView";
import { focusRing, SummaryMetric } from "@/components/admin/adminPrimitives";
import type { AdminSectionId } from "@/components/admin/adminSections";
import { AlertTriangle, Link2, UserCog, type LucideIcon } from "lucide-react";

function AttentionButton({
  detail,
  Icon,
  label,
  onClick,
  tone,
  value
}: Readonly<{
  detail: string;
  Icon: LucideIcon;
  label: string;
  onClick(): void;
  tone: "amber" | "cyan" | "green";
  value: number;
}>) {
  const toneClass =
    tone === "amber"
      ? "border-accent-amber/30 bg-accent-amber/10 text-accent-amber"
      : tone === "cyan"
        ? "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
        : "border-accent-green/30 bg-accent-green/10 text-accent-green";

  return (
    <button
      className={`flex min-h-touch min-w-0 items-start gap-3 rounded-control bg-surface-raised px-3 py-2.5 text-left ${focusRing} hover:bg-surface-hover`}
      onClick={onClick}
      type="button"
    >
      <span className={`grid size-8 shrink-0 place-items-center rounded-control ${toneClass}`}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-content-primary">{label}</span>
        <span className="mt-1 block break-words text-xs text-content-muted [overflow-wrap:anywhere]">
          <span className="font-mono text-content-secondary">{value}</span> {detail}
        </span>
      </span>
    </button>
  );
}

export function AdminDashboardOverview({
  onSelectSection,
  overview
}: Readonly<{
  onSelectSection(section: AdminSectionId): void;
  overview: AdminDashboardOverviewModel;
}>) {
  return (
    <>
      <section
        aria-label="Admin summary"
        className={`mt-3 grid grid-flow-col auto-cols-[minmax(10rem,1fr)] gap-2 overflow-x-auto overscroll-x-contain pb-1 sm:grid-flow-row sm:grid-cols-2 sm:overflow-visible sm:pb-0 xl:grid-cols-4 ${focusRing}`}
        tabIndex={0}
      >
        <SummaryMetric
          detail={`${overview.pendingUsers.length} pending / ${overview.inactiveUsers} disabled or denied`}
          label="Active users"
          value={overview.activeUsers}
        />
        <SummaryMetric detail={`${overview.totalGroups} total groups`} label="Active groups" value={overview.activeGroups} />
        <SummaryMetric
          detail={`${overview.acceptedInvites} accepted / ${overview.revokedInvites} revoked`}
          label="Open invites"
          value={overview.openInvites.length}
        />
        <SummaryMetric
          detail={`${overview.grantableModels} models / ${overview.grantableSearch} search strategies`}
          label="Access rules"
          value={overview.accessRules}
        />
      </section>

      <section
        aria-label="Needs attention"
        className="mt-3 grid gap-2 lg:grid-cols-3"
        data-testid="admin-attention"
      >
        {overview.pendingUsers.length ? (
          <AttentionButton
            Icon={AlertTriangle}
            detail="pending users"
            label="Pending approval"
            onClick={() => onSelectSection("users")}
            tone="amber"
            value={overview.pendingUsers.length}
          />
        ) : null}
        {overview.noAccessUsers.length ? (
          <AttentionButton
            Icon={UserCog}
            detail="active users without access"
            label="No-access users"
            onClick={() => onSelectSection("users")}
            tone="amber"
            value={overview.noAccessUsers.length}
          />
        ) : null}
        {overview.openInvites.length ? (
          <AttentionButton
            Icon={Link2}
            detail={`${overview.soonExpiringInvites.length} expiring soon`}
            label="Open invites"
            onClick={() => onSelectSection("invites")}
            tone={overview.soonExpiringInvites.length ? "amber" : "cyan"}
            value={overview.openInvites.length}
          />
        ) : null}
        {!overview.hasAttention ? (
          <p className="rounded-control bg-accent-green/10 px-3 py-2 text-sm text-accent-green" role="status">
            No current approval, access, or invite issues need attention.
          </p>
        ) : null}
      </section>
    </>
  );
}

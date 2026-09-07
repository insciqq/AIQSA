"use client";

import type { AdminAttentionController } from "@/components/admin/useAdminAttention";
import type {
  AdminAttentionItem,
  AdminAttentionSeverity,
  AdminAttentionSource,
  AdminAttentionTarget
} from "@/lib/contracts/adminAttention";

export const ADMIN_OVERVIEW_EMPTY_COPY =
  "Only things that need a decision or an action appear here. When the list is empty, everything is working.";

const severityPill: Record<AdminAttentionSeverity, string> = {
  bad: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  warn: "border-caution/25 bg-caution/10 text-caution"
};

const sourceLabel: Record<AdminAttentionSource, string> = {
  dashboard: "users",
  email: "email",
  knowledge: "Knowledge",
  mcp: "MCP servers",
  memory: "Memory",
  providers: "providers",
  search: "Search",
  system_roles: "system roles"
};

function unavailableCopy(sources: readonly AdminAttentionSource[]): string {
  const labels = sources.map((source) => sourceLabel[source]);
  return `Could not check ${labels.join(", ")} right now — those items may be missing.`;
}

function AttentionRow({
  item,
  onJump
}: Readonly<{
  item: AdminAttentionItem;
  onJump(target: AdminAttentionTarget): void;
}>) {
  return (
    <li
      className="flex min-w-0 flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:gap-4"
      data-attention-code={item.code}
      data-testid="admin-attention-item"
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 self-start rounded-pill border px-2 text-metadata font-semibold sm:self-center ${severityPill[item.severity]}`}
        data-severity={item.severity}
        data-testid="admin-attention-status"
      >
        <span className="size-1.5 rounded-full bg-current" />
        {item.count ?? "—"}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{item.title}</h3>
        <p className="mt-px break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{item.detail}</p>
      </div>
      <button
        aria-label={`${item.action}: ${item.title}`}
        className="v2-button v2-focusable shrink-0 self-start sm:self-center"
        data-tone="ghost"
        onClick={() => onJump(item.target)}
        type="button"
      >
        <span>{item.action}</span>
      </button>
    </li>
  );
}

export function AdminOverviewSection({
  controller,
  onJump
}: Readonly<{
  controller: AdminAttentionController;
  onJump(target: AdminAttentionTarget): void;
}>) {
  const items = controller.attention?.items ?? [];
  const unavailableSources = controller.attention?.unavailable ?? [];

  return (
    <div className="flex max-w-[1120px] flex-col gap-2.5 px-4 py-6 sm:px-6 lg:px-8">
      <h2 className="text-[13px] font-semibold tracking-[0.02em] text-ink-secondary">Needs attention</h2>

      {controller.loading ? (
        <p className="text-sm text-ink-muted" role="status">Checking what needs attention…</p>
      ) : controller.unavailable && !controller.attention ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
          <p className="text-sm text-ink">The attention list could not be loaded.</p>
          <button
            className="v2-button v2-focusable"
            data-tone="ghost"
            onClick={() => void controller.refresh()}
            type="button"
          >
            <span>Try again</span>
          </button>
        </div>
      ) : items.length > 0 ? (
        <ul
          aria-label="Needs attention"
          className="divide-y divide-trace-subtle rounded-[12px] border border-trace-subtle bg-answer-paper"
        >
          {items.map((item) => (
            <AttentionRow item={item} key={item.id} onJump={onJump} />
          ))}
        </ul>
      ) : null}

      {!controller.loading && unavailableSources.length > 0 ? (
        <p className="text-xs text-caution" role="status">{unavailableCopy(unavailableSources)}</p>
      ) : null}

      <p className="text-xs leading-5 text-ink-muted">{ADMIN_OVERVIEW_EMPTY_COPY}</p>
    </div>
  );
}

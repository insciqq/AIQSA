import type { AdminAttentionIndicator } from "./useAdminAttentionSummary";

const severityColor = { bad: "bg-critical", warn: "bg-caution" } as const;

/** The corner dot on a Control Center entry; the entry's accessible name carries the count. */
export function AdminAttentionDot({ indicator }: Readonly<{ indicator: AdminAttentionIndicator }>) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-1 top-1 size-2 rounded-full ring-2 ring-workspace-rail ${severityColor[indicator.severity]}`}
      data-severity={indicator.severity}
      data-testid="admin-attention-dot"
    />
  );
}

import type { AdminAttentionIndicator } from "./useAdminAttentionSummary";

const severityColor = { bad: "bg-critical", warn: "bg-caution" } as const;

/** The corner dot on a Control Center entry; the entry's accessible name carries the count. */
export function AdminAttentionDot({
  className = "right-1 top-1 ring-workspace-rail",
  indicator
}: Readonly<{ className?: string; indicator: AdminAttentionIndicator }>) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute size-2 rounded-full ring-2 ${severityColor[indicator.severity]} ${className}`}
      data-severity={indicator.severity}
      data-testid="admin-attention-dot"
    />
  );
}

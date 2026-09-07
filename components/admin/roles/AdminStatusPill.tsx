import type { AdminRoleStatus } from "@/components/admin/roles/rolesView";

const tones: Record<AdminRoleStatus | "reindexing", string> = {
  not_assigned: "border-trace-subtle bg-control-surface text-ink-secondary",
  reindexing: "border-caution/25 bg-caution/10 text-caution",
  unavailable: "border-critical/25 bg-critical/10 text-critical",
  working: "border-positive/25 bg-positive/10 text-positive"
};

/** Compact status pill for role and health rows: a dot plus one word. */
export function AdminStatusPill({
  label,
  status,
  testId
}: Readonly<{
  label: string;
  status: AdminRoleStatus | "reindexing";
  testId?: string;
}>) {
  return (
    <span
      className={`inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-pill border px-2 text-metadata font-medium ${tones[status]}`}
      data-status={status}
      data-testid={testId}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </span>
  );
}

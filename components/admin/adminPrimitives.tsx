import type { AdminDeletionInfo, AdminGroup, AdminMembership } from "@/lib/contracts/admin";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas";
export const touchTarget = "[@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch";
const buttonBase = `inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60`;
export const primaryButton = `${buttonBase} bg-accent-cyan text-surface-canvas hover:bg-accent-cyan/90`;
export const quietButton = `${buttonBase} bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary`;
export const dangerButton = `${buttonBase} bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/15`;
export const inputClass =
  `min-h-control w-full rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary ${focusRing} ${touchTarget} placeholder:text-content-muted`;
const fieldLabelClass = "text-xs font-medium text-content-secondary";

export function AdminGroupOptions({
  groups,
  label,
  onChange,
  selected: selectedIds
}: {
  groups: AdminGroup[];
  label: string;
  onChange(groupIds: string[]): void;
  selected: string[];
}) {
  const activeGroups = groups.filter((group) => !group.archivedAt);
  const activeGroupIds = new Set(activeGroups.map((group) => group.id));
  const selected = new Set(selectedIds.filter((groupId) => activeGroupIds.has(groupId)));

  return (
    <fieldset className="min-w-0 max-w-full">
      <legend className={`${fieldLabelClass} mb-1.5`}>{label}</legend>
      <div className="flex min-w-0 max-w-full flex-wrap gap-2">
        {activeGroups.length ? (
          activeGroups.map((group) => (
            <label
              className={`flex min-h-control-sm min-w-0 max-w-full items-center gap-2 rounded-control bg-surface-raised px-3 text-xs text-content-secondary ${touchTarget}`}
              key={group.id}
            >
              <input
                checked={selected.has(group.id)}
                className="size-4 shrink-0 accent-accent-cyan"
                aria-label={group.name}
                onChange={(event) => {
                  const next = new Set(selected);

                  if (event.currentTarget.checked) {
                    next.add(group.id);
                  } else {
                    next.delete(group.id);
                  }

                  onChange([...next]);
                }}
                type="checkbox"
              />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{group.name}</span>
            </label>
          ))
        ) : (
          <span className="text-xs text-content-muted">No groups</span>
        )}
      </div>
    </fieldset>
  );
}

export function GroupChips({ groups }: { groups: AdminMembership[] }) {
  if (!groups.length) {
    return <span className="inline-flex rounded-pill bg-accent-amber/10 px-2 py-0.5 text-[11px] text-accent-amber">No groups</span>;
  }

  return (
    <span className="flex min-w-0 max-w-full flex-wrap gap-1">
      {groups.slice(0, 3).map((group) => (
        <span
          className="min-w-0 max-w-full break-words rounded-pill bg-surface-raised px-2 py-0.5 text-[11px] text-content-secondary [overflow-wrap:anywhere]"
          key={group.groupId}
        >
          {group.name}
        </span>
      ))}
      {groups.length > 3 ? (
        <span className="rounded-pill bg-surface-raised px-2 py-0.5 font-mono text-[11px] text-content-muted">
          +{groups.length - 3}
        </span>
      ) : null}
    </span>
  );
}

export function SummaryMetric({
  detail,
  label,
  value
}: {
  detail: string;
  label: string;
  value: number | string;
}) {
  return (
    <div className="min-w-0 rounded-control bg-surface-raised px-3 py-2.5">
      <div className={fieldLabelClass}>{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-content-primary">{value}</div>
      <div className="mt-1 break-words text-[11px] leading-4 text-content-muted [overflow-wrap:anywhere]">{detail}</div>
    </div>
  );
}

export function SectionHeader({
  actions,
  description,
  Icon,
  title
}: {
  actions?: ReactNode;
  description: string;
  Icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-separator-subtle px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-control bg-accent-cyan/10 text-accent-cyan">
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-content-primary">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-content-muted">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="px-4 py-10 text-center" role="status">
      <p className="text-sm font-semibold text-content-secondary">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-content-muted">{detail}</p>
    </div>
  );
}

export function DeletionHint({ info }: { info: AdminDeletionInfo }) {
  return (
    <div
      className={[
        "rounded-control px-3 py-2 text-xs leading-5",
        info.canDelete
          ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
          : "border-accent-amber/25 bg-accent-amber/10 text-accent-amber"
      ].join(" ")}
    >
      {info.summary}
    </div>
  );
}

export function AdminTableRegion({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div
      aria-label={label}
      className={`overflow-x-auto overscroll-x-contain ${focusRing}`}
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

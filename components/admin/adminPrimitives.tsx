import type { AdminDeletionInfo, AdminGroup, AdminMembership } from "@/lib/contracts/admin";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-proof/45 focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
export const touchTarget = "[@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch";
const buttonBase = `inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60`;
export const primaryButton = `${buttonBase} bg-proof text-proof-contrast hover:bg-proof-hover`;
export const quietButton = `${buttonBase} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink active:bg-control-pressed`;
export const dangerButton = `${buttonBase} bg-critical/10 text-critical hover:bg-critical/15`;
export const inputClass =
  `min-h-control w-full rounded-control border border-trace-subtle bg-answer-paper px-3 text-sm text-ink ${focusRing} ${touchTarget} placeholder:text-ink-muted`;
const fieldLabelClass = "text-xs font-medium text-ink-secondary";

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
              className={`flex min-h-control-sm min-w-0 max-w-full items-center gap-2 rounded-control bg-control-surface px-3 text-xs text-ink-secondary ${touchTarget}`}
              key={group.id}
            >
              <input
                checked={selected.has(group.id)}
                className="size-4 shrink-0 accent-proof"
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
          <span className="text-xs text-ink-muted">No groups</span>
        )}
      </div>
    </fieldset>
  );
}

export function GroupChips({ groups }: { groups: AdminMembership[] }) {
  if (!groups.length) {
    return <span className="inline-flex rounded-pill bg-caution/10 px-2 py-0.5 text-[11px] text-caution">No groups</span>;
  }

  return (
    <span className="flex min-w-0 max-w-full flex-wrap gap-1">
      {groups.slice(0, 3).map((group) => (
        <span
          className="min-w-0 max-w-full break-words rounded-pill bg-control-surface px-2 py-0.5 text-[11px] text-ink-secondary [overflow-wrap:anywhere]"
          key={group.groupId}
        >
          {group.name}
        </span>
      ))}
      {groups.length > 3 ? (
        <span className="rounded-pill bg-control-surface px-2 py-0.5 font-mono text-[11px] text-ink-muted">
          +{groups.length - 3}
        </span>
      ) : null}
    </span>
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
    <div className="flex flex-col gap-3 border-b border-trace-subtle bg-answer-paper px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-ink-muted">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="px-4 py-10 text-center" role="status">
      <p className="text-sm font-semibold text-ink-secondary">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">{detail}</p>
    </div>
  );
}

export function DeletionHint({ info }: { info: AdminDeletionInfo }) {
  return (
    <div
      className={[
        "rounded-control px-3 py-2 text-xs leading-5",
        info.canDelete
          ? "border border-positive/25 bg-positive/10 text-positive"
          : "border border-caution/25 bg-caution/10 text-caution"
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

export function AdminResourceIndexPane({
  children,
  className = "",
  compactVisible,
  testId
}: Readonly<{
  children: ReactNode;
  className?: string;
  compactVisible: boolean;
  testId: string;
}>) {
  return (
    <aside
      className={`${compactVisible ? "block" : "hidden"} min-h-0 min-w-0 lg:block ${className}`}
      data-admin-task-view="index"
      data-testid={testId}
    >
      {children}
    </aside>
  );
}

export function AdminResourceDetailPane({
  children,
  className = "",
  compactVisible,
  testId
}: Readonly<{
  children: ReactNode;
  className?: string;
  compactVisible: boolean;
  testId: string;
}>) {
  return (
    <div
      className={`${compactVisible ? "block" : "hidden"} min-h-0 min-w-0 lg:block ${className}`}
      data-admin-task-view="detail"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function AdminTaskWorkspace({
  children,
  className = "",
  indexWidth = "18rem"
}: Readonly<{
  children: ReactNode;
  className?: string;
  indexWidth?: string;
}>) {
  return (
    <div
      className={`min-h-[28rem] min-w-0 lg:grid ${className}`}
      style={{ gridTemplateColumns: `${indexWidth} minmax(0, 1fr)` }}
    >
      {children}
    </div>
  );
}

export function AdminTaskIndexPane({
  children,
  className = "",
  compactDetailOpen,
  testId
}: Readonly<{
  children: ReactNode;
  className?: string;
  compactDetailOpen: boolean;
  testId: string;
}>) {
  return (
    <aside
      className={`${compactDetailOpen ? "hidden" : "block"} min-h-0 min-w-0 border-b border-trace-subtle bg-workspace-rail/45 lg:block lg:border-b-0 lg:border-r ${className}`}
      data-admin-task-view="index"
      data-testid={testId}
    >
      {children}
    </aside>
  );
}

export function AdminTaskDetailPane({
  children,
  className = "",
  compactDetailOpen,
  testId
}: Readonly<{
  children: ReactNode;
  className?: string;
  compactDetailOpen: boolean;
  testId: string;
}>) {
  return (
    <div
      className={`${compactDetailOpen ? "block" : "hidden"} min-h-0 min-w-0 bg-answer-paper lg:block ${className}`}
      data-admin-task-view="detail"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function AdminTaskBackButton({
  label,
  onClick
}: Readonly<{
  label: string;
  onClick(): void;
}>) {
  return (
    <button className={`${quietButton} mb-4 lg:hidden`} onClick={onClick} type="button">
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      {label}
    </button>
  );
}

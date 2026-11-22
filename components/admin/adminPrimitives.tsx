"use client";

import type { AdminDeletionInfo, AdminGroup, AdminMembership } from "@/lib/contracts/admin";
import {
  AvailabilityStatus,
  availabilityRowClass,
  enableActionTone
} from "@/components/resource-lifecycle/AvailabilityStatus";
import type { ReactNode } from "react";

export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
export const touchTarget = "[@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch";
const buttonBase = `inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60`;
export const primaryButton = `${buttonBase} bg-proof text-proof-contrast hover:bg-proof-hover`;
export const enableButton = `${buttonBase} ${enableActionTone}`;
export const quietButton = `${buttonBase} bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink active:bg-control-pressed`;
export const dangerButton = `${buttonBase} bg-critical/10 text-critical hover:bg-critical/15`;
export const inputClass =
  `min-h-control w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink ${focusRing} ${touchTarget} placeholder:text-ink-muted aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled`;
const fieldLabelClass = "text-xs font-medium text-ink-secondary";

export const adminAvailabilityRowClass = availabilityRowClass;
export const AdminAvailabilityStatus = AvailabilityStatus;

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
    return <span className="inline-flex rounded-pill bg-caution/10 px-2 py-0.5 text-metadata text-caution">No groups</span>;
  }

  return (
    <span className="flex min-w-0 max-w-full flex-wrap gap-1">
      {groups.slice(0, 3).map((group) => (
        <span
          className="min-w-0 max-w-full break-words rounded-pill bg-control-surface px-2 py-0.5 text-metadata text-ink-secondary [overflow-wrap:anywhere]"
          key={group.groupId}
        >
          {group.name}
        </span>
      ))}
      {groups.length > 3 ? (
        <span className="rounded-pill bg-control-surface px-2 py-0.5 font-mono text-metadata text-ink-muted">
          +{groups.length - 3}
        </span>
      ) : null}
    </span>
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

"use client";

import type { AdminDeletionInfo, AdminGroup, AdminMembership } from "@/lib/contracts/admin";
import {
  AvailabilityStatus,
  availabilityRowClass,
  enableActionTone
} from "@/components/resource-lifecycle/AvailabilityStatus";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

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
  detailOpen,
  indexWidth = "18rem"
}: Readonly<{
  children: ReactNode;
  className?: string;
  detailOpen: boolean;
  indexWidth?: string;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const externalFocusOwnerRef = useRef(false);
  const indexFocusOwnerRef = useRef<HTMLElement | null>(null);
  const previousDetailOpenRef = useRef(detailOpen);
  const visibleViewRef = useRef<"detail" | "index" | "split" | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const layout = container?.firstElementChild;
    const index = layout?.querySelector<HTMLElement>(":scope > [data-admin-task-view='index']");
    const detail = layout?.querySelector<HTMLElement>(":scope > [data-admin-task-view='detail']");
    if (!container || !index || !detail) return;
    const focusScope = container.closest<HTMLElement>("[data-admin-task-focus-scope='true']") ??
      container.parentElement ??
      container;
    const rememberClickOpener = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const candidate = event.target.closest<HTMLElement>("[data-admin-task-opener='true']");
      if (candidate && focusScope.contains(candidate) && !detail.contains(candidate)) {
        indexFocusOwnerRef.current = candidate;
        externalFocusOwnerRef.current = false;
      }
    };
    const rememberFocusBoundary = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        externalFocusOwnerRef.current = !focusScope.contains(event.target);
      }
    };
    focusScope.addEventListener("click", rememberClickOpener, true);
    document.addEventListener("focusin", rememberFocusBoundary, true);
    let detailJustOpened = detailOpen && !previousDetailOpenRef.current;
    let detailJustClosed = !detailOpen && previousDetailOpenRef.current;
    previousDetailOpenRef.current = detailOpen;

    let focusFrame: number | null = null;
    const commitFocus = (target: HTMLElement) => {
      target.focus({ preventScroll: true });
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        if (target.isConnected) target.focus({ preventScroll: true });
      });
    };
    const focusDetail = () => {
      const back = detail.querySelector<HTMLElement>("[data-admin-task-back='responsive']");
      const target = back && window.getComputedStyle(back).display !== "none" ? back : detail;
      commitFocus(target);
    };
    const focusIndex = () => {
      const owner = indexFocusOwnerRef.current;
      if (owner?.isConnected && focusScope.contains(owner)) {
        commitFocus(owner);
        return;
      }
      indexFocusOwnerRef.current = null;
      const fallback = index.querySelector<HTMLElement>(
        "[data-admin-task-opener='true']:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
      );
      commitFocus(fallback ?? index);
    };
    const reconcileFocus = () => {
      const indexVisible = window.getComputedStyle(index).display !== "none";
      const detailVisible = window.getComputedStyle(detail).display !== "none";
      const nextView = indexVisible && detailVisible
        ? "split"
        : detailVisible
          ? "detail"
          : "index";
      const previousView = visibleViewRef.current;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeIsExternal = Boolean(
        active &&
        active !== document.body &&
        !focusScope.contains(active)
      );
      const externalOwnsFocus = activeIsExternal || Boolean(
        (!active || active === document.body) && externalFocusOwnerRef.current
      );
      const activeCanOwnReturn = Boolean(
        active &&
        active !== document.body &&
        focusScope.contains(active) &&
        !detail.contains(active)
      );

      if (detailJustOpened && activeCanOwnReturn) indexFocusOwnerRef.current = active;

      if (nextView === "detail" && previousView !== "detail") {
        if (activeCanOwnReturn) indexFocusOwnerRef.current = active;
        if (previousView === "index" || activeCanOwnReturn) focusDetail();
      } else if (nextView === "index" && previousView !== "index") {
        if (
          !externalOwnsFocus &&
          (previousView === "detail" || detailJustClosed || (active && detail.contains(active)))
        ) {
          focusIndex();
        }
      } else if (nextView === "split") {
        if (detailJustClosed) {
          if (!externalOwnsFocus) focusIndex();
        } else if (
          previousView === "detail" &&
          active?.matches("[data-admin-task-back='responsive']") &&
          window.getComputedStyle(active).display === "none"
        ) {
          commitFocus(detail);
        }
      }

      visibleViewRef.current = nextView;
      detailJustOpened = false;
      detailJustClosed = false;
    };

    reconcileFocus();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(reconcileFocus);
    observer?.observe(container);
    return () => {
      focusScope.removeEventListener("click", rememberClickOpener, true);
      document.removeEventListener("focusin", rememberFocusBoundary, true);
      observer?.disconnect();
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [detailOpen]);

  return (
    <div className="min-w-0" data-admin-task-container="true" ref={containerRef}>
      <div
        className={`min-h-[28rem] min-w-0 ${className}`}
        data-admin-task-layout="true"
        style={{ gridTemplateColumns: `${indexWidth} minmax(0, 1fr)` }}
      >
        {children}
      </div>
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
      className={`${compactDetailOpen ? "hidden" : "block"} min-h-0 min-w-0 border-b border-trace-subtle bg-workspace-rail/45 ${className}`}
      data-admin-task-view="index"
      data-testid={testId}
      tabIndex={-1}
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
      className={`${compactDetailOpen ? "block" : "hidden"} min-h-0 min-w-0 bg-answer-paper ${className}`}
      data-admin-task-view="detail"
      data-testid={testId}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export function AdminTaskBackButton({
  alwaysVisible = false,
  label,
  onClick
}: Readonly<{
  alwaysVisible?: boolean;
  label: string;
  onClick(): void;
}>) {
  return (
    <button
      className={`${quietButton} mb-4`}
      data-admin-task-back={alwaysVisible ? "always" : "responsive"}
      onClick={onClick}
      type="button"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      {label}
    </button>
  );
}

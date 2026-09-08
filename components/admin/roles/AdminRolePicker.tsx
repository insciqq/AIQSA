"use client";

import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";
import { ADMIN_ROLE_PICKER_FOOTER, type AdminRolePickerItem } from "@/components/admin/roles/rolesView";
import { useComposerPickerSession } from "@/components/app-shell/composerPicker";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { useId, useLayoutEffect } from "react";

export type AdminRolePickerProps = Readonly<{
  busy?: boolean;
  /** Deployment whose paid Check is in flight. */
  checkingId?: string | null;
  disabled?: boolean;
  items: readonly AdminRolePickerItem[];
  /** Accessible name of the trigger, e.g. "Memory & structured helpers deployment". */
  label: string;
  /** Runs the role check; resolve `true` once the deployment is assigned. */
  onCheck?(id: string): Promise<boolean>;
  onSelect(id: string): void;
  placeholder?: string;
  /** Short role name for the group heading: "Ready for Memory". */
  roleName: string;
  selectedId: string | null;
  /** Label of the current assignment when it is no longer among the items. */
  selectedLabel?: string | null;
  testId?: string;
}>;

const groupHeading = "px-2 pb-1 pt-2 text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted";

/**
 * Eligibility-driven deployment picker (PRD 5.5): only deployments that can
 * do the job are listed, in three groups. `Check` inside the picker runs the
 * one small paid request for a `Check first` deployment and assigns it.
 */
export function AdminRolePicker({
  busy = false,
  checkingId = null,
  disabled = false,
  items,
  label,
  onCheck,
  onSelect,
  placeholder = "Not assigned",
  roleName,
  selectedId,
  selectedLabel = null,
  testId
}: AdminRolePickerProps) {
  const dialogId = useId();
  const ready = items.filter((item) => item.group === "ready");
  const check = items.filter((item) => item.group === "check");
  const ineligible = items.filter((item) => item.group === "ineligible");
  const selectedIndex = ready.findIndex((item) => item.id === selectedId);
  const {
    boundaryProps,
    boundaryRef,
    close,
    dialogProps,
    dialogRef,
    getItemProps,
    navigableIndex,
    open,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId,
    disabled: disabled || busy,
    initialFocus: "selected",
    itemFocusPreventScroll: true,
    items: ready,
    onSelect: (item) => onSelect(item.id),
    openFromTriggerKeys: true,
    selectedIndex
  });
  const currentLabel = ready.find((item) => item.id === selectedId)?.label ?? selectedLabel;

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current;
    const dialog = dialogRef.current;
    if (!anchor || !dialog) return;

    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const gutter = 8;
      const gap = 4;
      const width = Math.min(416, window.innerWidth - gutter * 2);
      const below = Math.max(0, window.innerHeight - bounds.bottom - gap - gutter);
      const above = Math.max(0, bounds.top - gap - gutter);
      const wanted = Math.min(dialog.scrollHeight, 384, window.innerHeight * 0.7);
      const bottom = below >= wanted || below >= above;
      const maxHeight = Math.max(1, Math.min(384, window.innerHeight * 0.7, bottom ? below : above));
      const height = Math.min(dialog.scrollHeight, maxHeight);
      Object.assign(dialog.style, {
        left: `${Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter))}px`,
        maxHeight: `${maxHeight}px`,
        top: `${bottom ? bounds.bottom + gap : Math.max(gutter, bounds.top - gap - height)}px`,
        visibility: "visible",
        width: `${width}px`
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(dialog);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [dialogRef, open, triggerRef]);

  return (
    <div {...boundaryProps} className="relative min-w-0" ref={boundaryRef}>
      <button
        {...triggerProps}
        aria-label={label}
        className={`flex min-h-control-sm w-full min-w-0 items-center justify-between gap-2 rounded-control border bg-answer-paper px-3 text-left text-[13px] ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? "border-proof" : "border-control-boundary hover:border-trace-strong"
        } ${currentLabel ? "text-ink" : "text-ink-muted"}`}
        data-testid={testId}
        disabled={disabled || busy}
        onClick={toggle}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 truncate">{currentLabel ?? placeholder}</span>
        <UiV2Icon className="shrink-0 text-ink-muted" name="chevron-down" />
      </button>
      {open ? (
        <div
          {...dialogProps}
          aria-label={label}
          className="v2-menu fixed z-[100] flex flex-col overflow-y-auto overscroll-contain p-1.5"
          ref={dialogRef}
          style={{ visibility: "hidden" }}
        >
          <p className={groupHeading}>Ready for {roleName}</p>
          {ready.length > 0 ? (
            <div aria-label={`Ready for ${roleName}`} className="grid min-w-0 grid-cols-1 gap-0.5" role="listbox">
              {ready.map((item, index) => {
                const selected = item.id === selectedId;
                const active = index === navigableIndex;
                return (
                  <button
                    key={item.id}
                    {...getItemProps(index)}
                    aria-selected={selected}
                    className={`flex min-h-[2.125rem] w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-sm ${focusRing} ${touchTarget} ${
                      selected ? "bg-control-selected text-ink" : active ? "bg-control-hover text-ink" : "text-ink hover:bg-control-hover"
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    role="option"
                    type="button"
                  >
                    <span aria-hidden="true" className="inline-flex w-4 shrink-0 justify-center text-proof">
                      {selected ? <UiV2Icon name="check" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-xs text-ink-muted">{selected ? "current" : "checked"}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-xs text-ink-muted" role="status">Nothing is ready for {roleName} yet.</p>
          )}
          {check.length > 0 ? (
            <>
              <p className={groupHeading}>Check first · one small paid request</p>
              <ul aria-label="Check first" className="grid min-w-0 grid-cols-1 gap-0.5">
                {check.map((item) => (
                  <li className="flex min-h-[2.125rem] min-w-0 items-center gap-2 px-2 text-sm text-ink" key={item.id}>
                    <span aria-hidden="true" className="w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <UiV2Button
                      aria-label={`Check ${item.label}`}
                      busy={checkingId === item.id}
                      className={`shrink-0 ${touchTarget}`}
                      disabled={checkingId !== null || !onCheck}
                      onClick={() => {
                        void onCheck?.(item.id).then((assigned) => {
                          if (assigned) close();
                        });
                      }}
                      tone="ghost"
                    >
                      Check
                    </UiV2Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {ineligible.length > 0 ? (
            <>
              <p className={groupHeading}>Not eligible</p>
              <ul aria-label="Not eligible" className="grid min-w-0 grid-cols-1 gap-0.5">
                {ineligible.map((item) => (
                  <li
                    className="grid min-h-[2.125rem] min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 px-2 text-sm text-ink-muted"
                    key={item.id}
                  >
                    <span aria-hidden="true" />
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="max-w-[11rem] text-right text-xs leading-4">{item.note}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-1 border-t border-trace-subtle px-2 pb-0.5 pt-2 text-xs text-ink-muted">
            {ADMIN_ROLE_PICKER_FOOTER}
          </p>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { UiV2Icon, UiV2MenuItem, UiV2MenuSurface } from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState } from "react";

export type SettingsSelectOptionV2<T extends string> = Readonly<{
  label: string;
  sub?: string;
  value: T;
}>;

/**
 * Single-choice control in the Signal anatomy (UX audit 2026-09-02 #13): a
 * chip-like trigger that opens an anchored menu of options, replacing native
 * `<select>` chrome inside Settings. Keyboard: Enter/Space/ArrowDown open,
 * Escape/outside close (shared dismissal contract), Arrow keys move inside.
 */
export function SettingsSelectV2<T extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value
}: Readonly<{
  disabled?: boolean;
  label: string;
  onChange(next: T): void;
  options: readonly SettingsSelectOptionV2<T>[];
  value: T;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setOpen(false),
    open
  });
  const current = options.find((option) => option.value === value) ?? options[0];

  return (
    <span className="v2-settings-select">
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="v2-settings-select-trigger v2-focusable"
        disabled={disabled}
        type="button"
        onClick={() => setOpen((state) => !state)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="v2-settings-select-value">{current?.label ?? "—"}</span>
        <UiV2Icon name="chevron-down" />
      </button>
      {open ? (
        <UiV2MenuSurface
          ref={menuRef}
          className="v2-settings-select-menu"
          label={label}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')
            );
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "ArrowDown"
              ? items[(index + 1) % items.length]
              : items[(index - 1 + items.length) % items.length];
            next?.focus();
          }}
        >
          {options.map((option) => (
            <UiV2MenuItem
              key={option.value}
              selected={option.value === value}
              sub={option.sub}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
                triggerRef.current?.focus();
              }}
            >
              {option.label}
            </UiV2MenuItem>
          ))}
        </UiV2MenuSurface>
      ) : null}
    </span>
  );
}

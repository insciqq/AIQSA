import { useComposerPickerSession } from "@/components/app-shell/composerPicker";
import { Check, ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";

export function ComposerOptionPicker({
  accessibleDescription,
  align = "left",
  className,
  defaultValue,
  disabled,
  icon,
  id,
  label,
  onChange,
  options,
  placement = "above",
  resting = false,
  restingLabel,
  summaryLabel,
  value
}: {
  accessibleDescription?: string;
  align?: "left" | "right";
  className?: string;
  defaultValue?: string;
  disabled: boolean;
  icon?: ReactNode;
  id: string;
  label: string;
  onChange(value: string): void;
  options: { description?: string; label: string; value: string }[];
  placement?: "above" | "below";
  resting?: boolean;
  restingLabel?: string;
  summaryLabel?: string;
  value: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  const fullSelectedLabel = selected?.label ?? value;
  const triggerDescription = accessibleDescription ?? fullSelectedLabel;
  const selectedIndex = Math.max(
    options.findIndex((option) => option.value === selected?.value),
    0
  );
  const {
    boundaryProps,
    boundaryRef,
    close,
    dialogProps,
    dialogRef,
    getItemProps,
    open,
    resultsRef,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId: `${id}-options-dialog`,
    disabled,
    initialFocus: "selected",
    items: options,
    onSelect: (option) => onChange(option.value),
    openFromTriggerKeys: true,
    selectedIndex
  });

  return (
    <div
      {...boundaryProps}
      ref={boundaryRef}
      className={["relative min-w-0", className].filter(Boolean).join(" ")}
    >
      <button
        {...triggerProps}
        ref={triggerRef}
        className={[
          "flex h-touch w-full min-w-0 items-center justify-between gap-2 rounded-control px-3 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
          resting
            ? "bg-surface-hover text-content-primary hover:bg-surface-active"
            : "border border-separator-subtle bg-surface-thread text-content-primary hover:bg-surface-hover"
        ].join(" ")}
        id={id}
        type="button"
        aria-label={label}
        aria-describedby={`${id}-current-description`}
        disabled={disabled}
        title={triggerDescription}
        onClick={toggle}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="flex min-w-0 items-baseline gap-1.5">
            {resting ? <span className="shrink-0 text-[11px] text-content-muted">{restingLabel ?? label}</span> : null}
            <span className="truncate text-sm font-medium" id={`${id}-current-value`}>
              {summaryLabel ?? fullSelectedLabel}
            </span>
          </span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
      </button>
      <span className="sr-only" id={`${id}-current-description`}>
        {triggerDescription}
      </span>
      {open ? (
        <div
          {...dialogProps}
          ref={dialogRef}
          className={[
            "pop-enter absolute z-50 flex max-h-[min(24rem,calc(100dvh-6rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border border-separator-subtle bg-surface-overlay p-3 shadow-overlay max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:w-auto max-sm:max-h-[min(70dvh,30rem)] max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:!bottom-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!top-auto [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!w-auto",
            align === "right" ? "right-0" : "left-0",
            placement === "below" ? "top-12" : "bottom-12"
          ].join(" ")}
          data-testid={`${id}-options`}
          aria-label={`Choose ${label.toLocaleLowerCase()}`}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-content-primary">{label}</h3>
              <p className="mt-0.5 text-xs text-content-muted">Changes apply to the next message.</p>
            </div>
            <button
              className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
              type="button"
              aria-label={`Close ${label.toLocaleLowerCase()} picker`}
              onClick={close}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div
            ref={resultsRef}
            className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1"
          >
            {options.length === 0 ? (
              <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-content-primary">No options available.</p>
              </div>
            ) : null}
            {options.map((option, index) => {
              const active = option.value === value;
              const isDefault = option.value === defaultValue;

              return (
                <button
                  key={option.value}
                  {...getItemProps(index)}
                  className={[
                    "flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan/55",
                    active
                      ? "bg-surface-selected text-content-primary"
                      : "text-content-secondary hover:bg-surface-hover hover:text-content-primary"
                  ].join(" ")}
                  data-option-value={option.value}
                  type="button"
                  aria-current={active ? "true" : undefined}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere]">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-5 text-content-muted">{option.description}</span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    {active ? <span className="text-accent-cyan">Current</span> : null}
                    {isDefault ? <span className="text-content-muted">Default</span> : null}
                    {active ? <Check className="size-4 text-accent-cyan" aria-hidden="true" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

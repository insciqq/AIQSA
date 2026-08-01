import type { CatalogSearchStrategy } from "@/components/app-shell/types";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { SearchPlanMode } from "@/lib/domain/search";
import { isSearchCombinationCompatible } from "@/lib/domain/catalogMatrix";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function optionDescription(option: CatalogSearchStrategy): string {
  const privacy = option.privacy === "query_only"
    ? "Only the generated query is shared"
    : "Runs inside the answer-provider request";
  return `${privacy} · ${option.executionModes?.includes("all_selected") ? "fan-out ready" : "model choice only"}`;
}

function summary(
  options: readonly CatalogSearchStrategy[],
  selectedIds: readonly string[],
  compatibleIds: ReadonlySet<string>
): string {
  if (selectedIds.length === 0) return "Off";
  const active = selectedIds.filter((optionId) => compatibleIds.has(optionId)).length;
  const unavailable = selectedIds.length - active;
  if (unavailable > 0) return `${active} active · ${unavailable} unavailable`;
  if (selectedIds.length === 1) {
    return options.find((option) => option.strategyId === selectedIds[0])?.displayName ?? "1 engine";
  }
  return `${selectedIds.length} engines`;
}

function narrowLabel(option: CatalogSearchStrategy | undefined): string {
  if (!option) return "Off";
  if (option.kind === "gemini_google_search") return "Google";
  if (option.kind === "openai_native_web_search") return "OAI";
  if (option.kind === "perplexity_tool_search") return "PPLXTY";
  return option.displayName;
}

export function ComposerSearchPicker({
  align = "left",
  className = "",
  compatibleOptionIds,
  disabled,
  id,
  mode,
  onChange,
  onUseOrganizationDefault,
  options,
  placement = "above",
  preferenceSource = "personal",
  selectedOptionIds,
  setup = false,
  unavailableReasons = {}
}: Readonly<{
  align?: "left" | "right";
  className?: string;
  compatibleOptionIds?: readonly string[];
  disabled: boolean;
  id: string;
  mode: SearchPlanMode;
  onChange(optionIds: string[], mode: SearchPlanMode): void;
  onUseOrganizationDefault?(): void;
  options: readonly CatalogSearchStrategy[];
  placement?: "above" | "below";
  preferenceSource?: "organization" | "personal";
  selectedOptionIds: readonly string[];
  setup?: boolean;
  unavailableReasons?: Readonly<Record<string, string>>;
}>) {
  const [open, setOpen] = useState(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: open,
    onClose: () => setOpen(false),
    restoreFocus: () => triggerRef.current
  });
  const available = useMemo(() => options.filter((option) => option.kind !== "none"), [options]);
  const compatible = useMemo(
    () => new Set(compatibleOptionIds ?? available.map((option) => option.strategyId)),
    [available, compatibleOptionIds]
  );
  const selected = selectedOptionIds.filter((idValue) =>
    available.some((option) => option.strategyId === idValue));
  const unavailableCount = selected.filter((optionId) => !compatible.has(optionId)).length;
  const label = summary(available, selected, compatible);
  const singleOption = selected.length === 1
    ? available.find((option) => option.strategyId === selected[0])
    : undefined;
  const allSelectedAvailable = selected.length > 0 && selected.every((idValue) =>
    available.find((option) => option.strategyId === idValue)?.executionModes?.includes("all_selected") === true);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!boundaryRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  function toggle(option: CatalogSearchStrategy) {
    const active = selected.includes(option.strategyId);
    if (!active && selected.length >= 3) return;
    const next = active
      ? selected.filter((idValue) => idValue !== option.strategyId)
      : [...selected, option.strategyId];
    if (!active && !isSearchCombinationCompatible(next, available, "model_choice")) return;
    const supportsFanout = next.length > 0 && next.every((idValue) =>
      available.find((candidate) => candidate.strategyId === idValue)?.executionModes?.includes("all_selected") === true);
    onChange(next, mode === "all_selected" && !supportsFanout ? "model_choice" : mode);
  }

  return (
    <div className={`relative min-w-0 ${className}`} ref={boundaryRef}>
      <button
        ref={triggerRef}
        aria-controls={`${id}-dialog`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Search strategy"
        className={`flex h-touch w-full min-w-0 items-center justify-between gap-2 rounded-control text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control ${setup ? "border border-trace-subtle bg-answer-paper px-3" : "bg-control-surface px-2 hover:bg-control-hover"}`}
        disabled={disabled}
        id={id}
        onClick={() => setOpen((value) => !value)}
        type="button"
        title={label}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Search aria-hidden="true" className="hidden size-3.5 shrink-0 text-ink-muted max-[429px]:block" />
          <span className="shrink-0 text-xs text-ink-muted max-[429px]:sr-only">Search</span>
          <span className="truncate text-sm font-medium text-ink">
            {selected.length <= 1 && unavailableCount === 0 ? (
              <>
                <span className="min-[430px]:hidden">{narrowLabel(singleOption)}</span>
                <span className="hidden min-[430px]:inline">{label}</span>
              </>
            ) : label}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
      </button>
      {open ? (
        <div
          ref={dialogRef}
          aria-label="Choose Search engines"
          className={`pop-enter absolute z-50 flex max-h-[min(30rem,calc(100dvh-6rem))] w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border border-trace-subtle bg-overlay-surface p-3 shadow-overlay max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:w-auto max-sm:max-h-[min(78dvh,34rem)] [@media(max-height:32rem)]:!fixed [@media(max-height:32rem)]:!inset-x-2 [@media(max-height:32rem)]:!bottom-2 [@media(max-height:32rem)]:!top-auto [@media(max-height:32rem)]:!w-auto [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] ${align === "right" ? "right-0" : "left-0"} ${placement === "below" ? "top-12" : "bottom-12"}`}
          data-testid={`${id}-options`}
          id={`${id}-dialog`}
          role="dialog"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Search</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Choose up to three engines for the next answer.</p>
            </div>
            <button aria-label="Close Search picker" className="grid size-8 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55" onClick={() => setOpen(false)} type="button"><X aria-hidden="true" className="size-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1">
            <button
              aria-pressed={selected.length === 0}
              className={`flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 ${selected.length === 0 ? "bg-control-selected" : "hover:bg-control-hover"}`}
              onClick={() => onChange([], "all_selected")}
              type="button"
            >
              <span><span className="block text-sm font-semibold text-ink">Off</span><span className="mt-0.5 block text-xs text-ink-muted">Answer without web lookup</span></span>
              {selected.length === 0 ? <Check aria-hidden="true" className="size-4 text-proof" /> : null}
            </button>
            {available.map((option) => {
              const active = selected.includes(option.strategyId);
              const modelCompatible = compatible.has(option.strategyId);
              const unavailableReason = unavailableReasons[option.strategyId];
              const capped = !active && selected.length >= 3;
              const incompatible = !active && !isSearchCombinationCompatible(
                [...selected, option.strategyId],
                available,
                "model_choice"
              );
              return (
                <button
                  aria-pressed={active}
                  className={`flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-control-selected" : "hover:bg-control-hover"}`}
                  disabled={!active && (!modelCompatible || capped || incompatible)}
                  data-option-value={option.strategyId}
                  key={option.strategyId}
                  onClick={() => toggle(option)}
                  type="button"
                  title={!modelCompatible
                    ? `${unavailableReason ?? "Unavailable for this model"}; your saved preference is retained`
                    : incompatible
                      ? "This engine cannot be combined with the current selection"
                      : undefined}
                >
                  <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold text-ink">{option.displayName}</span><span className="mt-0.5 block text-xs leading-5 text-ink-muted">{modelCompatible ? optionDescription(option) : `${unavailableReason ?? "Unavailable for this model"} · preference retained`}</span></span>
                  <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-control border ${active ? "border-proof bg-proof text-proof-contrast" : "border-trace-strong"}`}>{active ? <Check aria-hidden="true" className="size-3.5" /> : null}</span>
                </button>
              );
            })}
          </div>
          {selected.length > 1 ? (
            <fieldset className="mt-3 border-t border-trace-subtle pt-3">
              <legend className="text-xs font-semibold text-ink-secondary">When the model searches</legend>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                <label className={`flex min-h-touch items-start gap-2 rounded-control px-3 py-2 text-xs ${allSelectedAvailable ? "hover:bg-control-hover" : "opacity-50"}`}>
                  <input checked={mode === "all_selected"} className="mt-0.5 accent-proof" disabled={!allSelectedAvailable} name={`${id}-mode`} onChange={() => onChange([...selected], "all_selected")} type="radio" />
                  <span><span className="block font-medium text-ink">All selected</span><span className="mt-0.5 block text-ink-muted">Same query, concurrent fan-out</span></span>
                </label>
                <label className="flex min-h-touch items-start gap-2 rounded-control px-3 py-2 text-xs hover:bg-control-hover">
                  <input checked={mode === "model_choice" || !allSelectedAvailable} className="mt-0.5 accent-proof" name={`${id}-mode`} onChange={() => onChange([...selected], "model_choice")} type="radio" />
                  <span><span className="block font-medium text-ink">Model chooses</span><span className="mt-0.5 block text-ink-muted">Each engine is a separate tool</span></span>
                </label>
              </div>
              {!allSelectedAvailable ? <p className="mt-2 text-[11px] leading-4 text-caution">This combination includes an engine that cannot fan out. Model chooses is required.</p> : null}
            </fieldset>
          ) : null}
          {preferenceSource === "personal" && onUseOrganizationDefault ? (
            <div className="mt-3 border-t border-trace-subtle pt-3">
              <button
                className="min-h-touch w-full rounded-control px-3 py-2 text-left text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55"
                onClick={() => {
                  onUseOrganizationDefault();
                  setOpen(false);
                }}
                type="button"
              >
                Use organization default
              </button>
              <p className="mt-1 px-3 text-[11px] leading-4 text-ink-muted">Future admin recommendations apply only when you have access.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

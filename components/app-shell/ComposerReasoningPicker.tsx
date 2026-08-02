import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { ModelParameterControls } from "@/components/app-shell/types";
import { BrainCircuit, Check, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const labels: Record<string, string> = {
  high: "High",
  low: "Low",
  max: "Maximum",
  medium: "Medium",
  minimal: "Minimal",
  none: "Off",
  pro: "Pro",
  standard: "Standard",
  xhigh: "Extra high"
};

function label(value: string): string {
  return labels[value] ?? value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function ComposerReasoningPicker({
  controls,
  disabled,
  effort,
  mode,
  onEffortChange,
  onModeChange
}: Readonly<{
  controls: ModelParameterControls;
  disabled: boolean;
  effort: string;
  mode: string;
  onEffortChange(value: string): void;
  onModeChange(value: string): void;
}>) {
  const [open, setOpen] = useState(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: open,
    onClose: () => setOpen(false),
    restoreFocus: () => triggerRef.current
  });
  const modeControl = controls.reasoningMode;
  const summary = `${modeControl?.supported ? `${label(mode)} · ` : ""}${label(effort)}`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!boundaryRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div
      className="relative hidden [@media(max-height:42rem)]:!hidden"
      data-composer-direct-reasoning="true"
      ref={boundaryRef}
    >
      <button
        ref={triggerRef}
        aria-controls="composer-direct-reasoning-dialog"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Reasoning ${summary}`}
        className="flex h-control max-w-[11rem] items-center gap-1.5 rounded-control bg-control-surface px-2 text-xs text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <BrainCircuit aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
        <span className="truncate font-medium">{summary}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
      </button>

      {open ? (
        <div
          ref={dialogRef}
          aria-label="Reasoning settings"
          className="pop-enter absolute bottom-12 right-0 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-panel border border-trace-subtle bg-overlay-surface p-3 shadow-overlay"
          id="composer-direct-reasoning-dialog"
          role="dialog"
        >
          <header className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Reasoning</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Saved for this exact model.</p>
            </div>
            <button
              aria-label="Close Reasoning settings"
              className="grid size-8 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          {modeControl?.supported ? (
            <fieldset className="mt-3">
              <legend className="text-xs font-semibold text-ink-secondary">Mode</legend>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {modeControl.options.map((option) => (
                  <button
                    aria-pressed={mode === option}
                    className={`flex min-h-control items-center justify-between rounded-control px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 ${mode === option ? "bg-control-selected text-ink" : "text-ink-secondary hover:bg-control-hover"}`}
                    key={option}
                    onClick={() => onModeChange(option)}
                    type="button"
                  >
                    <span className="font-medium">{label(option)}</span>
                    {mode === option ? <Check aria-hidden="true" className="size-3.5 text-proof" /> : null}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className={modeControl?.supported ? "mt-3 border-t border-trace-subtle pt-3" : "mt-3"}>
            <legend className="text-xs font-semibold text-ink-secondary">Effort</legend>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {controls.reasoningEffort.options.map((option) => (
                <button
                  aria-pressed={effort === option}
                  className={`flex min-h-control items-center justify-between rounded-control px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 ${effort === option ? "bg-control-selected text-ink" : "text-ink-secondary hover:bg-control-hover"}`}
                  key={option}
                  onClick={() => onEffortChange(option)}
                  type="button"
                >
                  <span className="font-medium">{label(option)}</span>
                  {effort === option ? <Check aria-hidden="true" className="size-3.5 text-proof" /> : null}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

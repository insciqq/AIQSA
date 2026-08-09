import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { ComposerKnowledgePlanSource } from "@/components/app-shell/composerControlStore";
import { KNOWLEDGE_PLAN_MAX_BASES, type KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import { BookOpen, Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function sourceLabel(source: ComposerKnowledgePlanSource): string {
  if (source === "assistant") return "Assistant exact plan";
  if (source === "chat") return "Chat default";
  if (source === "project") return "Project default";
  if (source === "explicit") return "Next-run plan";
  return "Off";
}

function selectionSummary(
  bases: readonly KnowledgeBaseSummary[],
  selectedIds: readonly string[]
): string {
  if (selectedIds.length === 0) return "Off";
  const available = selectedIds.filter((baseId) => {
    const base = bases.find((candidate) => candidate.id === baseId);
    return base && !base.archived;
  });
  const unavailable = selectedIds.length - available.length;
  if (unavailable > 0) return `${available.length} active · ${unavailable} unavailable`;
  if (available.length === 1) {
    return bases.find((base) => base.id === available[0])?.name ?? "1 base";
  }
  return `${available.length} bases`;
}

function fullSelectionLabel(
  bases: readonly KnowledgeBaseSummary[],
  selectedIds: readonly string[],
  source: ComposerKnowledgePlanSource
): string {
  if (selectedIds.length === 0) return `Knowledge off. ${sourceLabel(source)}.`;
  const names = selectedIds.map((baseId) => {
    const base = bases.find((candidate) => candidate.id === baseId);
    return base ? `${base.name}${base.archived ? " (unavailable)" : ""}` : "Unavailable retained base";
  });
  return `Knowledge: ${names.join(", ")}. ${sourceLabel(source)}.`;
}

export function ComposerKnowledgePicker({
  align = "left",
  bases,
  className = "",
  dataError,
  dataState,
  disabled,
  hasChatDefault = false,
  id,
  onChange,
  onClearChatDefault,
  onRetry,
  onSaveChatDefault,
  placement = "above",
  selectedBaseIds,
  setup = false,
  source
}: Readonly<{
  align?: "left" | "right";
  bases: readonly KnowledgeBaseSummary[];
  className?: string;
  dataError: string | null;
  dataState: "error" | "loading" | "ready";
  disabled: boolean;
  hasChatDefault?: boolean;
  id: string;
  onChange(baseIds: string[]): void;
  onClearChatDefault?(): void;
  onRetry(): void;
  onSaveChatDefault?(): void;
  placement?: "above" | "below";
  selectedBaseIds: readonly string[];
  setup?: boolean;
  source: ComposerKnowledgePlanSource;
}>) {
  const [open, setOpen] = useState(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: open,
    onClose: () => setOpen(false),
    restoreFocus: () => triggerRef.current
  });
  const orderedBases = useMemo(
    () => [...bases].sort((left, right) => left.name.localeCompare(right.name)),
    [bases]
  );
  const selectedSet = useMemo(() => new Set(selectedBaseIds), [selectedBaseIds]);
  const missingSelectedIds = selectedBaseIds.filter(
    (baseId) => !bases.some((base) => base.id === baseId)
  );
  const summary = selectionSummary(bases, selectedBaseIds);
  const accessibleLabel = fullSelectionLabel(bases, selectedBaseIds, source);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!boundaryRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function toggle(baseId: string) {
    if (selectedSet.has(baseId)) {
      onChange(selectedBaseIds.filter((candidate) => candidate !== baseId));
      return;
    }
    if (selectedBaseIds.length < KNOWLEDGE_PLAN_MAX_BASES) {
      onChange([...selectedBaseIds, baseId]);
    }
  }

  return (
    <div className={`relative min-w-0 ${className}`} ref={boundaryRef}>
      <button
        ref={triggerRef}
        aria-controls={`${id}-dialog`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={accessibleLabel}
        className={`flex h-touch w-full min-w-0 items-center justify-between gap-2 rounded-control text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control ${setup ? "border border-control-boundary bg-answer-paper px-3 disabled:border-trace-subtle" : "bg-control-surface px-2 hover:bg-control-hover"}`}
        disabled={disabled}
        id={id}
        onClick={() => setOpen((value) => !value)}
        title={accessibleLabel}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <BookOpen aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
          <span className="shrink-0 text-xs text-ink-muted max-[429px]:sr-only">Knowledge</span>
          <span className="truncate text-sm font-medium text-ink">{summary}</span>
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
      </button>
      {open ? (
        <div
          ref={dialogRef}
          aria-label="Choose Knowledge bases"
          className={`pop-enter absolute z-50 flex max-h-[min(32rem,calc(100dvh-6rem))] w-[min(27rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border border-trace-subtle bg-overlay-surface p-3 shadow-overlay max-sm:fixed max-sm:bottom-[calc(.5rem+var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom)))] max-sm:left-[calc(.5rem+var(--composer-picker-safe-area-inset-left,env(safe-area-inset-left)))] max-sm:right-[calc(.5rem+var(--composer-picker-safe-area-inset-right,env(safe-area-inset-right)))] max-sm:top-auto max-sm:max-h-[min(34rem,calc(100dvh_-_1rem_-_var(--composer-picker-safe-area-inset-top,env(safe-area-inset-top))_-_var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom))))] max-sm:w-auto max-sm:pb-[calc(.75rem+var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom)))] [@media(max-height:32rem)]:!fixed [@media(max-height:32rem)]:!bottom-[calc(.5rem+var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom)))] [@media(max-height:32rem)]:!left-[calc(.5rem+var(--composer-picker-safe-area-inset-left,env(safe-area-inset-left)))] [@media(max-height:32rem)]:!right-[calc(.5rem+var(--composer-picker-safe-area-inset-right,env(safe-area-inset-right)))] [@media(max-height:32rem)]:!top-auto [@media(max-height:32rem)]:!max-h-[calc(100dvh_-_1rem_-_var(--composer-picker-safe-area-inset-top,env(safe-area-inset-top))_-_var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom)))] [@media(max-height:32rem)]:!w-auto [@media(max-height:32rem)]:!pb-[calc(.75rem+var(--composer-picker-safe-area-inset-bottom,env(safe-area-inset-bottom)))] ${align === "right" ? "right-0" : "left-0"} ${placement === "below" ? "top-12" : "bottom-12"}`}
          data-testid={`${id}-options`}
          id={`${id}-dialog`}
          role="dialog"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Knowledge</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Choose up to three bases. Order is preserved.</p>
              <p className="mt-1 text-metadata font-medium text-proof">{sourceLabel(source)}</p>
            </div>
            <button aria-label="Close Knowledge picker" className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11" onClick={() => setOpen(false)} type="button">
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1">
            <button
              aria-pressed={selectedBaseIds.length === 0}
              className={`flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${selectedBaseIds.length === 0 ? "bg-control-selected" : "hover:bg-control-hover"}`}
              onClick={() => onChange([])}
              type="button"
            >
              <span><span className="block text-sm font-semibold text-ink">Off</span><span className="mt-0.5 block text-xs text-ink-muted">Do not retrieve workspace Knowledge</span></span>
              {selectedBaseIds.length === 0 ? <Check aria-hidden="true" className="size-4 text-proof" /> : null}
            </button>
            {missingSelectedIds.map((baseId) => (
              <button
                aria-label={`Remove unavailable retained Knowledge base, order ${selectedBaseIds.indexOf(baseId) + 1}`}
                aria-pressed="true"
                className="flex min-h-touch w-full items-start justify-between gap-3 rounded-control bg-control-selected px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                key={baseId}
                onClick={() => toggle(baseId)}
                type="button"
              >
                <span><span className="block text-sm font-semibold text-ink">Unavailable base</span><span className="mt-0.5 block text-xs text-caution">Selection retained · remove explicitly</span></span>
                <span className="shrink-0 font-mono text-metadata text-proof">#{selectedBaseIds.indexOf(baseId) + 1}</span>
              </button>
            ))}
            {orderedBases.map((base) => {
              const active = selectedSet.has(base.id);
              const unavailable = base.archived;
              const capped = !active && selectedBaseIds.length >= KNOWLEDGE_PLAN_MAX_BASES;
              return (
                <button
                  aria-pressed={active}
                  className={`flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-control-selected" : "hover:bg-control-hover"}`}
                  disabled={!active && (unavailable || capped)}
                  key={base.id}
                  onClick={() => toggle(base.id)}
                  title={unavailable ? "Unavailable; a saved selection is retained until you remove it" : undefined}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-semibold text-ink">{base.name}</span>
                    <span className={`mt-0.5 block text-xs leading-5 ${unavailable ? "text-caution" : "text-ink-muted"}`}>
                      {unavailable
                        ? active ? "Archived · selection retained" : "Archived · unavailable"
                        : base.description || `Content revision ${base.contentRevision}`}
                    </span>
                  </span>
                  <span className={`mt-0.5 grid min-h-5 min-w-5 shrink-0 place-items-center rounded-control border px-1 ${active ? "border-proof bg-proof text-proof-contrast" : "border-control-boundary"}`}>
                    {active ? <span className="font-mono text-metadata" aria-label={`Order ${selectedBaseIds.indexOf(base.id) + 1}`}>#{selectedBaseIds.indexOf(base.id) + 1}</span> : null}
                  </span>
                </button>
              );
            })}
            {dataState === "loading" && bases.length === 0 ? <p className="px-3 py-4 text-xs text-ink-muted" role="status">Loading Knowledge bases…</p> : null}
            {dataState === "ready" && bases.length === 0 ? <p className="px-3 py-4 text-xs text-ink-muted">No Knowledge bases are available.</p> : null}
            {dataState === "error" ? (
              <div className="px-3 py-3">
                <p className="text-xs text-danger" role="alert">{dataError ?? "Knowledge bases could not be loaded."}</p>
                <button className="mt-2 inline-flex min-h-touch items-center gap-1.5 rounded-control px-2 text-xs font-medium text-ink-secondary hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={onRetry} type="button">
                  <RefreshCw aria-hidden="true" className="size-3.5" /> Retry
                </button>
              </div>
            ) : null}
          </div>
          {onSaveChatDefault || (hasChatDefault && onClearChatDefault) ? (
            <div className="mt-3 border-t border-trace-subtle pt-3">
              {onSaveChatDefault ? (
                <button className="min-h-touch w-full rounded-control px-3 py-2 text-left text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus" onClick={onSaveChatDefault} type="button">
                  Save current plan as chat default
                </button>
              ) : null}
              {hasChatDefault && onClearChatDefault ? (
                <button className="min-h-touch w-full rounded-control px-3 py-2 text-left text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus" onClick={onClearChatDefault} type="button">
                  Clear chat default · use project default or Off
                </button>
              ) : null}
            </div>
          ) : null}
          {source === "assistant" ? <p className="mt-2 border-t border-trace-subtle px-3 pt-3 text-metadata text-ink-muted">Changing this exact plan removes the Assistant from the composer.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

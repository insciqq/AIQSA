"use client";

import { useComposerPickerSession } from "@/components/app-shell/composerPicker";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { focusRing, quietButton, touchTarget } from "./adminPrimitives";

export type AdminSearchablePickerItem = Readonly<{
  id: string;
  keywords?: readonly string[];
  label: string;
  secondaryText: string;
}>;

export type AdminSearchablePickerProps = Readonly<{
  description?: string;
  disabled?: boolean;
  emptyDescription?: string;
  emptyTitle?: string;
  error?: string | null;
  items: readonly AdminSearchablePickerItem[];
  label: string;
  loading?: boolean;
  loadingLabel?: string;
  noun?: Readonly<{ plural: string; singular: string }>;
  onOpenChange?(open: boolean): void;
  onRetry?(): void;
  onSelect(item: AdminSearchablePickerItem): void;
  placeholder?: string;
  searchPlaceholder?: string;
  selectedFallbackLabel?: string;
  selectedId?: string | null;
}>;

const pickerScrollMargins = { bottom: 4, top: 4 };
const optionCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function itemCountLabel(
  count: number,
  noun: AdminSearchablePickerProps["noun"]
): string {
  const labels = noun ?? { plural: "options", singular: "option" };
  return `${count} ${count === 1 ? labels.singular : labels.plural}`;
}

function searchableText(item: AdminSearchablePickerItem): string {
  return [item.label, item.secondaryText, ...(item.keywords ?? [])]
    .join(" ")
    .toLocaleLowerCase();
}

export function AdminSearchablePicker({
  description,
  disabled = false,
  emptyDescription = "Refresh the catalog or check the selected credential.",
  emptyTitle = "No options available",
  error = null,
  items,
  label,
  loading = false,
  loadingLabel,
  noun,
  onOpenChange,
  onRetry,
  onSelect,
  placeholder = "Select an option",
  searchPlaceholder = "Search by name or id",
  selectedFallbackLabel = "Selected option",
  selectedId = null
}: AdminSearchablePickerProps) {
  const idPrefix = useId();
  const dialogId = `${idPrefix}-dialog`;
  const descriptionId = `${idPrefix}-description`;
  const headingId = `${idPrefix}-heading`;
  const listboxId = `${idPrefix}-options`;
  const [query, setQuery] = useState("");
  const sortedItems = useMemo(
    () =>
      [...items].sort((left, right) =>
        optionCollator.compare(left.label, right.label) || optionCollator.compare(left.id, right.id)
      ),
    [items]
  );
  const filteredItems = useMemo(
    () => {
      const queryTokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return queryTokens.length === 0
        ? sortedItems
        : sortedItems.filter((item) => {
            const haystack = searchableText(item);
            return queryTokens.every((token) => haystack.includes(token));
          });
    },
    [query, sortedItems]
  );
  const selectedItem = sortedItems.find((item) => item.id === selectedId);
  const selectedIndex = filteredItems.findIndex((item) => item.id === selectedId);
  const hasQuery = query.trim().length > 0;
  const countText = hasQuery
    ? `${filteredItems.length} of ${itemCountLabel(sortedItems.length, noun)}`
    : itemCountLabel(sortedItems.length, noun);

  const {
    boundaryProps,
    boundaryRef,
    close,
    dialogProps,
    dialogRef,
    getItemProps,
    handleSearchKeyDown,
    navigableIndex,
    open,
    resultsRef,
    searchRef,
    setActiveIndex,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId,
    disabled,
    initialFocus: "search",
    itemFocusPreventScroll: true,
    items: filteredItems,
    onClose: () => setQuery(""),
    onOpenChange,
    onSelect,
    openFromTriggerKeys: true,
    scrollMargins: pickerScrollMargins,
    selectedIndex
  });

  const loadingText = loadingLabel ?? `Loading ${noun?.plural ?? "options"}…`;
  const activeItem = filteredItems[navigableIndex];
  const selectedPrimary = selectedItem?.label
    ?? (selectedId ? selectedFallbackLabel : null)
    ?? (loading ? loadingText : null)
    ?? (error ? "Catalog unavailable" : null)
    ?? placeholder;
  const selectedSecondary = selectedItem?.secondaryText ?? selectedId;
  const showInitialEmpty = !loading && !error && sortedItems.length === 0;
  const showNoResults = sortedItems.length > 0 && filteredItems.length === 0;

  return (
    <div {...boundaryProps} className="relative min-w-0" ref={boundaryRef}>
      <span className="mb-1 block text-xs font-medium text-content-secondary">{label}</span>
      {description ? <span className="mb-2 block text-[11px] leading-4 text-content-muted" id={descriptionId}>{description}</span> : null}
      <button
        {...triggerProps}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={label}
        className={`flex min-h-control w-full min-w-0 items-center justify-between gap-3 rounded-control border border-separator-subtle bg-surface-thread px-3 py-2 text-left text-content-primary hover:bg-surface-hover ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60`}
        disabled={disabled}
        onClick={toggle}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm leading-5 [overflow-wrap:anywhere]">{selectedPrimary}</span>
          {selectedSecondary ? (
            <span className="mt-0.5 block break-words font-mono text-[11px] leading-4 text-content-muted [overflow-wrap:anywhere]">
              {selectedSecondary}
            </span>
          ) : null}
        </span>
        <ChevronDown className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
      </button>

      {open ? (
        <div
          {...dialogProps}
          aria-labelledby={headingId}
          className="absolute left-0 top-full z-50 mt-1 flex max-h-[min(30rem,calc(100dvh-8rem))] w-[min(36rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-panel border border-separator-subtle bg-surface-overlay p-3 shadow-overlay max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[max(.5rem,env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:max-h-[min(80dvh,36rem)] max-sm:w-auto max-sm:pb-[calc(.75rem+env(safe-area-inset-bottom))]"
          ref={dialogRef}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-content-primary" id={headingId}>{label}</h3>
              {description ? <p className="mt-0.5 text-xs leading-4 text-content-muted">{description}</p> : null}
            </div>
            <button
              aria-label={`Close ${label}`}
              className={`grid size-9 shrink-0 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary ${focusRing} ${touchTarget}`}
              onClick={close}
              type="button"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mb-2 flex min-h-control items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 focus-within:ring-2 focus-within:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch">
            <Search className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
            <input
              aria-activedescendant={activeItem ? `${idPrefix}-option-${navigableIndex}` : undefined}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-label={`Search ${noun?.plural ?? "options"}`}
              className="min-w-0 flex-1 bg-transparent text-sm text-content-primary outline-none placeholder:text-content-muted"
              onChange={(event) => {
                setActiveIndex(0);
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab" && error && onRetry) {
                  return;
                }
                handleSearchKeyDown(event);
              }}
              placeholder={searchPlaceholder}
              ref={searchRef}
              role="combobox"
              type="search"
              value={query}
            />
          </div>

          <div className="mb-2 flex min-h-5 items-center justify-between gap-3 text-[11px] text-content-muted">
            <span aria-live="polite" className="tabular-nums">{countText}</span>
            {loading && sortedItems.length > 0 ? <span role="status">Refreshing…</span> : null}
          </div>

          {error ? (
            <div className="mb-2 flex items-start justify-between gap-3 rounded-control bg-accent-rose/10 px-3 py-2 text-xs leading-5 text-accent-rose" role="alert">
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
              {onRetry ? <button className={quietButton} disabled={loading} onClick={onRetry} type="button">Retry</button> : null}
            </div>
          ) : null}

          {loading && sortedItems.length === 0 ? (
            <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
              <p className="text-sm font-medium text-content-primary">{loadingText}</p>
              <p className="mt-1 text-xs text-content-muted">The picker will update when the catalog is ready.</p>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" ref={resultsRef}>
            {showInitialEmpty ? (
              <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-content-primary">{emptyTitle}</p>
                <p className="mt-1 text-xs leading-5 text-content-muted">{emptyDescription}</p>
              </div>
            ) : null}
            {showNoResults ? (
              <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-content-primary">No matches for “{query.trim()}”</p>
                <p className="mt-1 text-xs text-content-muted">Try a model name, provider, or raw id.</p>
              </div>
            ) : null}
            <div className="space-y-1" id={listboxId} role="listbox" aria-label={label}>
              {filteredItems.map((item, index) => {
                const active = index === navigableIndex;
                const selected = item.id === selectedId;

                return (
                  <button
                    key={item.id}
                    {...getItemProps(index)}
                    aria-selected={selected}
                    className={[
                      "flex min-h-touch w-full min-w-0 items-start justify-between gap-3 rounded-control px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
                      active
                        ? "bg-surface-hover text-content-primary"
                        : selected
                          ? "bg-surface-selected text-content-primary"
                          : "text-content-secondary hover:bg-surface-hover hover:text-content-primary"
                    ].join(" ")}
                    id={`${idPrefix}-option-${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    role="option"
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm leading-5 text-content-primary [overflow-wrap:anywhere]">{item.label}</span>
                      <span className="mt-0.5 block break-words font-mono text-[11px] leading-4 text-content-muted [overflow-wrap:anywhere]">{item.secondaryText}</span>
                    </span>
                    {selected ? (
                      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-accent-cyan">
                        <Check className="size-3.5" aria-hidden="true" />
                        Selected
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="sr-only" aria-live="polite">
            {activeItem
              ? `${activeItem.label}, ${navigableIndex + 1} of ${filteredItems.length}`
              : filteredItems.length === 0
                ? "No matching options"
                : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import type { CatalogSearchStrategy } from "@/lib/contracts/catalog";
import { isSearchCombinationCompatible } from "@/lib/domain/catalogMatrix";
import { MAX_SEARCH_PLAN_OPTIONS, type SearchPlanMode } from "@/lib/domain/search";
import "./search-plan-picker.css";

/**
 * The web search sources as a checkbox list; admission still revalidates
 * every selected source. Every search goes to all selected sources (operator
 * decision 2026-10-24), so combinations are checked for that mode unless an
 * Assistant's own row combines them otherwise. Search is turned off only in
 * Chat defaults, so the last source cannot be unchecked unless `allowEmpty`.
 */
export function SearchPlanPickerV2({
  options,
  selectedIds,
  onChange,
  disabled = false,
  availableIds,
  allowEmpty = false,
  combineMode = "all_selected",
  lastSourceNote
}: Readonly<{
  options: readonly CatalogSearchStrategy[];
  selectedIds: readonly string[];
  onChange(optionIds: readonly string[]): void;
  disabled?: boolean;
  availableIds?: ReadonlySet<string>;
  /** An Assistant chat's adjustable row may still be turned off here. */
  allowEmpty?: boolean;
  combineMode?: SearchPlanMode;
  /** Shown beside the one selected source that cannot be unchecked. */
  lastSourceNote?: string;
}>) {
  const sources = options.filter(option => option.kind !== "none");
  const unavailable = selectedIds.filter(id => !sources.some(option => option.strategyId === id));
  const keepsLast = !allowEmpty && selectedIds.length === 1;
  // The limit is named only when more sources are listed than it allows, so
  // the count never reads as "of N available".
  const limited = sources.length + unavailable.length > MAX_SEARCH_PLAN_OPTIONS;
  return <div className="v2-search-plan-picker">
    <div className="v2-search-plan-heading">
      <span>{selectedIds.length ? `${selectedIds.length} selected` : "Search off"}{limited ? ` · up to ${MAX_SEARCH_PLAN_OPTIONS}` : ""}</span>
    </div>
    <fieldset disabled={disabled} aria-label="Search sources" className="v2-search-plan-sources">
      {sources.map(option => {
        const selected = selectedIds.includes(option.strategyId);
        const available = !availableIds || availableIds.has(option.strategyId);
        const atLimit = selectedIds.length >= MAX_SEARCH_PLAN_OPTIONS;
        const compatible = isSearchCombinationCompatible([...selectedIds, option.strategyId], sources, combineMode);
        const locked = selected && keepsLast;
        const reason = !available ? "Unavailable for this model"
          : !selected && atLimit ? `Choose up to ${MAX_SEARCH_PLAN_OPTIONS} sources`
            : !selected && !compatible ? "Can't be combined with the selected sources"
              : locked ? lastSourceNote : undefined;
        return <label key={option.strategyId} className="v2-search-plan-source" data-locked={locked || undefined}>
          <input type="checkbox" checked={selected} disabled={locked || (!selected && (!available || atLimit || !compatible))}
            onChange={() => onChange(selected
              ? selectedIds.filter(id => id !== option.strategyId)
              : [...selectedIds, option.strategyId])} />
          <span><strong>{option.displayName}</strong>{reason ? <small>{reason}</small> : null}</span>
        </label>;
      })}
      {unavailable.map(id => <label key={id} className="v2-search-plan-source">
        <input type="checkbox" checked disabled={keepsLast} onChange={() => onChange(selectedIds.filter(value => value !== id))} />
        <span><strong>Unavailable source</strong><small>{keepsLast ? "Choose another source first, then remove this one." : "Remove it to choose another source."}</small></span>
      </label>)}
      {!sources.length && !unavailable.length ? <p>No search sources are available.</p> : null}
    </fieldset>
  </div>;
}

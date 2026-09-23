"use client";

import type { CatalogSearchStrategy } from "@/lib/contracts/catalog";
import { isSearchCombinationCompatible } from "@/lib/domain/catalogMatrix";
import { MAX_SEARCH_PLAN_OPTIONS, type SearchPlan } from "@/lib/domain/search";
import { useId } from "react";
import "./search-plan-picker.css";

/** Shared selection UI; admission still revalidates every selected source. */
export function SearchPlanPickerV2({ options, plan, onChange, disabled = false, availableIds, onReset, scope }: Readonly<{
  options: readonly CatalogSearchStrategy[];
  plan: SearchPlan;
  onChange(plan: SearchPlan): void;
  disabled?: boolean;
  availableIds?: ReadonlySet<string>;
  onReset?(): void;
  scope: "chat" | "defaults";
}>) {
  const descriptionId = useId();
  const sources = options.filter(option => option.kind !== "none");
  const unavailable = plan.optionIds.filter(id => !sources.some(option => option.strategyId === id));
  const allSelectedAllowed = isSearchCombinationCompatible(plan.optionIds, sources, "all_selected");
  return <div className="v2-search-plan-picker">
    <div className="v2-search-plan-heading">
      <span>{plan.optionIds.length} of {MAX_SEARCH_PLAN_OPTIONS} sources</span>
      <button className="v2-search-plan-link v2-focusable" type="button" disabled={disabled || !plan.optionIds.length}
        onClick={() => onChange({ ...plan, optionIds: [] })}>Turn off search</button>
    </div>
    <fieldset disabled={disabled} aria-label="Search sources" className="v2-search-plan-sources">
      {sources.map(option => {
        const selected = plan.optionIds.includes(option.strategyId);
        const available = !availableIds || availableIds.has(option.strategyId);
        const atLimit = plan.optionIds.length >= MAX_SEARCH_PLAN_OPTIONS;
        const compatible = isSearchCombinationCompatible([...plan.optionIds, option.strategyId], sources, plan.mode);
        const reason = !available ? "Unavailable for this model" : !selected && atLimit ? "Choose up to 3 sources"
          : !selected && !compatible ? "Select “Let the model choose” to combine this source" : option.description;
        return <label key={option.strategyId} className="v2-search-plan-source">
          <input type="checkbox" checked={selected} disabled={!selected && (!available || atLimit || !compatible)}
            onChange={() => onChange({ ...plan, optionIds: selected ? plan.optionIds.filter(id => id !== option.strategyId) : [...plan.optionIds, option.strategyId] })} />
          <span><strong>{option.displayName}</strong>{reason ? <small>{reason}</small> : null}</span>
        </label>;
      })}
      {unavailable.map(id => <label key={id} className="v2-search-plan-source">
        <input type="checkbox" checked onChange={() => onChange({ ...plan, optionIds: plan.optionIds.filter(value => value !== id) })} />
        <span><strong>Unavailable source</strong><small>Remove it to choose another source.</small></span>
      </label>)}
      {!sources.length && !unavailable.length ? <p>No search sources are available.</p> : null}
    </fieldset>
    <label className="v2-search-plan-mode">When the model searches
      <select aria-describedby={descriptionId} disabled={disabled} value={plan.mode}
        onChange={event => onChange({ ...plan, mode: event.target.value === "model_choice" ? "model_choice" : "all_selected" })}>
        <option disabled={!allSelectedAllowed} value="all_selected">Search all selected sources</option>
        <option value="model_choice">Let the model choose</option>
      </select>
    </label>
    <p id={descriptionId} className="v2-search-plan-help">{plan.mode === "all_selected"
      ? "Each search sends the same query to every selected source."
      : "The model decides which selected sources to query."} The model searches only when needed.{!allSelectedAllowed ? " These sources can be combined only when the model chooses." : ""}</p>
    {onReset ? <button className="v2-search-plan-link v2-focusable" disabled={disabled} type="button" onClick={onReset}>Use organization Search default</button> : null}
    <p className="v2-search-plan-help">{scope === "chat" ? "Saved for this chat. Chat defaults stay unchanged." : "Used for new chats. Existing chats keep their choices."}</p>
  </div>;
}

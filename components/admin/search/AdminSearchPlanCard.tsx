"use client";

import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  planCompatible,
  planKind,
  selectablePlanSources,
  type SearchPlanOption
} from "@/components/admin/search/searchSourceView";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";
import { useState } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const touchTarget = "[@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch";

/**
 * Recommended Search plan (PRD 5.6, semantics unchanged): the sources a new
 * user searches with until they choose their own. It never grants access, so
 * only enabled, working sources can be picked. Mount it keyed by the policy
 * version so a saved plan becomes the new baseline.
 */
export function AdminSearchPlanCard({
  busy,
  catalog,
  onSave
}: Readonly<{
  busy: boolean;
  catalog: AdminSearchCatalog;
  onSave(plan: SearchPlan): Promise<string | null>;
}>) {
  const [optionIds, setOptionIds] = useState<string[]>([...catalog.policy.defaultPlan.optionIds]);
  const [planMode, setPlanMode] = useState<SearchPlanMode>(catalog.policy.defaultPlan.mode);
  const [formError, setFormError] = useState<string | null>(null);
  const selectable = selectablePlanSources(catalog);
  const options: SearchPlanOption[] = selectable.map((source) => ({
    executionModes: source.executionModes,
    kind: planKind(source),
    strategyId: source.strategyId
  }));
  const missing = optionIds.filter((optionId) =>
    !selectable.some((source) => source.strategyId === optionId));

  function toggle(optionId: string) {
    const active = optionIds.includes(optionId);
    const next = active
      ? optionIds.filter((candidate) => candidate !== optionId)
      : [...optionIds, optionId];
    if (!active && (next.length > 3 || !planCompatible(next, options, "model_choice"))) return;
    const nextMode = next.length === 0
      ? "all_selected"
      : planCompatible(next, options, planMode)
        ? planMode
        : "model_choice";
    setOptionIds(next);
    setPlanMode(nextMode);
    setFormError(null);
  }

  const dirty = planMode !== catalog.policy.defaultPlan.mode ||
    optionIds.join(" ") !== catalog.policy.defaultPlan.optionIds.join(" ");
  const allSelectedAvailable = optionIds.length > 0 &&
    planCompatible(optionIds, options, "all_selected");
  const canSave = dirty && missing.length === 0 && !busy;

  return (
    <section aria-labelledby="admin-search-plan-heading" className="grid gap-2.5" data-testid="admin-search-plan">
      <h2 className={sectionHeadingClass} id="admin-search-plan-heading">Recommended Search plan</h2>
      <div className={cardClass}>
        <div className="grid gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Default for users</p>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">
              Used until a person makes a personal choice. This recommendation never grants access.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectable.map((source) => {
              const active = optionIds.includes(source.strategyId);
              const disabled = !active && (optionIds.length >= 3 || !planCompatible(
                [...optionIds, source.strategyId],
                options,
                "model_choice"
              ));
              return (
                <button
                  aria-pressed={active}
                  className={`inline-flex min-h-control items-center gap-2 rounded-control border px-3 py-1.5 text-[13px] ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:border-trace-subtle disabled:opacity-45 ${active ? "border-proof bg-control-selected text-ink" : "border-control-boundary bg-answer-paper text-ink-secondary hover:bg-control-hover"}`}
                  disabled={disabled || busy}
                  key={source.strategyId}
                  onClick={() => toggle(source.strategyId)}
                  type="button"
                >
                  {active ? <UiV2Icon className="size-3.5 text-proof" name="check" /> : null}
                  {source.displayName}
                </button>
              );
            })}
            {missing.map((optionId) => {
              const source = catalog.integrations.find((candidate) => candidate.strategyId === optionId);
              const displayName = source?.displayName ?? "Search source";
              return (
                <button
                  aria-label={`Remove unavailable ${displayName}`}
                  aria-pressed="true"
                  className={`inline-flex min-h-control items-center gap-2 rounded-control border border-caution/55 bg-caution/10 px-3 py-1.5 text-[13px] text-caution hover:bg-caution/15 ${focusRing} ${touchTarget}`}
                  disabled={busy}
                  key={optionId}
                  onClick={() => toggle(optionId)}
                  type="button"
                >
                  <UiV2Icon className="size-3.5" name="alert" />
                  <span>{displayName} · unavailable</span>
                  <UiV2Icon className="size-3.5" name="close" />
                </button>
              );
            })}
            {selectable.length === 0 ? (
              <span className="text-xs text-ink-muted">No enabled, working Search sources yet.</span>
            ) : null}
          </div>
          {optionIds.length > 1 ? (
            <div className="flex flex-wrap gap-4 border-t border-trace-subtle pt-3 text-xs text-ink-secondary">
              <label className={allSelectedAvailable ? "flex items-center gap-2" : "flex items-center gap-2 opacity-45"}>
                <input
                  checked={planMode === "all_selected"}
                  className="accent-proof"
                  disabled={!allSelectedAvailable || busy}
                  onChange={() => setPlanMode("all_selected")}
                  type="radio"
                />
                Search all selected sources
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={planMode === "model_choice" || !allSelectedAvailable}
                  className="accent-proof"
                  disabled={busy}
                  onChange={() => setPlanMode("model_choice")}
                  type="radio"
                />
                Let the model choose
              </label>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-b-[12px] border-t border-trace-subtle bg-workspace-rail/40 px-5 py-3">
          <p className="mr-auto min-w-0 text-xs text-ink-muted" role="status">
            {missing.length > 0
              ? "The saved recommendation includes an unavailable source. Remove it or make it work before saving."
              : formError ?? (dirty ? "Unsaved changes" : "No unsaved changes")}
          </p>
          {formError ? <span className="sr-only" role="alert">{formError}</span> : null}
          <UiV2Button
            disabled={!dirty || busy}
            onClick={() => {
              setOptionIds([...catalog.policy.defaultPlan.optionIds]);
              setPlanMode(catalog.policy.defaultPlan.mode);
              setFormError(null);
            }}
            tone="ghost"
            type="button"
          >
            Discard
          </UiV2Button>
          <UiV2Button
            busy={busy && dirty}
            disabled={!canSave}
            onClick={() => {
              setFormError(null);
              void onSave({ mode: planMode, optionIds }).then((message) => {
                if (message) setFormError(message);
              });
            }}
            tone="primary"
            type="button"
          >
            Save default
          </UiV2Button>
        </div>
      </div>
    </section>
  );
}

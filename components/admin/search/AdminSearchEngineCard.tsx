"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { searchDefaultOrderText, searchEngineCandidates } from "@/components/admin/search/searchSourceView";
import type { AdminSearchPolicyInput } from "@/components/admin/search/useAdminSearchController";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import { useEffect, useId, useRef, useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-xs leading-5 text-ink-muted";
const AUTOMATIC = "";
const NO_BACKUP = "";

/** The saved choices; a field an older server left out reads as its default. */
export function savedSearchPolicy(policy: AdminSearchCatalog["policy"]): AdminSearchPolicyInput {
  return {
    backupOptionId: policy.backupOptionId ?? null,
    engineOptionId: policy.engineOptionId ?? null,
    inAnswerSearch: policy.inAnswerSearch ?? true
  };
}

/** What the installation searches with now, in the server's words (`policy.resolved`). */
function resolvedText(catalog: AdminSearchCatalog, name: (optionId: string) => string): string | null {
  const resolved = catalog.policy.resolved;
  if (!resolved) return null;
  if (resolved.reason === "search_engine_not_configured" || (!resolved.engineOptionId && resolved.automatic)) {
    return "No engine can search yet. Add a provider with Search, or set up a source below.";
  }
  if (resolved.reason === "search_engine_unavailable" || !resolved.engineOptionId) {
    const chosen = catalog.policy.engineOptionId;
    return `${chosen ? name(chosen) : "The chosen engine"} cannot search now, and nothing replaces it. Make it work again or choose another engine.`;
  }
  const engine = `${resolved.automatic ? "Automatic: searching with" : "Searching with"} ${name(resolved.engineOptionId)}`;
  return resolved.backupOptionId ? `${engine}, backup ${name(resolved.backupOptionId)}.` : `${engine}.`;
}

/**
 * The installation's Search (operator decisions 2026-11-26): one engine every
 * model, sub-agent and Deep research searches with (Automatic takes the first
 * working one in the default order), an optional backup used only when a
 * search with the engine fails, and whether GPT searches inside its own
 * answer. Only live sources that can search for every model can be either.
 * Mount it keyed by the policy version so a saved choice becomes the new
 * baseline; a Save from the footer focuses the remounted card's status line,
 * so the owner keeps `focusStatus` across the remount.
 */
export function AdminSearchEngineCard({
  busy,
  catalog,
  focusStatus = false,
  onFocusStatusChange,
  onSave
}: Readonly<{
  busy: boolean;
  catalog: AdminSearchCatalog;
  focusStatus?: boolean;
  onFocusStatusChange?(focusStatus: boolean): void;
  onSave(input: AdminSearchPolicyInput): Promise<string | null>;
}>) {
  const saved = savedSearchPolicy(catalog.policy);
  const [engine, setEngine] = useState(saved.engineOptionId ?? AUTOMATIC);
  const [backup, setBackup] = useState(saved.backupOptionId ?? NO_BACKUP);
  const [inAnswerSearch, setInAnswerSearch] = useState(saved.inAnswerSearch);
  const [formError, setFormError] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const ids = useId();
  useEffect(() => {
    if (!focusStatus) return;
    statusRef.current?.focus();
    onFocusStatusChange?.(false);
  }, [focusStatus, onFocusStatusChange]);

  const candidates = searchEngineCandidates(catalog);
  const usable = (optionId: string) => candidates.some((source) => source.strategyId === optionId);
  const name = (optionId: string) =>
    catalog.integrations.find((source) => source.strategyId === optionId)?.displayName ?? "Search source";
  const engineValid = engine === AUTOMATIC || usable(engine);
  const backupValid = backup === NO_BACKUP || (usable(backup) && backup !== engine);
  const dirty = engine !== (saved.engineOptionId ?? AUTOMATIC) || backup !== (saved.backupOptionId ?? NO_BACKUP) ||
    inAnswerSearch !== saved.inAnswerSearch;
  const canSave = dirty && engineValid && backupValid && !busy;
  const resolved = resolvedText(catalog, name);
  const invalidStatus = !engineValid
    ? `${name(engine)} can no longer be the engine. Choose another engine or Automatic before saving.`
    : !backupValid
      ? `${name(backup)} can no longer be the backup. Choose another backup or None before saving.`
      : null;

  return (
    <section aria-labelledby="admin-search-engine-heading" className="grid gap-2.5" data-testid="admin-search-engine">
      <h2 className={sectionHeadingClass} id="admin-search-engine-heading">Engine</h2>
      <div className={cardClass}>
        <div className="grid gap-4 px-5 py-4">
          <p className="text-xs leading-5 text-ink-muted">
            Every chat, sub-agent, Deep research and Automation searches with one engine. People only turn Search on
            or off.
          </p>
          {resolved ? (
            <p className="text-sm font-medium text-ink" data-testid="admin-search-engine-resolved">{resolved}</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block min-w-0">
              <span className={fieldLabel}>Search engine</span>
              <select
                aria-describedby={`${ids}-engine-help`}
                aria-invalid={engineValid ? undefined : true}
                className={inputClass}
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setEngine(next);
                  if (next !== AUTOMATIC && next === backup) setBackup(NO_BACKUP);
                  setFormError(null);
                }}
                value={engine}
              >
                <option value={AUTOMATIC}>Automatic</option>
                {engine !== AUTOMATIC && !usable(engine) ? (
                  <option disabled value={engine}>{name(engine)} · unavailable</option>
                ) : null}
                {candidates.map((source) => (
                  <option key={source.strategyId} value={source.strategyId}>{source.displayName}</option>
                ))}
              </select>
              <span className={helpText} id={`${ids}-engine-help`}>
                Automatic uses the first working one of: {searchDefaultOrderText()}. Other sources are used only
                when chosen here.
              </span>
            </label>
            <label className="block min-w-0">
              <span className={fieldLabel}>Backup</span>
              <select
                aria-describedby={`${ids}-backup-help`}
                aria-invalid={backupValid ? undefined : true}
                className={inputClass}
                disabled={busy}
                onChange={(event) => {
                  setBackup(event.currentTarget.value);
                  setFormError(null);
                }}
                value={backup}
              >
                <option value={NO_BACKUP}>None</option>
                {backup !== NO_BACKUP && !usable(backup) ? (
                  <option disabled value={backup}>{name(backup)} · unavailable</option>
                ) : null}
                {candidates.map((source) => (
                  <option disabled={source.strategyId === engine} key={source.strategyId} value={source.strategyId}>
                    {source.displayName}
                  </option>
                ))}
              </select>
              <span className={helpText} id={`${ids}-backup-help`}>
                Searched only when a search with the engine fails.
              </span>
            </label>
          </div>
          {candidates.length === 0 ? (
            <p className="text-xs text-ink-muted">
              No source can be the engine yet: a source needs to be turned on and working with its own Search model.
            </p>
          ) : null}
          <div className="flex min-w-0 items-start justify-between gap-6 border-t border-trace-subtle pt-4">
            <span className="min-w-0">
              <strong className="block text-sm font-medium text-ink" id={`${ids}-in-answer`}>
                GPT searches inside its own answer
              </strong>
              <span className="mt-1 block max-w-2xl text-xs leading-5 text-ink-muted">
                GPT models on an OpenAI or Codex LB connection use OpenAI&apos;s search within their answer. Every
                other model, sub-agent and researcher searches with the engine.
              </span>
            </span>
            <UiV2Switch
              checked={inAnswerSearch}
              className="shrink-0"
              data-testid="admin-search-in-answer"
              disabled={busy}
              label="GPT searches inside its own answer"
              onChange={(next) => {
                setInAnswerSearch(next);
                setFormError(null);
              }}
            />
          </div>
        </div>
        {/* The actions appear with a change, so a clean card offers none (issue #66). */}
        <div className="flex min-h-14 flex-wrap items-center gap-2 rounded-b-[12px] border-t border-trace-subtle bg-workspace-rail/40 px-5 py-3">
          <p className="mr-auto min-w-0 text-xs text-ink-muted outline-none" ref={statusRef} role="status" tabIndex={-1}>
            {invalidStatus ?? formError ?? (dirty ? "Unsaved changes" : "No unsaved changes")}
          </p>
          {formError ? <span className="sr-only" role="alert">{formError}</span> : null}
          {dirty ? (
            <>
              <UiV2Button
                disabled={busy}
                onClick={() => {
                  setEngine(saved.engineOptionId ?? AUTOMATIC);
                  setBackup(saved.backupOptionId ?? NO_BACKUP);
                  setInAnswerSearch(saved.inAnswerSearch);
                  setFormError(null);
                  statusRef.current?.focus();
                }}
                tone="ghost"
                type="button"
              >
                Discard
              </UiV2Button>
              <UiV2Button
                busy={busy}
                disabled={!canSave}
                onClick={() => {
                  // Read before busy disables Save, which drops focus to the page.
                  const footerFocused = statusRef.current?.parentElement?.contains(document.activeElement) === true;
                  setFormError(null);
                  void onSave({
                    backupOptionId: backup === NO_BACKUP ? null : backup,
                    engineOptionId: engine === AUTOMATIC ? null : engine,
                    inAnswerSearch
                  }).then((message) => {
                    if (message) setFormError(message);
                    else if (footerFocused) onFocusStatusChange?.(true);
                  });
                }}
                tone="primary"
                type="button"
              >
                Save
              </UiV2Button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

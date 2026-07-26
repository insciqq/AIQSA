"use client";

import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { useAdminRunProfilesController } from "@/components/admin/useAdminRunProfilesController";
import type {
  AdminRunProfile,
  AdminRunProfileCatalog,
  AdminRunProfileModel,
  RunProfileId
} from "@/lib/contracts/runProfiles";
import { RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

type ProfileDraft = Pick<
  AdminRunProfile,
  | "description"
  | "enabled"
  | "id"
  | "providerModelId"
  | "reasoningEffort"
  | "reasoningMode"
  | "version"
>;

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

function draftsFromCatalog(catalog: AdminRunProfileCatalog): ProfileDraft[] {
  return catalog.profiles.map((profile) => ({
    description: profile.description,
    enabled: profile.enabled,
    id: profile.id,
    providerModelId: profile.providerModelId,
    reasoningEffort: profile.reasoningEffort,
    reasoningMode: profile.reasoningMode,
    version: profile.version
  }));
}

function updateDraft(
  drafts: ProfileDraft[],
  id: RunProfileId,
  update: (draft: ProfileDraft) => ProfileDraft
): ProfileDraft[] {
  return drafts.map((draft) => draft.id === id ? update(draft) : draft);
}

function valuesWithCurrent(options: string[], current: string): string[] {
  return options.includes(current) ? options : [current, ...options];
}

function ProfileRow({
  draft,
  disabled,
  label,
  models,
  onChange
}: {
  disabled: boolean;
  draft: ProfileDraft;
  label: string;
  models: AdminRunProfileModel[];
  onChange(next: ProfileDraft): void;
}) {
  const selectedModel = models.find((model) => model.id === draft.providerModelId) ?? null;
  const efforts = valuesWithCurrent(selectedModel?.reasoningEfforts ?? [], draft.reasoningEffort);
  const modes = valuesWithCurrent(selectedModel?.reasoningModes ?? [], draft.reasoningMode);

  return (
    <fieldset className="grid min-w-0 gap-4 border-t border-trace-subtle px-4 py-5 sm:px-6 lg:grid-cols-[minmax(12rem,.8fr)_minmax(20rem,1.5fr)] lg:items-start">
      <legend className="sr-only">{label} run profile</legend>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          Composer shortcut. Empty deployment disables this profile without deleting its slot.
        </p>
        <label className="mt-3 block min-w-0">
          <span className={fieldLabel}>Description</span>
          <input
            aria-label={`${label} description`}
            className={inputClass}
            disabled={disabled}
            maxLength={240}
            onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
            required
            value={draft.description}
          />
        </label>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 sm:col-span-2">
          <span className={fieldLabel}>Model deployment</span>
          <select
            aria-label={`${label} model deployment`}
            className={inputClass}
            disabled={disabled}
            onChange={(event) => {
              const providerModelId = event.currentTarget.value || null;
              const model = models.find((candidate) => candidate.id === providerModelId) ?? null;
              onChange({
                ...draft,
                enabled: Boolean(model),
                providerModelId,
                reasoningEffort: model?.defaultReasoningEffort ?? draft.reasoningEffort,
                reasoningMode: model?.defaultReasoningMode ?? draft.reasoningMode
              });
            }}
            value={draft.providerModelId ?? ""}
          >
            <option value="">Disabled</option>
            {models.map((model) => (
              <option disabled={!model.selectable} key={model.id} value={model.id}>
                {model.providerDisplayName} / {model.displayName}{model.selectable ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={fieldLabel}>Reasoning mode</span>
          <select
            aria-label={`${label} reasoning mode`}
            className={inputClass}
            disabled={disabled || !draft.enabled || !selectedModel?.selectable}
            onChange={(event) => onChange({ ...draft, reasoningMode: event.currentTarget.value })}
            value={draft.reasoningMode}
          >
            {modes.map((mode) => <option key={mode} value={mode}>{mode.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className={fieldLabel}>Reasoning effort</span>
          <select
            aria-label={`${label} reasoning effort`}
            className={inputClass}
            disabled={disabled || !draft.enabled || !selectedModel?.selectable}
            onChange={(event) => onChange({ ...draft, reasoningEffort: event.currentTarget.value })}
            value={draft.reasoningEffort}
          >
            {efforts.map((effort) => <option key={effort} value={effort}>{effort.replaceAll("_", " ")}</option>)}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

export function AdminRunProfilesPanel({
  active,
  refreshRevision = 0
}: {
  active: boolean;
  refreshRevision?: number;
}) {
  const controller = useAdminRunProfilesController(active, refreshRevision);
  const catalog = controller.state.catalog;
  const [draftState, setDraftState] = useState<{
    catalog: AdminRunProfileCatalog | null;
    drafts: ProfileDraft[];
  }>({ catalog: null, drafts: [] });
  let drafts = draftState.drafts;
  if (catalog !== draftState.catalog) {
    drafts = catalog ? draftsFromCatalog(catalog) : [];
    setDraftState({ catalog, drafts });
  }

  const labels = useMemo(
    () => new Map(catalog?.profiles.map((profile) => [profile.id, profile.label]) ?? []),
    [catalog]
  );
  const savedDrafts = catalog ? draftsFromCatalog(catalog) : [];
  const dirty = JSON.stringify(drafts) !== JSON.stringify(savedDrafts);
  const valid = Boolean(catalog) && drafts.every((draft) => {
    if (!draft.description.trim()) return false;
    if (!draft.enabled) return draft.providerModelId === null;
    const model = catalog?.models.find((candidate) => candidate.id === draft.providerModelId);
    return Boolean(
      model?.selectable &&
      model.reasoningEfforts.includes(draft.reasoningEffort) &&
      model.reasoningModes.includes(draft.reasoningMode)
    );
  });

  return (
    <section aria-busy={controller.state.busy || controller.state.loading} aria-labelledby="run-profiles-title" className="border-b border-trace-subtle bg-answer-paper">
      <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="max-w-3xl">
          <h2 className="text-sm font-semibold text-ink" id="run-profiles-title">Run profiles</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Map the three one-tap composer profiles to active model deployments and supported reasoning. Search and other generation controls remain independent.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          <button
            aria-label="Refresh run profiles"
            className={quietButton}
            disabled={controller.state.busy || controller.state.loading}
            onClick={() => void controller.actions.refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={`size-3.5 ${controller.state.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            className={primaryButton}
            disabled={controller.state.busy || controller.state.loading || !dirty || !valid}
            onClick={() => void controller.actions.save(drafts.map((draft) => ({
              description: draft.description,
              enabled: draft.enabled,
              expectedVersion: draft.version,
              id: draft.id,
              providerModelId: draft.enabled ? draft.providerModelId : null,
              reasoningEffort: draft.reasoningEffort,
              reasoningMode: draft.reasoningMode
            })))}
            type="button"
          >
            {controller.state.busy ? "Saving…" : "Save profiles"}
          </button>
        </div>
      </div>

      {controller.state.error ? (
        <div className="mx-4 mb-4 flex items-start justify-between gap-3 rounded-control bg-critical/10 px-3 py-2 text-xs leading-5 text-critical sm:mx-6" role="alert">
          <span>{controller.state.error}</span>
          {catalog ? (
            <button aria-label="Dismiss run profile error" className={quietButton} onClick={controller.actions.dismissError} type="button"><X aria-hidden="true" className="size-3.5" /></button>
          ) : null}
        </div>
      ) : null}
      {controller.state.notice ? (
        <div className="mx-4 mb-4 flex items-start justify-between gap-3 rounded-control bg-positive/10 px-3 py-2 text-xs leading-5 text-positive sm:mx-6" role="status">
          <span>{controller.state.notice}</span>
          <button aria-label="Dismiss run profile notice" className={quietButton} onClick={controller.actions.dismissNotice} type="button"><X aria-hidden="true" className="size-3.5" /></button>
        </div>
      ) : null}

      {!catalog && controller.state.loading ? (
        <p className="border-t border-trace-subtle px-4 py-6 text-center text-sm text-ink-muted" role="status">Loading run profiles…</p>
      ) : !catalog && controller.state.error ? (
        <div className="border-t border-trace-subtle px-4 py-10 text-center sm:px-6">
          <p className="text-sm font-semibold text-critical">Run profiles could not be loaded</p>
          <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">The current profile mapping is unavailable. No empty configuration is being assumed.</p>
          <button className={`${quietButton} mt-4`} onClick={() => void controller.actions.refresh()} type="button">
            Retry run profiles
          </button>
        </div>
      ) : catalog ? (
        drafts.map((draft) => (
          <ProfileRow
            disabled={controller.state.busy}
            draft={draft}
            key={draft.id}
            label={labels.get(draft.id) ?? draft.id}
            models={catalog.models}
            onChange={(next) => setDraftState((current) => ({
              ...current,
              drafts: updateDraft(current.drafts, draft.id, () => next)
            }))}
          />
        ))
      ) : null}
    </section>
  );
}

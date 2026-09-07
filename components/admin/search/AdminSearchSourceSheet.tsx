"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import {
  DEFAULT_SEARCH_DESCRIPTION,
  configurableModels,
  draftForModel,
  emptySearchForm,
  manuallyAddableModels,
  searchExecutionValidation,
  searchFormFrom,
  searchFormsEqual,
  sourceIdentityFor,
  type SearchSourceForm
} from "@/components/admin/search/searchSourceView";
import type { AdminSearchController } from "@/components/admin/search/useAdminSearchController";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import {
  adminSearchExecutionLimits,
  type AdminSearchCatalog,
  type AdminSearchDraft,
  type AdminSearchIntegration,
  type AdminSearchProviderModelOption
} from "@/lib/contracts/adminSearch";
import { useId, useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-xs leading-5 text-ink-muted";
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

type SheetMode =
  | Readonly<{ kind: "configure"; source: AdminSearchIntegration }>
  | Readonly<{ kind: "create" }>;

function ModelField({
  creating,
  disabled,
  form,
  options,
  providerModels,
  setForm
}: Readonly<{
  creating: boolean;
  disabled: boolean;
  form: SearchSourceForm;
  options: readonly AdminSearchProviderModelOption[];
  providerModels: readonly AdminSearchProviderModelOption[];
  setForm(value: SearchSourceForm): void;
}>) {
  return (
    <label className="block min-w-0">
      <span className={fieldLabel}>Search model</span>
      <select
        className={inputClass}
        disabled={disabled}
        onChange={(event) => {
          const previousModel = providerModels.find((candidate) => candidate.id === form.draft.providerModelId);
          const previousIdentity = previousModel ? sourceIdentityFor(previousModel) : null;
          const model = providerModels.find((candidate) => candidate.id === event.currentTarget.value);
          if (!model) {
            setForm({
              ...form,
              ...(creating && form.displayName === previousIdentity?.displayName ? { displayName: "" } : {}),
              ...(creating && form.description === previousIdentity?.description
                ? { description: DEFAULT_SEARCH_DESCRIPTION }
                : {}),
              draft: { ...form.draft, providerModelId: null }
            });
            return;
          }
          const nextIdentity = sourceIdentityFor(model);
          setForm({
            ...form,
            ...(creating && (!form.displayName.trim() || form.displayName === previousIdentity?.displayName)
              ? { displayName: nextIdentity.displayName }
              : {}),
            ...(creating && (form.description === DEFAULT_SEARCH_DESCRIPTION ||
              form.description === previousIdentity?.description)
              ? { description: nextIdentity.description }
              : {}),
            draft: draftForModel(model, form.draft)
          });
        }}
        value={form.draft.providerModelId ?? ""}
      >
        <option value="">Select a Search-capable model</option>
        {options.map((model) => (
          <option disabled={!model.enabled} key={model.id} value={model.id}>
            {model.connectionDisplayName} · {model.displayName}
          </option>
        ))}
      </select>
      <span className={helpText}>
        {creating && options.length === 0
          ? "No model is available for a manual source. Manual sources use a Perplexity model on OpenRouter; turn one on first."
          : "The connection and model this source searches with."}
      </span>
    </label>
  );
}

function SourceFields({
  disabled,
  form,
  mode,
  providerModels,
  setForm
}: Readonly<{
  disabled: boolean;
  form: SearchSourceForm;
  mode: SheetMode;
  providerModels: readonly AdminSearchProviderModelOption[];
  setForm(value: SearchSourceForm): void;
}>) {
  const creating = mode.kind === "create";
  const options = creating ? providerModels : configurableModels(mode.source, providerModels);
  const selectedModel = providerModels.find((model) => model.id === form.draft.providerModelId);
  const selectedModelTimeoutSeconds = selectedModel?.responseTimeoutSeconds ?? 300;
  const validation = searchExecutionValidation(form);
  const ids = useId();
  const outputHelpId = `${ids}-output-help`;
  const outputErrorId = `${ids}-output-error`;
  const requestsHelpId = `${ids}-requests-help`;
  const requestsErrorId = `${ids}-requests-error`;
  const updateDraft = (patch: Partial<AdminSearchDraft>) => setForm({ ...form, draft: { ...form.draft, ...patch } });
  const reasoningProtocol = form.draft.protocol === "anthropic_web_search" ||
    form.draft.protocol === "deepseek_responses_web_search" ||
    form.draft.protocol === "openai_responses_web_search";

  return (
    <div className="flex flex-col gap-4">
      {creating ? (
        <ModelField
          creating
          disabled={disabled}
          form={form}
          options={options}
          providerModels={providerModels}
          setForm={setForm}
        />
      ) : null}
      <label className="block min-w-0">
        <span className={fieldLabel}>Name</span>
        <input
          className={inputClass}
          disabled={disabled}
          maxLength={160}
          onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })}
          required
          value={form.displayName}
        />
      </label>
      <label className="block min-w-0">
        <span className={fieldLabel}>Purpose</span>
        <textarea
          className={`${inputClass} min-h-20 py-2`}
          disabled={disabled}
          maxLength={500}
          onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
          value={form.description}
        />
        <span className={helpText}>Shown to people when they choose sources.</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block min-w-0">
          <span className={fieldLabel}>Results per search</span>
          <input
            className={inputClass}
            disabled={disabled}
            max={20}
            min={1}
            onChange={(event) => updateDraft({ maxResults: Number(event.currentTarget.value) })}
            type="number"
            value={form.draft.maxResults}
          />
        </label>
        <label className="block min-w-0">
          <span className={fieldLabel}>Search text limit</span>
          <input
            className={inputClass}
            disabled={disabled}
            max={1000}
            min={32}
            onChange={(event) => updateDraft({ queryMaxCharacters: Number(event.currentTarget.value) })}
            type="number"
            value={form.draft.queryMaxCharacters}
          />
        </label>
        <label className="block min-w-0">
          <span className={fieldLabel}>Search timeout, seconds</span>
          <input
            className={inputClass}
            disabled={disabled}
            max={900}
            min={5}
            onChange={(event) => updateDraft({ timeoutMs: Number(event.currentTarget.value) * 1_000 })}
            step={5}
            type="number"
            value={form.draft.timeoutMs / 1_000}
          />
        </label>
      </div>
      <p className="text-xs leading-5 text-ink-muted">
        Search budget: {form.draft.timeoutMs / 1_000} seconds.
        {selectedModel
          ? ` The selected model allows ${selectedModelTimeoutSeconds} seconds per answer; the earlier limit wins, so the effective limit is ${Math.min(form.draft.timeoutMs / 1_000, selectedModelTimeoutSeconds)} seconds.`
          : " Maximum 15 minutes."}
      </p>
      {form.draft.adapterKind === "provider_model_client" ? (
        <details className="group rounded-[10px] border border-trace-subtle bg-control-surface/45 px-3">
          <summary className={`flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 py-2.5 text-left ${focusRing}`}>
            <span>
              <span className="block text-xs font-semibold text-ink">Advanced Search execution</span>
              <span className="mt-0.5 block text-xs text-ink-muted">How this source gathers sources before the answer.</span>
            </span>
            <UiV2Icon className="size-3.5 shrink-0 text-ink-muted transition-transform group-open:rotate-90" name="chevron-right" />
          </summary>
          <div className="flex flex-col gap-4 border-t border-trace-subtle py-4">
            {!creating ? (
              <ModelField
                creating={false}
                disabled={disabled}
                form={form}
                options={options}
                providerModels={providerModels}
                setForm={setForm}
              />
            ) : null}
            <label className="block min-w-0">
              <span className={fieldLabel}>Maximum Search output, tokens</span>
              <input
                aria-describedby={`${outputHelpId}${validation.maxOutputTokens ? ` ${outputErrorId}` : ""}`}
                aria-invalid={validation.maxOutputTokens ? true : undefined}
                className={inputClass}
                disabled={disabled}
                max={adminSearchExecutionLimits.maxOutputTokens.maximum}
                min={adminSearchExecutionLimits.maxOutputTokens.minimum}
                onChange={(event) => setForm({
                  ...form,
                  draft: { ...form.draft, maxOutputTokens: Number(event.currentTarget.value) },
                  executionInputs: { ...form.executionInputs, maxOutputTokens: event.currentTarget.value }
                })}
                step={1_024}
                type="number"
                value={form.executionInputs.maxOutputTokens}
              />
              <span className={helpText} id={outputHelpId}>Limits the Search reply before it reaches the answer model.</span>
              {validation.maxOutputTokens ? (
                <span className="mt-1 block text-xs text-critical" id={outputErrorId}>{validation.maxOutputTokens}</span>
              ) : null}
            </label>
            {reasoningProtocol && selectedModel?.searchReasoningSupported ? (
              <label className="block min-w-0">
                <span className={fieldLabel}>Search reasoning</span>
                <select
                  className={inputClass}
                  disabled={disabled}
                  onChange={(event) => updateDraft({
                    reasoningPolicy: event.currentTarget.value as AdminSearchDraft["reasoningPolicy"]
                  })}
                  value={form.draft.reasoningPolicy}
                >
                  <option value="lowest_supported">Use the lowest supported effort</option>
                  <option value="provider_default">Use the Search service default</option>
                </select>
                <span className={helpText}>Lower effort keeps the Search step focused; the service default leaves the choice to the Search model.</span>
              </label>
            ) : reasoningProtocol && selectedModel ? (
              <p className="border-l-2 border-trace-strong pl-3 text-xs leading-5 text-ink-muted">
                Search reasoning is not configurable for this model. AIQSA uses the service default.
              </p>
            ) : null}
            <label className="block min-w-0">
              <span className={fieldLabel}>Maximum requests to this source per answer</span>
              <input
                aria-describedby={`${requestsHelpId}${validation.maxSearchCallsPerAnswer ? ` ${requestsErrorId}` : ""}`}
                aria-invalid={validation.maxSearchCallsPerAnswer ? true : undefined}
                className={inputClass}
                disabled={disabled}
                max={adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum}
                min={adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum}
                onChange={(event) => setForm({
                  ...form,
                  draft: { ...form.draft, maxSearchCallsPerAnswer: Number(event.currentTarget.value) },
                  executionInputs: { ...form.executionInputs, maxSearchCallsPerAnswer: event.currentTarget.value }
                })}
                type="number"
                value={form.executionInputs.maxSearchCallsPerAnswer}
              />
              <span className={helpText} id={requestsHelpId}>
                Each generated query sent here uses one request. A round that searches several selected sources uses one request from each.
              </span>
              {validation.maxSearchCallsPerAnswer ? (
                <span className="mt-1 block text-xs text-critical" id={requestsErrorId}>{validation.maxSearchCallsPerAnswer}</span>
              ) : null}
            </label>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SheetBody({
  catalog,
  controller,
  mode,
  onClose,
  onSaved
}: Readonly<{
  catalog: AdminSearchCatalog;
  controller: AdminSearchController;
  mode: SheetMode;
  onClose(): void;
  onSaved(sourceId: string | null): void;
}>) {
  const [form, setForm] = useState<SearchSourceForm>(() =>
    mode.kind === "configure" ? searchFormFrom(mode.source) : emptySearchForm());
  const [baseline] = useState(form);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const formId = useId();
  const errorId = useId();
  const busy = controller.state.busy;
  const creating = mode.kind === "create";
  const providerModels = creating ? manuallyAddableModels(catalog) : catalog.providerModels;
  const dirty = !searchFormsEqual(form, baseline);
  const canSave = !busy && dirty && form.displayName.trim() !== "" &&
    form.draft.providerModelId !== null && searchExecutionValidation(form).valid;

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    if (!canSave) return;
    setError(null);
    const input = {
      description: form.description.trim(),
      displayName: form.displayName.trim(),
      draft: form.draft
    };
    const result = mode.kind === "configure"
      ? await controller.actions.saveAndCheck({
          ...input,
          expectedDraftVersion: mode.source.draftVersion,
          id: mode.source.id
        })
      : await controller.actions.create(input);
    if (result.ok) {
      onSaved(result.selectedIntegrationId ?? null);
      return;
    }
    setError(result.message);
  };

  return (
    <AdminSheet
      closeBlocked={busy}
      description={creating
        ? "Users see one source; AIQSA applies it to every compatible chat model."
        : `${mode.source.displayName} · changes apply to new chats once the check passes.`}
      footer={(
        <>
          <UiV2Button busy={busy} disabled={!canSave} form={formId} tone="primary" type="submit">
            Save
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          <span className="min-w-0 text-xs leading-5 text-ink-muted">
            Runs one small check first (paid request). If it fails, nothing changes.
          </span>
        </>
      )}
      onClose={requestClose}
      open
      testId={creating ? "search-source-add" : "search-source-configure"}
      title={creating ? "Add source" : "Configure source"}
      width="wide"
    >
      <form
        aria-describedby={error ? errorId : undefined}
        className="flex flex-col gap-4"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SourceFields
          disabled={busy}
          form={form}
          mode={mode}
          providerModels={providerModels}
          setForm={(next) => {
            setForm(next);
            setError(null);
          }}
        />
        {error ? (
          <p className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel={creating ? "Discard the new source" : "Discard unsaved source settings"}
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="search-source-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          {creating ? "The source has not been added yet." : "Edits to this source will be lost."}
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/**
 * The source sheet (PRD 5.6, B7): the current form fields behind one `Save`
 * that saves the configuration and runs the live check as a single server
 * operation. A failed check keeps the previous configuration in use and shows
 * the reason here with the fields preserved. The same sheet adds a manual
 * source; there the check runs before anything is created.
 */
export function AdminSearchSourceSheet({
  catalog,
  controller,
  mode,
  onClose,
  onSaved,
  open
}: Readonly<{
  catalog: AdminSearchCatalog;
  controller: AdminSearchController;
  mode: SheetMode;
  onClose(): void;
  onSaved(sourceId: string | null): void;
  open: boolean;
}>) {
  if (!open) return null;
  return (
    <SheetBody catalog={catalog} controller={controller} mode={mode} onClose={onClose} onSaved={onSaved} />
  );
}

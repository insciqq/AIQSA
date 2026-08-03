"use client";

import {
  adminSearchErrorMessage,
  createAdminSearchIntegration,
  requestAdminSearchCatalog,
  runAdminSearchAction,
  updateAdminSearchIntegration,
  updateAdminSearchPolicy
} from "@/components/admin/adminSearchApi";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import {
  AdminAvailabilityStatus,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  enableButton,
  focusRing,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type {
  AdminSearchCatalog,
  AdminSearchDraft,
  AdminSearchIntegration,
  AdminSearchKind,
  AdminSearchProviderModelOption
} from "@/lib/contracts/adminSearch";
import { isSearchCombinationCompatible } from "@/lib/domain/catalogMatrix";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  Gauge,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  TestTube2,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type SearchTask = "configuration" | "diagnostics" | "overview";
type EditorMode = "create" | "detail" | "index";

type SearchForm = {
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
};

const tasks: ReadonlyArray<Readonly<{
  Icon: typeof Gauge;
  id: SearchTask;
  label: string;
}>> = [
  { Icon: Gauge, id: "overview", label: "Overview" },
  { Icon: FilePenLine, id: "configuration", label: "Configuration" },
  { Icon: Activity, id: "diagnostics", label: "Diagnostics" }
];

const fieldLabel = "text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-[11px] leading-4 text-ink-muted";

function planKind(integration: AdminSearchIntegration) {
  return integration.kind === "perplexity_search"
    ? "perplexity_tool_search" as const
    : integration.kind;
}

function planCompatible(
  optionIds: readonly string[],
  options: ReadonlyArray<{
    executionModes: SearchPlanMode[];
    kind: ReturnType<typeof planKind>;
    strategyId: string;
  }>,
  mode: SearchPlanMode
): boolean {
  return (mode !== "all_selected" || optionIds.every((optionId) =>
    options.find((option) => option.strategyId === optionId)
      ?.executionModes.includes("all_selected"))) &&
    isSearchCombinationCompatible(optionIds, options, mode);
}

function SearchDefaultPolicyEditor({
  busy,
  catalog,
  onSave
}: Readonly<{
  busy: boolean;
  catalog: AdminSearchCatalog;
  onSave(plan: SearchPlan): void;
}>) {
  const [optionIds, setOptionIds] = useState<string[]>([...catalog.policy.defaultPlan.optionIds]);
  const [planMode, setPlanMode] = useState<SearchPlanMode>(catalog.policy.defaultPlan.mode);
  const selectable = catalog.integrations.filter((integration) =>
    integration.enabled && integration.ready && !integration.archivedAt);
  const options = selectable.map((integration) => ({
    executionModes: integration.executionModes,
    kind: planKind(integration),
    strategyId: integration.strategyId
  }));
  const missing = optionIds.filter((optionId) =>
    !selectable.some((integration) => integration.strategyId === optionId));

  function toggle(optionId: string) {
    const active = optionIds.includes(optionId);
    const next = active
      ? optionIds.filter((candidate) => candidate !== optionId)
      : [...optionIds, optionId];
    if (!active && (next.length > 3 ||
      !planCompatible(next, options, "model_choice"))) {
      return;
    }
    const nextMode = next.length === 0
      ? "all_selected"
      : planCompatible(next, options, planMode)
        ? planMode
        : "model_choice";
    setOptionIds(next);
    setPlanMode(nextMode);
  }

  const dirty = planMode !== catalog.policy.defaultPlan.mode ||
    optionIds.join("\u0000") !== catalog.policy.defaultPlan.optionIds.join("\u0000");
  const allSelectedAvailable = optionIds.length > 0 &&
    planCompatible(optionIds, options, "all_selected");

  return (
    <section className="border-y border-trace-subtle bg-control-surface/55 px-4 py-4 sm:px-6" aria-labelledby="search-default-heading">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-proof">Default for users</p>
          <h3 className="mt-1 text-sm font-semibold text-ink" id="search-default-heading">Recommended Search plan</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Used until a user makes a personal choice. This recommendation never grants access.</p>
        </div>
        <button className={primaryButton} disabled={busy || !dirty || missing.length > 0} onClick={() => onSave({ mode: planMode, optionIds })} type="button">
          <Save aria-hidden="true" className="size-3.5" />Save default
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {selectable.map((integration) => {
          const active = optionIds.includes(integration.strategyId);
          const disabled = !active && (optionIds.length >= 3 || !planCompatible(
            [...optionIds, integration.strategyId],
            options,
            "model_choice"
          ));
          return (
            <button
              aria-pressed={active}
              className={`inline-flex min-h-control items-center gap-2 rounded-control border px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:opacity-45 ${active ? "border-proof bg-control-selected text-ink" : "border-trace-subtle bg-answer-paper text-ink-secondary hover:bg-control-hover"}`}
              disabled={disabled}
              key={integration.strategyId}
              onClick={() => toggle(integration.strategyId)}
              type="button"
            >
              {active ? <CheckCircle2 aria-hidden="true" className="size-3.5 text-proof" /> : null}
              {integration.displayName}
            </button>
          );
        })}
        {missing.map((optionId) => {
          const integration = catalog.integrations.find((candidate) =>
            candidate.strategyId === optionId);
          const displayName = integration?.displayName ?? "Search source";
          return (
            <button
              aria-label={`Remove unavailable ${displayName}`}
              aria-pressed="true"
              className="inline-flex min-h-control items-center gap-2 rounded-control border border-caution/55 bg-caution/10 px-3 py-2 text-xs text-caution outline-none hover:bg-caution/15 focus-visible:ring-2 focus-visible:ring-caution/55"
              key={optionId}
              onClick={() => toggle(optionId)}
              type="button"
            >
              <CircleAlert aria-hidden="true" className="size-3.5" />
              <span>{displayName} · unavailable</span>
              <X aria-hidden="true" className="size-3.5" />
            </button>
          );
        })}
        {selectable.length === 0 ? <span className="text-xs text-ink-muted">No enabled, ready Search sources.</span> : null}
      </div>
      {optionIds.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-4 border-t border-trace-subtle pt-3 text-xs text-ink-secondary">
          <label className={allSelectedAvailable ? "flex items-center gap-2" : "flex items-center gap-2 opacity-45"}>
            <input checked={planMode === "all_selected"} className="accent-proof" disabled={!allSelectedAvailable} onChange={() => setPlanMode("all_selected")} type="radio" />
            Search all selected sources
          </label>
          <label className="flex items-center gap-2">
            <input checked={planMode === "model_choice" || !allSelectedAvailable} className="accent-proof" onChange={() => setPlanMode("model_choice")} type="radio" />
            Let the model choose
          </label>
        </div>
      ) : null}
      {missing.length > 0 ? <p className="mt-3 text-xs text-caution">The saved recommendation includes an unavailable source. Remove it or make it ready before saving.</p> : null}
    </section>
  );
}

function draftForModel(
  model: AdminSearchProviderModelOption,
  current?: Pick<AdminSearchDraft, "maxResults" | "queryMaxCharacters" | "timeoutMs">
): AdminSearchDraft {
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxResults: current?.maxResults ?? 8,
    protocol: model.searchKind === "perplexity_search"
      ? "openrouter_perplexity_chat"
      : "openai_responses_web_search",
    providerModelId: model.id,
    queryMaxCharacters: current?.queryMaxCharacters ?? 500,
    timeoutMs: current?.timeoutMs ?? 300_000
  };
}

function emptyForm(providerModels: readonly AdminSearchProviderModelOption[]): SearchForm {
  const model = providerModels.find((candidate) => candidate.enabled) ?? null;
  const sourceName = model?.connectionDisplayName.trim() ?? "";
  return {
    description: sourceName ? `Web search through ${sourceName}.` : "Web search for Research Chat.",
    displayName: sourceName ? `${sourceName} Search` : "",
    draft: model
      ? draftForModel(model)
      : {
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          maxResults: 8,
          protocol: "openai_responses_web_search",
          providerModelId: null,
          queryMaxCharacters: 500,
          timeoutMs: 300_000
        }
  };
}

function manuallyAddableModels(catalog: AdminSearchCatalog): AdminSearchProviderModelOption[] {
  return catalog.providerModels.filter((model) =>
    model.enabled && model.searchKind === "perplexity_search" &&
    !catalog.integrations.some((integration) =>
      integration.archivedAt === null && integration.kind === model.searchKind &&
      integration.sourceConnectionId === model.connectionId
    )
  );
}

function formFrom(
  integration: AdminSearchIntegration,
  providerModels: readonly AdminSearchProviderModelOption[]
): SearchForm {
  const fallback = emptyForm(providerModels);
  return {
    description: integration.description,
    displayName: integration.displayName,
    draft: integration.configuration ? { ...integration.configuration } : fallback.draft
  };
}

function readinessLabel(integration: AdminSearchIntegration): string {
  if (integration.readiness === "ready") return "Ready";
  if (integration.readiness === "source_unavailable") return "Source unavailable";
  return "Setup required";
}

function broaderModelLabel(integration: AdminSearchIntegration): string {
  if (integration.broaderModelSetup === "ready") {
    return "Available to compatible answer models";
  }
  if (integration.broaderModelSetup === "setup_required") {
    return integration.ready
      ? "Works now; support for more answer models needs setup"
      : "Support for compatible answer models needs setup";
  }
  return integration.kind === "gemini_google_search"
    ? "Available with matching Gemini models"
    : "Available with compatible answer models";
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

function liveDiagnosticEvidence(integration: AdminSearchIntegration) {
  return integration.draftTestEvidence?.method === "provider_search"
    ? integration.draftTestEvidence
    : null;
}

function testState(integration: AdminSearchIntegration): string {
  if (!integration.configurable) return "Managed with its provider connection";
  const evidence = liveDiagnosticEvidence(integration);
  if (evidence?.status === "available") return "Last live check passed";
  if (evidence?.status === "unavailable") return "Last live check unavailable";
  return "No live check run";
}

function Feedback({ error, notice, onDismiss }: Readonly<{
  error: string | null;
  notice: string | null;
  onDismiss(): void;
}>) {
  if (!error && !notice) return null;
  return (
    <div className="grid gap-2 px-4 pt-4 sm:px-6">
      {error ? (
        <div className="flex items-start justify-between gap-3 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs leading-5 text-critical" role="alert">
          <span>{error}</span>
          <button className={quietButton} onClick={onDismiss} type="button">Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex items-start justify-between gap-3 border-l-2 border-positive bg-positive/10 px-3 py-2 text-xs leading-5 text-positive" role="status">
          <span>{notice}</span>
          <button className={quietButton} onClick={onDismiss} type="button">Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ children, label }: Readonly<{ children: ReactNode; label: string }>) {
  return (
    <div className="min-w-0 border-l-2 border-trace-strong pl-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function SearchCatalogIndex({
  busy,
  integrations,
  canCreate,
  onCreate,
  onRefresh,
  onSelect,
  selectedId
}: Readonly<{
  busy: boolean;
  canCreate: boolean;
  integrations: readonly AdminSearchIntegration[];
  onCreate(): void;
  onRefresh(): void;
  onSelect(id: string): void;
  selectedId: string | null;
}>) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? integrations.filter((integration) =>
          [integration.displayName, integration.description]
            .some((value) => value.toLowerCase().includes(needle)))
      : integrations;
  }, [integrations, query]);

  return (
    <div className="min-w-0">
      <div className="grid gap-3 border-b border-trace-subtle p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Search sources</p>
            <p className="mt-1 text-xs text-ink-secondary">{integrations.length} source{integrations.length === 1 ? "" : "s"}</p>
          </div>
          <div className="flex gap-1">
            <button aria-label="Refresh Search sources" className={quietButton} disabled={busy} onClick={onRefresh} type="button">
              <RefreshCw aria-hidden="true" className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
            </button>
            {canCreate ? (
              <button className={primaryButton} disabled={busy} onClick={onCreate} type="button">
                <Plus aria-hidden="true" className="size-3.5" />Add source
              </button>
            ) : null}
          </div>
        </div>
        <label className="relative block">
          <span className="sr-only">Search sources</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input className={`${inputClass} pl-9`} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a source" type="search" value={query} />
        </label>
      </div>
      <div className="max-h-[44rem] overflow-y-auto p-2">
        {visible.length ? (
          <div aria-label="Search source catalog" className="grid gap-1" role="list">
            {visible.map((integration) => (
              <div key={integration.id} role="listitem">
                <button
                  aria-current={selectedId === integration.id ? "true" : undefined}
                  className={`flex min-h-touch w-full min-w-0 items-center gap-2 border-l-2 px-3 py-2 text-left ${focusRing} ${integration.enabled ? "border-positive" : "border-trace-strong"} ${selectedId === integration.id ? "bg-answer-paper ring-1 ring-inset ring-proof/40" : "hover:bg-control-hover"}`}
                  onClick={() => onSelect(integration.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-medium text-ink">{integration.displayName}</span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] text-ink-muted">{integration.description}</span>
                    <span className={`mt-1 inline-flex items-center gap-1 text-[10px] ${integration.ready ? "text-positive" : "text-caution"}`}>
                      {integration.ready ? <CheckCircle2 aria-hidden="true" className="size-3" /> : <CircleAlert aria-hidden="true" className="size-3" />}
                      {readinessLabel(integration)}
                    </span>
                  </span>
                  <AdminAvailabilityStatus enabled={integration.enabled} />
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-3 py-10 text-center text-xs text-ink-muted">No matching Search sources.</p>
        )}
      </div>
    </div>
  );
}

function SearchFormFields({
  disabled,
  form,
  kind,
  providerModels,
  setForm,
  sourceConnectionId
}: Readonly<{
  disabled: boolean;
  form: SearchForm;
  kind?: AdminSearchKind;
  providerModels: readonly AdminSearchProviderModelOption[];
  setForm(value: SearchForm): void;
  sourceConnectionId?: string;
}>) {
  const options = providerModels.filter((model) =>
    (!sourceConnectionId || model.connectionId === sourceConnectionId) &&
    (!kind || kind === model.searchKind));
  const updateDraft = (patch: Partial<AdminSearchDraft>) => setForm({
    ...form,
    draft: { ...form.draft, ...patch }
  });
  return (
    <div className="grid gap-4">
      <label className="min-w-0">
        <span className={fieldLabel}>Name</span>
        <input className={`${inputClass} mt-1.5`} disabled={disabled} maxLength={160} onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })} value={form.displayName} />
      </label>
      <label className="min-w-0">
        <span className={fieldLabel}>Purpose</span>
        <textarea className={`${inputClass} mt-1.5 min-h-24 py-2`} disabled={disabled} maxLength={500} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} value={form.description} />
      </label>
      <label className="min-w-0">
        <span className={fieldLabel}>Search provider and model</span>
        <select
          className={`${inputClass} mt-1.5`}
          disabled={disabled}
          onChange={(event) => {
            const model = providerModels.find((candidate) => candidate.id === event.currentTarget.value);
            if (model) setForm({ ...form, draft: draftForModel(model, form.draft) });
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
        <span className={helpText}>The source uses the selected connection&apos;s saved server-side access.</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <label>
          <span className={fieldLabel}>Results per search</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={20} min={1} onChange={(event) => updateDraft({ maxResults: Number(event.currentTarget.value) })} type="number" value={form.draft.maxResults} />
        </label>
        <label>
          <span className={fieldLabel}>Search text limit</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={1000} min={32} onChange={(event) => updateDraft({ queryMaxCharacters: Number(event.currentTarget.value) })} type="number" value={form.draft.queryMaxCharacters} />
        </label>
        <label>
          <span className={fieldLabel}>Search timeout, seconds</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={900} min={5} onChange={(event) => updateDraft({ timeoutMs: Number(event.currentTarget.value) * 1_000 })} step={5} type="number" value={form.draft.timeoutMs / 1_000} />
          <span className={helpText}>Maximum 15 minutes.</span>
        </label>
      </div>
    </div>
  );
}

function TaskTabs({ onSelect, selected }: Readonly<{
  onSelect(task: SearchTask): void;
  selected: SearchTask;
}>) {
  return (
    <div aria-label="Search source tasks" className="flex min-w-0 gap-6 overflow-x-auto border-b border-trace-subtle px-4 sm:px-6" role="tablist">
      {tasks.map(({ Icon, id, label }) => (
        <button
          aria-selected={selected === id}
          className={`-mb-px inline-flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 text-xs font-medium ${focusRing} ${selected === id ? "border-proof text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}
          key={id}
          onClick={() => onSelect(id)}
          role="tab"
          type="button"
        >
          <Icon aria-hidden="true" className="size-3.5" />{label}
        </button>
      ))}
    </div>
  );
}

function DetailTask({
  busy,
  catalog,
  form,
  integration,
  onAction,
  onSave,
  setForm,
  task
}: Readonly<{
  busy: boolean;
  catalog: AdminSearchCatalog;
  form: SearchForm;
  integration: AdminSearchIntegration;
  onAction(action: "archive" | "disable" | "enable" | "test"): void;
  onSave(): void;
  setForm(value: SearchForm): void;
  task: SearchTask;
}>) {
  if (task === "configuration") {
    return (
      <section className="grid gap-5 p-4 sm:p-6" aria-label="Search configuration">
        <div>
          <h4 className="text-sm font-semibold text-ink">Source configuration</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Saved changes take effect immediately for new runs.</p>
        </div>
        {integration.configurable ? (
          <>
            <SearchFormFields
              disabled={busy}
              form={form}
              kind={integration.kind}
              providerModels={catalog.providerModels}
              setForm={setForm}
              sourceConnectionId={integration.sourceConnectionId}
            />
            <div><button className={primaryButton} disabled={busy} onClick={onSave} type="button"><Save aria-hidden="true" className="size-3.5" />Save changes</button></div>
          </>
        ) : (
          <p className="border-l-2 border-trace-strong pl-3 text-sm leading-6 text-ink-secondary">This built-in source is managed with its provider connection.</p>
        )}
      </section>
    );
  }
  if (task === "diagnostics") {
    const evidence = liveDiagnosticEvidence(integration);
    return (
      <section className="grid gap-5 p-4 sm:p-6" aria-label="Search diagnostics">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-ink">Connection check</h4>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Optional live check. It sends a small fixed request and stores only status and a source count; its result does not change source availability.</p>
          </div>
          {integration.configurable ? <button className={primaryButton} disabled={busy} onClick={() => onAction("test")} type="button"><TestTube2 aria-hidden="true" className="size-3.5" />Run live check</button> : null}
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="State">{testState(integration)}</Fact>
          <Fact label="Checked">{evidence ? new Date(evidence.checkedAt).toLocaleString() : "Never"}</Fact>
          <Fact label="Result">{evidence?.status === "available" ? "Available" : evidence ? "Unavailable" : "—"}</Fact>
          <Fact label="Sources found">{evidence?.normalizedSourceCount ?? "—"}</Fact>
        </dl>
      </section>
    );
  }
  return (
    <section className="grid gap-6 p-4 sm:p-6" aria-label="Search overview">
      <div className="border-l-2 border-proof bg-proof/[0.05] px-4 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-proof">One Search source</p>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-ink">
          <span className="rounded-control bg-control-surface px-2.5 py-1.5">{integration.displayName}</span>
          <ArrowRight aria-hidden="true" className="size-4 text-ink-muted" />
          <span className="rounded-control bg-control-surface px-2.5 py-1.5">Compatible answer models</span>
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-ink-muted">Users choose this source once. AIQSA selects its supported execution automatically for each answer model.</p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Fact label="Availability"><AdminAvailabilityStatus enabled={integration.enabled} /></Fact>
        <Fact label="Readiness">{readinessLabel(integration)}</Fact>
        <Fact label="Answer model reach">{broaderModelLabel(integration)}</Fact>
        <Fact label="Configuration">{integration.configurationActive ? "Active" : "Needs attention"}</Fact>
        <Fact label="Connection">{integration.providerModel ? `${integration.providerModel.connectionDisplayName} · ${integration.providerModel.displayName}` : "Managed by its provider"}</Fact>
        <Fact label="Search timeout">{integration.configuration ? durationLabel(integration.configuration.timeoutMs) : "Provider managed"}</Fact>
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
        <button className={integration.enabled ? quietButton : enableButton} disabled={busy || (!integration.enabled && !integration.ready)} onClick={() => onAction(integration.enabled ? "disable" : "enable")} type="button">
          {integration.enabled ? "Disable" : "Enable"}
        </button>
        {!integration.system ? <button className={dangerButton} disabled={busy} onClick={() => onAction("archive")} type="button"><Trash2 aria-hidden="true" className="size-3.5" />Archive</button> : null}
      </div>
    </section>
  );
}

export function AdminSearchSection({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminSearchCatalog | null>(null);
  const [busy, setBusy] = useState(active);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("index");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<SearchTask>("overview");
  const [form, setForm] = useState<SearchForm>(() => emptyForm([]));
  const [archiveCandidate, setArchiveCandidate] = useState<AdminSearchIntegration | null>(null);
  const selected = catalog?.integrations.find((integration) => integration.id === selectedId) ?? null;

  const load = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    const result = await requestAdminSearchCatalog();
    setBusy(false);
    if (!result.ok) {
      setError(adminSearchErrorMessage(result.error));
      return;
    }
    setCatalog(result.search);
    setSelectedId((current) => current && result.search.integrations.some((item) => item.id === current)
      ? current
      : result.search.integrations[0]?.id ?? null);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void requestAdminSearchCatalog().then((result) => {
      if (cancelled) return;
      setBusy(false);
      if (!result.ok) {
        setError(adminSearchErrorMessage(result.error));
        return;
      }
      setCatalog(result.search);
      setSelectedId(result.search.integrations[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function commit(
    operation: Promise<Awaited<ReturnType<typeof requestAdminSearchCatalog>>>,
    success: string,
    after?: (
      next: AdminSearchCatalog,
      previous: AdminSearchCatalog | null,
      selectedIntegrationId?: string
    ) => void
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const previous = catalog;
    const result = await operation;
    setBusy(false);
    if (!result.ok) {
      setError(adminSearchErrorMessage(result.error));
      return;
    }
    setCatalog(result.search);
    after?.(result.search, previous, result.selectedIntegrationId);
    setNotice(success);
    void onMutationCommitted?.();
  }

  function openCreate() {
    if (!catalog) return;
    setForm(emptyForm(manuallyAddableModels(catalog)));
    setMode("create");
    setTask("configuration");
  }

  function openIntegration(id: string) {
    const integration = catalog?.integrations.find((candidate) => candidate.id === id);
    if (!integration || !catalog) return;
    setSelectedId(id);
    setForm(formFrom(integration, catalog.providerModels));
    setTask("overview");
    setMode("detail");
  }

  function performAction(
    action: "archive" | "disable" | "enable" | "test",
    target: AdminSearchIntegration
  ) {
    const success = action === "test"
      ? "Live Search check completed."
      : action === "enable"
          ? "Search source enabled."
          : action === "disable"
            ? "Search source disabled."
            : "Search source archived.";
    void commit(
      runAdminSearchAction({ action, confirmed: action === "archive" || undefined, id: target.id }),
      success,
      (next) => {
        const updated = next.integrations.find((item) => item.id === target.id);
        if (updated) setForm(formFrom(updated, next.providerModels));
        else {
          setMode("index");
          setSelectedId(next.integrations[0]?.id ?? null);
        }
      }
    );
  }

  function runAction(action: "archive" | "disable" | "enable" | "test") {
    if (!selected || !catalog) return;
    if (action === "archive") {
      setArchiveCandidate(selected);
      return;
    }
    performAction(action, selected);
  }

  if (!catalog && busy) {
    return <div className="flex min-h-[28rem] items-center justify-center gap-2 text-sm text-ink-muted"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading Search sources</div>;
  }

  const search = catalog ?? {
    integrations: [],
    policy: {
      defaultPlan: { mode: "all_selected", optionIds: [] },
      updatedAt: new Date(0).toISOString(),
      version: 1
    },
    providerModels: []
  };
  const addableModels = manuallyAddableModels(search);
  return (
    <div className="min-w-0" data-testid="admin-search-section">
      <div
        aria-hidden={archiveCandidate ? true : undefined}
        inert={archiveCandidate ? true : undefined}
      >
        <Feedback error={error} notice={notice} onDismiss={() => { setError(null); setNotice(null); }} />
        <SearchDefaultPolicyEditor
          busy={busy}
          catalog={search}
          key={search.policy.version}
          onSave={(defaultPlan) => void commit(
            updateAdminSearchPolicy({ defaultPlan, expectedVersion: search.policy.version }),
            "Organization Search default saved."
          )}
        />
        <AdminTaskWorkspace className="mt-2" indexWidth="20rem">
        <AdminTaskIndexPane compactDetailOpen={mode !== "index"} testId="admin-search-index-pane">
          <SearchCatalogIndex busy={busy} canCreate={addableModels.length > 0} integrations={search.integrations} onCreate={openCreate} onRefresh={() => void load()} onSelect={openIntegration} selectedId={selectedId} />
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen={mode !== "index"} testId="admin-search-detail-pane">
          {mode === "create" ? (
            <section className="grid gap-5 p-4 sm:p-6">
              <AdminTaskBackButton label="Back to Search" onClick={() => setMode("index")} />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">New Search source</p>
                <h3 className="mt-1 text-lg font-semibold text-ink">Add Search source</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">Choose a configured provider model that can search the web. Users will see one source, and AIQSA will apply it automatically to compatible answer models.</p>
              </div>
              <SearchFormFields disabled={busy} form={form} providerModels={addableModels} setForm={setForm} />
              <div className="flex gap-2">
                <button
                  className={primaryButton}
                  disabled={busy || !form.displayName.trim() || !form.draft.providerModelId}
                  onClick={() => void commit(
                    createAdminSearchIntegration(form),
                    "Search source added and ready.",
                    (next, previous, selectedIntegrationId) => {
                      const previousIds = new Set(previous?.integrations.map((item) => item.id) ?? []);
                      const created = next.integrations.find((item) =>
                        item.id === selectedIntegrationId) ??
                        next.integrations.find((item) => !previousIds.has(item.id));
                      if (created) {
                        setSelectedId(created.id);
                        setForm(formFrom(created, next.providerModels));
                        setMode("detail");
                        setTask("overview");
                      }
                    }
                  )}
                  type="button"
                >
                  <Plus aria-hidden="true" className="size-3.5" />Add source
                </button>
                <button className={quietButton} disabled={busy} onClick={() => setMode("index")} type="button">Cancel</button>
              </div>
            </section>
          ) : selected ? (
            <div className="min-w-0">
              <div className="flex flex-col gap-3 border-b border-trace-subtle px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <AdminTaskBackButton label="Back to Search" onClick={() => setMode("index")} />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Search source</p>
                  <h3 className="mt-1 break-words text-lg font-semibold text-ink">{selected.displayName}</h3>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">{selected.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2"><AdminAvailabilityStatus enabled={selected.enabled} /><span className={selected.ready ? "text-xs text-positive" : "text-xs text-caution"}>{readinessLabel(selected)}</span></div>
              </div>
              <TaskTabs onSelect={setTask} selected={task} />
              <DetailTask
                busy={busy}
                catalog={search}
                form={form}
                integration={selected}
                onAction={runAction}
                onSave={() => void commit(
                  updateAdminSearchIntegration({
                    ...form,
                    expectedDraftVersion: selected.draftVersion,
                    id: selected.id
                  }),
                  "Search configuration saved.",
                  (next) => {
                    const updated = next.integrations.find((item) => item.id === selected.id);
                    if (updated) setForm(formFrom(updated, next.providerModels));
                  }
                )}
                setForm={setForm}
                task={task}
              />
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-ink-muted">Select or add a Search source.</div>
          )}
        </AdminTaskDetailPane>
        </AdminTaskWorkspace>
      </div>
      {archiveCandidate ? (
        <ConfirmationDialog
          confirmLabel="Archive source"
          dialogLabel={`Archive Search source ${archiveCandidate.displayName}`}
          onCancel={() => setArchiveCandidate(null)}
          onConfirm={() => {
            const target = archiveCandidate;
            setArchiveCandidate(null);
            performAction("archive", target);
          }}
          testId="admin-search-archive-confirmation"
          title="Archive Search source?"
        >
          {`${archiveCandidate.displayName} will be unavailable for future runs. Existing run history remains available.`}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}

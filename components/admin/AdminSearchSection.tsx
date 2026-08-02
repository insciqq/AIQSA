"use client";

import {
  adminSearchErrorMessage,
  createAdminSearchIntegration,
  requestAdminSearchCatalog,
  runAdminSearchAction,
  updateAdminSearchIntegration,
  updateAdminSearchPolicy
} from "@/components/admin/adminSearchApi";
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
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  TestTube2,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type SearchTask = "compatibility" | "configuration" | "credentials" | "diagnostics" | "overview";
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
  { Icon: KeyRound, id: "credentials", label: "Credentials" },
  { Icon: ShieldCheck, id: "compatibility", label: "Compatibility" },
  { Icon: Activity, id: "diagnostics", label: "Diagnostics" }
];

const fieldLabel = "text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-[11px] leading-4 text-ink-muted";

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
    adapterKind: integration.adapterKind,
    executionModes: integration.executionModes,
    kind: integration.adapterKind === "none" as const
      ? "none" as const
      : "provider_model_web_search" as const,
    protocol: integration.draft.protocol,
    strategyId: integration.strategyId
  }));
  const missing = optionIds.filter((optionId) =>
    !selectable.some((integration) => integration.strategyId === optionId));

  function toggle(optionId: string) {
    const active = optionIds.includes(optionId);
    const next = active
      ? optionIds.filter((candidate) => candidate !== optionId)
      : [...optionIds, optionId];
    if (!active && (next.length > 3 || !isSearchCombinationCompatible(next, options, "model_choice"))) {
      return;
    }
    const nextMode = next.length === 0
      ? "all_selected"
      : isSearchCombinationCompatible(next, options, planMode)
        ? planMode
        : "model_choice";
    setOptionIds(next);
    setPlanMode(nextMode);
  }

  const dirty = planMode !== catalog.policy.defaultPlan.mode ||
    optionIds.join("\u0000") !== catalog.policy.defaultPlan.optionIds.join("\u0000");
  const allSelectedAvailable = optionIds.length > 0 &&
    isSearchCombinationCompatible(optionIds, options, "all_selected");

  return (
    <section className="border-y border-trace-subtle bg-control-surface/55 px-4 py-4 sm:px-6" aria-labelledby="search-default-heading">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-proof">Default for users</p>
          <h3 className="mt-1 text-sm font-semibold text-ink" id="search-default-heading">Recommended Search plan</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Used only until a user makes a personal choice. Recommendation only; it never grants Search access.</p>
        </div>
        <button
          className={primaryButton}
          disabled={busy || !dirty || missing.length > 0}
          onClick={() => onSave({ mode: planMode, optionIds })}
          type="button"
        >
          <Save aria-hidden="true" className="size-3.5" />Save default
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {selectable.map((integration) => {
          const active = optionIds.includes(integration.strategyId);
          const disabled = !active && (optionIds.length >= 3 || !isSearchCombinationCompatible(
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
          const displayName = integration?.displayName ?? optionId;
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
        {selectable.length === 0 ? <span className="text-xs text-ink-muted">No active, ready Search integrations.</span> : null}
      </div>

      {optionIds.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-4 border-t border-trace-subtle pt-3 text-xs text-ink-secondary">
          <label className={allSelectedAvailable ? "flex items-center gap-2" : "flex items-center gap-2 opacity-45"}>
            <input checked={planMode === "all_selected"} className="accent-proof" disabled={!allSelectedAvailable} onChange={() => setPlanMode("all_selected")} type="radio" />
            All selected
          </label>
          <label className="flex items-center gap-2">
            <input checked={planMode === "model_choice" || !allSelectedAvailable} className="accent-proof" onChange={() => setPlanMode("model_choice")} type="radio" />
            Model chooses
          </label>
        </div>
      ) : null}
      {missing.length > 0 ? <p className="mt-3 text-xs text-caution">The saved recommendation references an unavailable integration. Remove it above or reactivate it before saving.</p> : null}
    </section>
  );
}

function emptyForm(providerModels: readonly AdminSearchProviderModelOption[]): SearchForm {
  const providerModel = providerModels.find((model) =>
    model.enabled && model.nativeSearch && model.adapterKind === "openai_responses_native"
  ) ?? providerModels.find((model) => model.enabled && model.nativeSearch) ?? null;
  const openAIResponses = providerModel?.adapterKind === "openai_responses_native" ||
    providerModel?.adapterKind === "openai_responses_compatible";
  return {
    description: openAIResponses
      ? "Query-only OpenAI web search for any tool-capable answer model."
      : "Query-only web evidence for Research Chat.",
    displayName: openAIResponses ? "OpenAI Search (provider-neutral)" : "",
    draft: {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxResults: 8,
      protocol: providerModel?.adapterKind === "openrouter_chat_completions"
        ? "openrouter_perplexity_chat"
        : "openai_responses_web_search",
      providerModelId: providerModel?.id ?? null,
      queryMaxCharacters: 500,
      timeoutMs: 300_000
    }
  };
}

function formFrom(integration: AdminSearchIntegration): SearchForm {
  return {
    description: integration.description,
    displayName: integration.displayName,
    draft: { ...integration.draft }
  };
}

function protocolLabel(protocol: AdminSearchDraft["protocol"]): string {
  if (protocol === "gemini_google_search") return "Gemini Google Search";
  if (protocol === "openrouter_perplexity_chat") return "OpenRouter / Perplexity chat search";
  return "OpenAI Responses web search";
}

function adapterLabel(integration: AdminSearchIntegration): string {
  return integration.adapterKind === "answer_provider_hosted"
    ? "Inside answer provider request"
    : "Query-only provider model";
}

function readinessLabel(integration: AdminSearchIntegration): string {
  if (integration.readiness === "ready") {
    return `Active revision ${integration.activeRevision?.revisionNumber ?? ""}`.trim();
  }
  if (integration.readiness === "provider_model_unavailable") {
    return "Technical model unavailable";
  }
  if (integration.readiness === "compatible_model_unavailable") {
    return "Compatible answer model unavailable";
  }
  return "Activation required";
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds >= 60 && seconds % 60 === 0
    ? `${seconds / 60} min`
    : `${seconds} sec`;
}

function testState(integration: AdminSearchIntegration): string {
  if (integration.draftDirty) return "Draft changed after its last test";
  if (integration.draftTestEvidence?.status === "available") return "Exact draft tested";
  if (integration.draftTestEvidence?.status === "unavailable") return "Last test unavailable";
  return "Not tested";
}

function compatibleModel(
  protocol: AdminSearchDraft["protocol"],
  model: AdminSearchProviderModelOption
): boolean {
  return model.nativeSearch && (
    protocol === "openrouter_perplexity_chat"
      ? model.adapterKind === "openrouter_chat_completions"
      : protocol === "openai_responses_web_search"
        ? model.adapterKind === "openai_responses_native" ||
          model.adapterKind === "openai_responses_compatible"
        : model.adapterKind === "gemini_interactions_native"
  );
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
  onCreate,
  onRefresh,
  onSelect,
  selectedId
}: Readonly<{
  busy: boolean;
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
          [integration.displayName, integration.description, integration.strategyId]
            .some((value) => value.toLowerCase().includes(needle)))
      : integrations;
  }, [integrations, query]);

  return (
    <div className="min-w-0">
      <div className="grid gap-3 border-b border-trace-subtle p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation catalog</p>
            <p className="mt-1 text-xs text-ink-secondary">{integrations.length} search integration{integrations.length === 1 ? "" : "s"}</p>
          </div>
          <div className="flex gap-1">
            <button aria-label="Refresh Search integrations" className={quietButton} disabled={busy} onClick={onRefresh} type="button">
              <RefreshCw aria-hidden="true" className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
            </button>
            <button className={primaryButton} disabled={busy} onClick={onCreate} type="button">
              <Plus aria-hidden="true" className="size-3.5" />
              Add
            </button>
          </div>
        </div>
        <label className="relative block">
          <span className="sr-only">Search integrations</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input className={`${inputClass} pl-9`} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search engines" type="search" value={query} />
        </label>
      </div>
      <div className="max-h-[44rem] overflow-y-auto p-2">
        {visible.length ? (
          <div aria-label="Search integration catalog" className="grid gap-1" role="list">
            {visible.map((integration) => (
              <div key={integration.id} role="listitem">
                <button
                  aria-current={selectedId === integration.id ? "true" : undefined}
                  className={`flex min-h-touch w-full min-w-0 items-center gap-2 border-l-2 px-3 py-2 text-left ${focusRing} ${
                    integration.enabled ? "border-positive" : "border-trace-strong"
                  } ${selectedId === integration.id ? "bg-answer-paper ring-1 ring-inset ring-proof/40" : "hover:bg-control-hover"}`}
                  onClick={() => onSelect(integration.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs font-medium text-ink">{integration.displayName}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{protocolLabel(integration.draft.protocol)}</span>
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
          <p className="px-3 py-10 text-center text-xs text-ink-muted">No matching Search integrations.</p>
        )}
      </div>
    </div>
  );
}

function SearchFormFields({
  disabled,
  form,
  identityLocked,
  providerModels,
  setForm
}: Readonly<{
  disabled: boolean;
  form: SearchForm;
  identityLocked: boolean;
  providerModels: readonly AdminSearchProviderModelOption[];
  setForm(value: SearchForm): void;
}>) {
  const options = providerModels.filter((model) => compatibleModel(form.draft.protocol, model));
  const updateDraft = (patch: Partial<AdminSearchDraft>) => setForm({
    ...form,
    draft: { ...form.draft, ...patch }
  });
  return (
    <div className="grid gap-4">
      <label className="min-w-0">
        <span className={fieldLabel}>User-facing name</span>
        <input className={`${inputClass} mt-1.5`} disabled={disabled} maxLength={160} onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })} value={form.displayName} />
      </label>
      <label className="min-w-0">
        <span className={fieldLabel}>Purpose</span>
        <textarea className={`${inputClass} mt-1.5 min-h-24 py-2`} disabled={disabled} maxLength={500} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} value={form.description} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="min-w-0">
          <span className={fieldLabel}>Engine protocol</span>
          <select
            className={`${inputClass} mt-1.5`}
            disabled={disabled || identityLocked}
            onChange={(event) => {
              const protocol = event.currentTarget.value as AdminSearchDraft["protocol"];
              const first = providerModels.find((model) => compatibleModel(protocol, model));
              updateDraft({ protocol, providerModelId: first?.id ?? null });
            }}
            value={form.draft.protocol}
          >
            {identityLocked && form.draft.protocol === "gemini_google_search" ? <option value="gemini_google_search">Gemini Google Search</option> : null}
            <option value="openai_responses_web_search">OpenAI Responses web search</option>
            <option value="openrouter_perplexity_chat">OpenRouter / Perplexity search</option>
          </select>
          <span className={helpText}>A reviewed typed adapter, never an arbitrary request template.</span>
        </label>
        <label className="min-w-0">
          <span className={fieldLabel}>Technical provider model</span>
          <select
            className={`${inputClass} mt-1.5`}
            disabled={disabled || identityLocked || form.draft.adapterKind === "answer_provider_hosted"}
            onChange={(event) => updateDraft({ providerModelId: event.currentTarget.value || null })}
            value={form.draft.providerModelId ?? ""}
          >
            <option value="">Select a compatible model</option>
            {options.map((model) => (
              <option disabled={!model.enabled} key={model.id} value={model.id}>
                {model.connectionDisplayName} · {model.displayName} ({model.upstreamModelId})
              </option>
            ))}
          </select>
          <span className={helpText}>Search reuses this model&apos;s server-side credential binding.</span>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label>
          <span className={fieldLabel}>Result limit</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={20} min={1} onChange={(event) => updateDraft({ maxResults: Number(event.currentTarget.value) })} type="number" value={form.draft.maxResults} />
        </label>
        <label>
          <span className={fieldLabel}>Query limit</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={1000} min={32} onChange={(event) => updateDraft({ queryMaxCharacters: Number(event.currentTarget.value) })} type="number" value={form.draft.queryMaxCharacters} />
        </label>
        <label>
          <span className={fieldLabel}>Engine timeout, seconds</span>
          <input className={`${inputClass} mt-1.5`} disabled={disabled} max={900} min={5} onChange={(event) => updateDraft({ timeoutMs: Number(event.currentTarget.value) * 1_000 })} step={5} type="number" value={form.draft.timeoutMs / 1_000} />
          <span className={helpText}>Per engine. Selected engines run concurrently; maximum 15 minutes.</span>
        </label>
      </div>
    </div>
  );
}

function TaskTabs({ onSelect, selected }: Readonly<{ onSelect(task: SearchTask): void; selected: SearchTask }>) {
  return (
    <div aria-label="Search integration tasks" className="flex min-w-0 gap-6 overflow-x-auto border-b border-trace-subtle px-4 sm:px-6" role="tablist">
      {tasks.map(({ Icon, id, label }) => (
        <button
          aria-selected={selected === id}
          className={`-mb-px inline-flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 text-xs font-medium ${focusRing} ${selected === id ? "border-proof text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}
          key={id}
          onClick={() => onSelect(id)}
          role="tab"
          type="button"
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
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
  onAction(action: "activate" | "archive" | "disable" | "enable" | "test"): void;
  onSave(): void;
  setForm(value: SearchForm): void;
  task: SearchTask;
}>) {
  if (task === "configuration") {
    return (
      <section className="grid gap-5 p-4 sm:p-6" aria-label="Search configuration">
        <div>
          <h4 className="text-sm font-semibold text-ink">Draft configuration</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Saving resets draft test evidence. The active revision continues serving users until a newly tested draft is activated.</p>
        </div>
        <SearchFormFields disabled={busy} form={form} identityLocked={Boolean(integration.activeRevision)} providerModels={catalog.providerModels} setForm={setForm} />
        <div><button className={primaryButton} disabled={busy} onClick={onSave} type="button"><Save aria-hidden="true" className="size-3.5" />Save draft</button></div>
      </section>
    );
  }
  if (task === "credentials") {
    return (
      <section className="grid gap-4 p-4 sm:p-6" aria-label="Search credentials">
        <div>
          <h4 className="text-sm font-semibold text-ink">Credential route</h4>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Credentials remain write-only in the existing provider vault. Search binds the accepted credential version server-side; the browser never receives or chooses it.</p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Mode">{integration.credentialMode === "answer_provider" ? "Accepted answer-provider credential" : "Selected provider-model credential precedence"}</Fact>
          <Fact label="Technical connection">{integration.providerModel ? `${integration.providerModel.connectionDisplayName} · ${integration.providerModel.displayName}` : "Answer provider selected at run admission"}</Fact>
        </dl>
      </section>
    );
  }
  if (task === "compatibility") {
    return (
      <section className="grid gap-4 p-4 sm:p-6" aria-label="Search compatibility">
        <div>
          <h4 className="text-sm font-semibold text-ink">Run compatibility</h4>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">The current-user catalog publishes this option only when the answer model and exact orchestration mode are supported. Run admission rechecks every fact.</p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Modes">{integration.executionModes.map((mode) => mode === "all_selected" ? "All selected per search" : "Model chooses").join(" · ") || "Single native option only"}</Fact>
          <Fact label="Answer model requirement">{integration.adapterKind === "provider_model_client" ? "Provider-neutral tool calling" : "Matching native hosted-search adapter"}</Fact>
          <Fact label="Privacy">{integration.adapterKind === "provider_model_client" ? "Bounded generated query only" : "Runs inside the answer-provider context"}</Fact>
          <Fact label="Selection bound">Up to three entitled options per run</Fact>
        </dl>
      </section>
    );
  }
  if (task === "diagnostics") {
    const evidence = integration.draftTestEvidence;
    return (
      <section className="grid gap-5 p-4 sm:p-6" aria-label="Search diagnostics">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-ink">Bounded connection test</h4>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">The test sends a fixed query-only probe. It stores status and normalized source count, never the answer, source URLs, token, or raw provider response.</p>
          </div>
          <button className={primaryButton} disabled={busy} onClick={() => onAction("test")} type="button"><TestTube2 aria-hidden="true" className="size-3.5" />Test draft</button>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="State">{testState(integration)}</Fact>
          <Fact label="Checked">{evidence ? new Date(evidence.checkedAt).toLocaleString() : "Never"}</Fact>
          <Fact label="Method">{evidence?.method === "provider_search" ? "Provider search probe" : evidence ? "Configuration validation" : "—"}</Fact>
          <Fact label="Normalized sources">{evidence?.normalizedSourceCount ?? "—"}</Fact>
        </dl>
      </section>
    );
  }
  return (
    <section className="grid gap-6 p-4 sm:p-6" aria-label="Search overview">
      <div className="border-l-2 border-proof bg-proof/[0.05] px-4 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-proof">Search route</p>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-ink">
          <span className="rounded-control bg-control-surface px-2.5 py-1.5">User option</span>
          <ArrowRight aria-hidden="true" className="size-4 text-ink-muted" />
          <span className="rounded-control bg-control-surface px-2.5 py-1.5">Active engine revision {integration.activeRevision?.revisionNumber ?? "—"}</span>
          <ArrowRight aria-hidden="true" className="size-4 text-ink-muted" />
          <span className="rounded-control bg-control-surface px-2.5 py-1.5">Compatible answer models</span>
        </div>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Fact label="Availability"><AdminAvailabilityStatus enabled={integration.enabled} /></Fact>
        <Fact label="Readiness">{readinessLabel(integration)}</Fact>
        <Fact label="Draft">{testState(integration)}</Fact>
        <Fact label="Execution">{adapterLabel(integration)}</Fact>
        <Fact label="Protocol">{protocolLabel(integration.draft.protocol)}</Fact>
        <Fact label="Draft engine timeout">{durationLabel(integration.draft.timeoutMs)}</Fact>
        <Fact label="Stable option id"><span className="font-mono text-xs">{integration.strategyId}</span></Fact>
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
        <button className={primaryButton} disabled={busy} onClick={() => onAction("test")} type="button"><TestTube2 aria-hidden="true" className="size-3.5" />Test draft</button>
        <button className={quietButton} disabled={busy || integration.draftDirty || integration.draftTestEvidence?.status !== "available"} onClick={() => onAction("activate")} type="button"><CheckCircle2 aria-hidden="true" className="size-3.5" />Activate tested draft</button>
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
    after?: (next: AdminSearchCatalog, previous: AdminSearchCatalog | null) => void
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
    after?.(result.search, previous);
    setNotice(success);
    void onMutationCommitted?.();
  }

  function openCreate() {
    if (!catalog) return;
    setForm(emptyForm(catalog.providerModels));
    setMode("create");
    setTask("configuration");
  }

  function openIntegration(id: string) {
    const integration = catalog?.integrations.find((candidate) => candidate.id === id);
    if (!integration) return;
    setSelectedId(id);
    setForm(formFrom(integration));
    setTask("overview");
    setMode("detail");
  }

  function runAction(action: "activate" | "archive" | "disable" | "enable" | "test") {
    if (!selected) return;
    if (action === "archive" && !window.confirm(`Archive ${selected.displayName}? Existing run history remains available.`)) return;
    const success = action === "test"
      ? "Search draft tested."
      : action === "activate"
        ? "Tested Search revision activated."
        : action === "enable"
          ? "Search integration enabled."
          : action === "disable"
            ? "Search integration disabled."
            : "Search integration archived.";
    void commit(
      runAdminSearchAction({ action, confirmed: action === "archive" || undefined, id: selected.id }),
      success,
      (next) => {
        const updated = next.integrations.find((item) => item.id === selected.id);
        if (updated) setForm(formFrom(updated));
        else {
          setMode("index");
          setSelectedId(next.integrations[0]?.id ?? null);
        }
      }
    );
  }

  if (!catalog && busy) {
    return <div className="flex min-h-[28rem] items-center justify-center gap-2 text-sm text-ink-muted"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading Search integrations</div>;
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
  return (
    <div className="min-w-0" data-testid="admin-search-section">
      <Feedback error={error} notice={notice} onDismiss={() => { setError(null); setNotice(null); }} />
      <SearchDefaultPolicyEditor
        busy={busy}
        catalog={search}
        key={search.policy.version}
        onSave={(defaultPlan) => void commit(
          updateAdminSearchPolicy({
            defaultPlan,
            expectedVersion: search.policy.version
          }),
          "Organization Search default saved."
        )}
      />
      <AdminTaskWorkspace className="mt-2" indexWidth="20rem">
        <AdminTaskIndexPane compactDetailOpen={mode !== "index"} testId="admin-search-index-pane">
          <SearchCatalogIndex busy={busy} integrations={search.integrations} onCreate={openCreate} onRefresh={() => void load()} onSelect={openIntegration} selectedId={selectedId} />
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen={mode !== "index"} testId="admin-search-detail-pane">
          {mode === "create" ? (
            <section className="grid gap-5 p-4 sm:p-6">
              <AdminTaskBackButton label="Back to Search" onClick={() => setMode("index")} />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">New installation option</p>
                <h3 className="mt-1 text-lg font-semibold text-ink">Add search integration</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">Choose a reviewed engine protocol and an existing technical provider model. OpenAI Responses Search receives only a bounded generated query and can serve Anthropic, Gemini, or any other tool-capable answer model. The new option stays disabled until its exact draft is tested and activated.</p>
              </div>
              <SearchFormFields disabled={busy} form={form} identityLocked={false} providerModels={search.providerModels} setForm={setForm} />
              <div className="flex gap-2">
                <button
                  className={primaryButton}
                  disabled={busy || !form.displayName.trim() || !form.draft.providerModelId}
                  onClick={() => void commit(
                    createAdminSearchIntegration(form),
                    "Search integration draft added.",
                    (next, previous) => {
                      const previousIds = new Set(previous?.integrations.map((item) => item.id) ?? []);
                      const created = next.integrations.find((item) => !previousIds.has(item.id));
                      if (created) {
                        setSelectedId(created.id);
                        setForm(formFrom(created));
                        setMode("detail");
                        setTask("diagnostics");
                      }
                    }
                  )}
                  type="button"
                >
                  <Plus aria-hidden="true" className="size-3.5" />Add draft
                </button>
                <button className={quietButton} disabled={busy} onClick={() => setMode("index")} type="button">Cancel</button>
              </div>
            </section>
          ) : selected ? (
            <div className="min-w-0">
              <div className="flex flex-col gap-3 border-b border-trace-subtle px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <AdminTaskBackButton label="Back to Search" onClick={() => setMode("index")} />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Search integration</p>
                  <h3 className="mt-1 break-words text-lg font-semibold text-ink">{selected.displayName}</h3>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">{selected.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2"><AdminAvailabilityStatus enabled={selected.enabled} /><span className={selected.ready ? "text-xs text-positive" : "text-xs text-caution"}>{selected.ready ? "Ready" : readinessLabel(selected)}</span></div>
              </div>
              <TaskTabs onSelect={setTask} selected={task} />
              <DetailTask busy={busy} catalog={search} form={form} integration={selected} onAction={runAction} onSave={() => void commit(
                updateAdminSearchIntegration({ ...form, expectedDraftVersion: selected.draftVersion, id: selected.id }),
                "Search draft saved.",
                (next) => {
                  const updated = next.integrations.find((item) => item.id === selected.id);
                  if (updated) setForm(formFrom(updated));
                }
              )} setForm={setForm} task={task} />
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-ink-muted">Select or add a Search integration.</div>
          )}
        </AdminTaskDetailPane>
      </AdminTaskWorkspace>
    </div>
  );
}

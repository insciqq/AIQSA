"use client";

import { ImageModelFields } from "./ImageModelFields";
import { imageModelConfiguration } from "@/lib/domain/imageModels";
import { inputClass } from "@/components/admin/adminPrimitives";
import {
  reasoningCapabilitiesEqual,
  reasoningCapabilitiesSummary,
  reasoningForChoice,
  discoveredReasoning,
  applyReasoningCapabilities,
  type AdminProviderReasoningChoice
} from "@/components/admin/adminProviderReasoning";
import { AdminSearchablePicker } from "@/components/admin/AdminSearchablePicker";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { defaultCredentialOf, modelEditorCheck, modelRouteLabel, providerKeyFirstHelp, providerNeedsKeyForModels } from "@/components/admin/providers/models/modelListView";
import {
  applyCatalogHint,
  applyCompatibleModel,
  applyOpenRouterModel,
  blankModelForm,
  catalogHintsFor,
  describeOpenRouterModel,
  endpointDetail,
  endpointLabel,
  modelFormBody,
  modelFormFrom,
  modelFormsEqual,
  moveProviderTag,
  type ModelForm
} from "@/components/admin/providers/models/modelSheetView";
import {
  openRouterEndpointDiscoveryIdentity,
  openRouterModelDiscoveryIdentity,
  type AdminOpenRouterDiscoverySession
} from "@/components/admin/providers/models/useAdminOpenRouterDiscovery";
import { ModelJsonDialog } from "@/components/admin/providers/models/ModelJsonDialog";
import { AdminProviderSetupProgress } from "@/components/admin/providers/add/AdminProviderSetupProgress";
import type { AdminProviderSetupProgress as SetupProgress } from "@/lib/contracts/adminProviderSetupProgress";
import { providerFamilyLabel } from "@/components/admin/providers/providerListView";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2Switch } from "@/components/ui-v2";
import type {
  AdminProviderAdapterKind,
  AdminProviderConnection,
  AdminProviderModel,
  AdminProviderModelCapabilities
} from "@/lib/contracts/adminProviders";
import { ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS } from "@/lib/contracts/adminProviders";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import { useEffect, useId, useMemo, useRef, useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-xs leading-5 text-ink-muted";
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export type AdminProviderModelSheetProps = Readonly<{
  connection: AdminProviderConnection;
  controller: Pick<AdminProvidersController, "actions" | "state">;
  discovery: AdminOpenRouterDiscoverySession;
  diagnosticCredentialId?: string | null;
  /** Null adds a chat model. */
  model: AdminProviderModel | null;
  onClose(): void;
  onSaved(): void;
}>;

function SettingRow({
  checked,
  detail,
  disabled,
  label,
  onChange
}: Readonly<{
  checked: boolean;
  detail?: string;
  disabled: boolean;
  label: string;
  onChange(next: boolean): void;
}>) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {detail ? <p className="text-xs text-ink-muted">{detail}</p> : null}
      </div>
      <UiV2Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}

function RoutingField({
  connection,
  credentialId,
  disabled,
  discovery,
  form,
  setForm
}: Readonly<{
  connection: AdminProviderConnection;
  credentialId: string | null;
  disabled: boolean;
  discovery: AdminOpenRouterDiscoverySession;
  form: ModelForm;
  setForm(next: ModelForm): void;
}>) {
  const [query, setQuery] = useState("");
  const credential = connection.credentials.find(({ id }) => id === credentialId) ?? null;
  const identity = useMemo(
    () => openRouterEndpointDiscoveryIdentity(openRouterModelDiscoveryIdentity(connection, credential), form.upstreamModelId),
    [connection, credential, form.upstreamModelId]
  );
  const endpoints = discovery.endpoints.get(identity);
  const selectedMode = form.openRouterRoutingMode === "only_selected";

  useEffect(() => {
    if (selectedMode && identity) void discovery.endpoints.load(identity);
  }, [discovery.endpoints, identity, selectedMode]);

  const byTag = useMemo(() => new Map(endpoints.items.map((endpoint) => [endpoint.tag, endpoint])), [endpoints.items]);
  const normalized = query.trim().toLocaleLowerCase();
  const available = endpoints.items
    .filter((endpoint) => !form.providerTags.includes(endpoint.tag))
    .filter((endpoint) => !normalized ||
      `${endpoint.providerName} ${endpoint.name} ${endpoint.tag}`.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => collator.compare(endpointLabel(left), endpointLabel(right)) || collator.compare(left.tag, right.tag));
  const suggestion = available.slice(0, 3).map(endpointLabel).join(", ");
  const optionCard = (mode: ModelForm["openRouterRoutingMode"], title: string, detail: string) => (
    <label
      className={`flex cursor-pointer flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 ${
        form.openRouterRoutingMode === mode ? "border-proof bg-proof/10" : "border-trace-strong"
      } ${focusRing}`}
      data-selected={form.openRouterRoutingMode === mode || undefined}
    >
      <input
        checked={form.openRouterRoutingMode === mode}
        className="sr-only"
        disabled={disabled}
        name="routing-mode"
        onChange={() => setForm({
          ...form,
          openRouterRoutingMode: mode,
          providerTags: mode === "automatic" ? [] : form.providerTags
        })}
        type="radio"
        value={mode}
      />
      <span className="text-[13px] font-semibold text-ink">{title}</span>
      <span className="text-xs text-ink-muted">{detail}</span>
    </label>
  );

  return (
    <fieldset className="min-w-0">
      <legend className={fieldLabel}>Routing</legend>
      <div className="grid gap-2 grid-cols-[minmax(0,1fr)] sm:grid-cols-2">
        {optionCard("automatic", "Automatic", "OpenRouter picks a healthy route")}
        {optionCard("only_selected", "Only these providers", "In order, no fallback outside the list")}
      </div>
      {selectedMode ? (
        <div className="mt-2 overflow-hidden rounded-[10px] bg-control-surface/60" data-testid="model-routing-list">
          {form.providerTags.length ? (
            <ol aria-label="Providers in order" className="divide-y divide-trace-subtle">
              {form.providerTags.map((tag, index) => {
                const endpoint = byTag.get(tag);
                return (
                  <li className="flex min-w-0 items-center gap-3 px-3 py-2" key={tag}>
                    <span className="w-4 shrink-0 font-mono text-xs text-ink-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{endpoint ? endpointLabel(endpoint) : tag}</span>
                      {endpoint ? <span className="block break-all font-mono text-metadata text-ink-muted">{endpointDetail(endpoint)}</span> : null}
                    </span>
                    <UiV2IconButton
                      disabled={disabled || index === 0}
                      icon="arrow-up"
                      label={`Move ${endpoint ? endpointLabel(endpoint) : tag} up`}
                      onClick={() => setForm({ ...form, providerTags: moveProviderTag(form.providerTags, index, -1) })}
                    />
                    <UiV2IconButton
                      className="rotate-180"
                      disabled={disabled || index === form.providerTags.length - 1}
                      icon="arrow-up"
                      label={`Move ${endpoint ? endpointLabel(endpoint) : tag} down`}
                      onClick={() => setForm({ ...form, providerTags: moveProviderTag(form.providerTags, index, 1) })}
                    />
                    <UiV2IconButton
                      disabled={disabled}
                      icon="close"
                      label={`Remove ${endpoint ? endpointLabel(endpoint) : tag}`}
                      onClick={() => setForm({ ...form, providerTags: form.providerTags.filter((entry) => entry !== tag) })}
                    />
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="px-3 py-2 text-xs text-ink-muted">No providers yet — add the first one below.</p>
          )}
          <div className="border-t border-trace-subtle p-2">
            {!identity ? (
              <p className="px-1 py-1 text-xs text-ink-muted">Choose a model and keep a working key to list its providers.</p>
            ) : (
              <>
                <label className="relative block">
                  <span className="sr-only">Add provider</span>
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
                    <UiV2Icon className="size-3.5" name="plus" />
                  </span>
                  <input
                    className={`${inputClass} h-9 min-h-0 pl-8 text-[13px]`}
                    disabled={disabled}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={`Add provider${suggestion ? ` · ${suggestion}…` : ""}`}
                    type="search"
                    value={query}
                  />
                </label>
                {endpoints.status === "loading" && endpoints.items.length === 0 ? (
                  <p className="px-1 pt-2 text-xs text-ink-muted" role="status">Loading providers…</p>
                ) : null}
                {endpoints.status === "error" ? (
                  <p className="flex items-center justify-between gap-2 px-1 pt-2 text-xs text-critical" role="alert">
                    <span>{endpoints.error}</span>
                    <UiV2Button onClick={() => void discovery.endpoints.retry(identity)} tone="ghost" type="button">Retry</UiV2Button>
                  </p>
                ) : null}
                {endpoints.status === "empty" ? (
                  <p className="px-1 pt-2 text-xs text-ink-muted" role="status">OpenRouter lists no providers for this model.</p>
                ) : null}
                {available.length ? (
                  <ul aria-label="Available providers" className="mt-1 max-h-44 overflow-y-auto overscroll-contain">
                    {available.map((endpoint) => (
                      <li key={endpoint.tag}>
                        <button
                          className={`flex w-full min-w-0 items-center justify-between gap-3 rounded-[8px] px-2 py-1.5 text-left hover:bg-control-hover ${focusRing}`}
                          disabled={disabled}
                          onClick={() => {
                            setForm({ ...form, providerTags: [...form.providerTags, endpoint.tag] });
                            setQuery("");
                          }}
                          type="button"
                        >
                          <span className="min-w-0 break-words text-[13px] text-ink [overflow-wrap:anywhere]">{endpointLabel(endpoint)}</span>
                          <span className="min-w-0 max-w-[45%] break-all font-mono text-metadata text-ink-muted">{endpointDetail(endpoint)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

function SheetBody({
  connection,
  controller,
  discovery,
  diagnosticCredentialId,
  model,
  onClose,
  onSaved
}: AdminProviderModelSheetProps) {
  const [form, setForm] = useState<ModelForm>(() => model ? modelFormFrom(model) : blankModelForm(connection));
  const [baseline] = useState(form);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [jsonEditing, setJsonEditing] = useState(false);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const jsonTriggerRef = useRef<HTMLButtonElement>(null);
  const timeoutRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const keyHelpId = useId();
  const errorId = useId();
  const hintsId = useId();
  const busy = controller.state.busy || saving;
  const needsKeyForNewModel = model === null && providerNeedsKeyForModels(connection);
  const family = connection.family;
  const openRouter = family === "openrouter";
  const compatible = family === "openai_compatible";
  const answer = form.modelClass === "answer";
  const imageModel = form.modelClass === "image";
  const currentModel = model ? connection.models.find(({ id }) => id === model.id) ?? null : null;
  const defaultCredential = defaultCredentialOf(connection);
  const check = modelEditorCheck(connection, currentModel, diagnosticCredentialId === undefined ? connection.defaultCredentialId : diagnosticCredentialId);
  const savedRoute = currentModel ? modelRouteLabel(connection, currentModel) : null;
  const checkKeyLabel = defaultCredential && defaultCredential.enabled && defaultCredential.activeVersion &&
    defaultCredential.activeVersion.revokedAt === null
    ? defaultCredential.label
    : null;
  const discoveryCredential = checkKeyLabel
    ? defaultCredential
    : connection.credentials.find((credential) =>
        credential.enabled && credential.activeVersion && credential.activeVersion.revokedAt === null) ?? null;
  const modelIdentity = useMemo(
    () => openRouterModelDiscoveryIdentity(connection, discoveryCredential),
    [connection, discoveryCredential]
  );
  const catalog = discovery.models.get(modelIdentity);
  const compatibleCatalog = discovery.compatibleModels.get(modelIdentity);
  const selectedCatalogModel = catalog.items.find(({ id }) => id === form.upstreamModelId) ?? null;
  const selectedCompatibleModel = compatibleCatalog.items.find(({ id }) => id === form.upstreamModelId) ?? null;
  const hints = useMemo(() => openRouter || compatible ? [] : catalogHintsFor(family), [compatible, family, openRouter]);
  const dirty = !modelFormsEqual(form, baseline);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!answer || !modelIdentity) return;
    if (openRouter) void discovery.models.load(modelIdentity);
    else if (compatible) void discovery.compatibleModels.load(modelIdentity);
  }, [answer, compatible, discovery.compatibleModels, discovery.models, modelIdentity, openRouter]);

  const update = (patch: Partial<ModelForm>) => {
    setForm({ ...form, ...patch });
    setError(null);
    setErrorField(null);
  };
  const updateCapability = (key: keyof AdminProviderModelCapabilities, value: boolean | number | undefined) => {
    const capabilities = { ...form.capabilities };
    if (value === undefined) delete capabilities[key];
    else Object.assign(capabilities, { [key]: value });
    update({ capabilities });
  };
  const changeAdapter = (adapterKind: AdminProviderAdapterKind) => {
    const capabilities = { ...form.capabilities };
    if (adapterKind === "openai_chat_completions_compatible") {
      capabilities.nativeSearch = false;
      capabilities.nativeImageGeneration = false;
    } else {
      delete capabilities.streamUsage;
    }
    const mapping = compatibleReasoningRequestMappingDefault(
      adapterKind === "openai_responses_compatible" ? "responses" : "chat_completions"
    );
    update({ adapterKind, capabilities, reasoningEffortPath: mapping.effortPath, reasoningModePath: mapping.modePath ?? "" });
  };
  const automaticReasoning = discoveredReasoning(selectedCompatibleModel ?? undefined) ?? { reasoning: false };
  const reasoningChoice: AdminProviderReasoningChoice | "custom" = !form.capabilities.reasoning
    ? "disabled"
    : reasoningCapabilitiesEqual(form.capabilities, automaticReasoning)
      ? "automatic"
      : reasoningCapabilitiesEqual(form.capabilities, reasoningForChoice("openai_gpt_5_6_sol", []))
        ? "openai_gpt_5_6_sol"
        : "custom";

  const requestClose = () => {
    if (busy || jsonEditing || discarding) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    if (busy || interrupted || jsonEditing || discarding || needsKeyForNewModel) return;
    const result = modelFormBody(form, connection, model);
    if (!result.ok) {
      setErrorField(result.field);
      if (result.field === "defaultParams") jsonTriggerRef.current?.focus();
      if (result.field === "timeout") timeoutRef.current?.focus();
      setError(result.error);
      return;
    }
    setError(null);
    const abort = new AbortController();
    abortRef.current = abort;
    setSaving(true);
    setProgress({ phase: "validating", completed: 0, total: null });
    const saved = await controller.actions.saveModel(connection.id, model?.id ?? null, result.body, {
      signal: abort.signal,
      onProgress: (value) => { if (!abort.signal.aborted) setProgress(value); }
    });
    abortRef.current = null;
    setSaving(false);
    setProgress(null);
    if (saved.ok) {
      onSaved();
      return;
    }
    setError(saved.message);
    if (abort.signal.aborted || ["network_error", "provider_admin_response_invalid"].includes(saved.error.code)) setInterrupted(true);
    setErrorField(saved.error?.code === "provider_configuration_invalid" ? "configuration" : null);
  };

  const canSave = !busy && !needsKeyForNewModel && !interrupted && !jsonEditing && !discarding && form.upstreamModelId.trim() !== "" && (model === null || dirty);
  const capabilityRows: ReadonlyArray<[keyof AdminProviderModelCapabilities, string, string?]> = compatible
    ? [
        ["toolCalling", "Tools", "Function calling for Search, MCP and Memory."],
        ["streaming", "Streaming"],
        ["vision", "Image input"],
        ["parallelToolCalls", "Parallel tool calls"],
        ["nativePdfInput", "Direct PDF input", "Sends the original PDF to the provider; users get it only after the check passes."]
      ]
    : [
        ["toolCalling", "Tools", "Function calling for Search, MCP and Memory."],
        ["streaming", "Streaming"],
        ["vision", "Image input"],
        ["reasoning", "Reasoning"],
        ["parallelToolCalls", "Parallel tool calls"],
        ["nativeSearch", "Hosted web search", "The provider's own Search tool, when the model offers one."],
        ["nativePdfInput", "Direct PDF input", "Sends the original PDF to the provider; users get it only after the check passes."]
      ];

  return (
    <AdminSheet
      closeBlocked={busy || jsonEditing || discarding}
      description={providerFamilyLabel(family)}
      footer={(
        <>
          {interrupted ? <UiV2Button onClick={onSaved} tone="primary" type="button">View model results</UiV2Button> : <UiV2Button aria-describedby={keyHelpId} busy={busy} disabled={!canSave} form={formId} tone="primary" type="submit">
            Test &amp; Save
          </UiV2Button>}
          {saving ? <UiV2Button onClick={() => abortRef.current?.abort()} tone="ghost" type="button">Stop checking</UiV2Button>
            : <UiV2Button disabled={busy || jsonEditing || discarding} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>}
          <span className="min-w-0 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere] sm:ml-auto sm:text-right" id={keyHelpId}>
            {needsKeyForNewModel ? providerKeyFirstHelp : checkKeyLabel
              ? model ? `Checks the model with key ${checkKeyLabel} and preserves your capability choices`
                : `Checks supported capabilities with key ${checkKeyLabel} and enables verified features, including PDF`
              : "Turns the model on without a check — add a key first to check it"}
          </span>
        </>
      )}
      onClose={requestClose}
      open
      testId="provider-model-sheet"
      title={model ? "Edit model" : "Add model"}
      width="wide"
    >
      <form
        aria-describedby={error ? errorId : undefined}
        className="flex flex-col gap-5"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {progress ? <AdminProviderSetupProgress progress={progress} /> : null}
        {model ? (
          <section aria-label="Last model check" className="min-w-0 border-b border-trace-subtle pb-4 text-xs leading-5 [overflow-wrap:anywhere]">
            <h3 className="mb-1 font-semibold text-ink">Last check · {check.status}</h3>
            {check.message ? <p className={check.status === "Check failed" ? "text-caution" : "text-ink-secondary"} role="status">{check.message}</p> : null}
            {check.summary ? <p className="text-ink-secondary">{check.summary}</p> : null}
            {check.usageMissing ? <p className="text-caution">No usage reporting — cost accounting for this model will be empty.</p> : null}
            <p className="mt-1 text-ink-muted">{checkKeyLabel ? `Test & Save uses key ${checkKeyLabel}.` : "Test & Save has no working default key; it saves without a check."}</p>
          </section>
        ) : null}
        <section aria-label="Model identity and routing" className="flex min-w-0 flex-col gap-4">
          <h3 className="text-sm font-semibold text-ink">Model and routing</h3>
          {!model && ["openai", "openai_compatible", "gemini", "openrouter"].includes(family) ? <label>
            <span className={fieldLabel}>Model purpose</span>
            <select className={inputClass} disabled={busy} value={form.modelClass} onChange={(event) => {
              const blank = blankModelForm(connection);
              if (event.currentTarget.value === "image") {
                const profile = family === "openai" ? "openai" : family === "gemini" ? "gemini" : family === "openrouter" ? "openrouter" :
                  connection.draftConfig.responsesRequestIsolationDetected ? "codex_lb" : "openai_compatible";
                setForm({ ...blank, ...imageModelConfiguration("", { profile }), image: { profile } });
              } else setForm(blank);
            }}><option value="answer">Chat</option><option value="image">Image generation</option></select>
          </label> : null}
          <div className="min-w-0">
            {/* The pickers render their own visible label; keep this one for the read-only id and aria-labelledby. */}
            <span className={answer ? "sr-only" : fieldLabel} id={`${formId}-model-label`}>Model</span>
            {imageModel ? <ImageModelFields connection={connection} credential={discoveryCredential} form={form} disabled={busy}
              onChange={(next) => { setForm(next); setError(null); }} /> : !answer ? (
              <p className="flex min-h-control items-center break-all rounded-control border border-trace-subtle bg-control-surface/60 px-3 font-mono text-xs text-ink-secondary">
                {form.upstreamModelId}
              </p>
            ) : openRouter ? (
              <>
                <AdminSearchablePicker
                  disabled={!modelIdentity || busy}
                  emptyDescription="This key returned an empty catalog. Refresh it or review the OpenRouter account policy."
                  emptyTitle="No models available to this key"
                  error={catalog.error}
                  items={catalog.items.map((entry) => ({
                    id: entry.id,
                    keywords: [entry.id.split("/")[0] ?? "", ...entry.inputModalities, ...entry.supportedParameters],
                    label: entry.name,
                    secondaryText: entry.id
                  }))}
                  label="Model"
                  loading={catalog.status === "loading"}
                  noun={{ plural: "models", singular: "model" }}
                  onRetry={() => void discovery.models.retry(modelIdentity)}
                  onSelect={(item) => {
                    const entry = catalog.items.find(({ id }) => id === item.id);
                    if (entry) {
                      setForm(applyOpenRouterModel(form, entry));
                      setError(null);
                    }
                  }}
                  placeholder="Search the catalog"
                  searchPlaceholder="Search name, provider, capability or model id"
                  selectedFallbackLabel={form.displayName || "Configured model"}
                  selectedId={form.upstreamModelId || null}
                />
                <span className={helpText}>
                  {selectedCatalogModel
                    ? `Searches the catalog available to this key. ${describeOpenRouterModel(selectedCatalogModel)}`
                    : modelIdentity
                      ? "Searches the catalog available to this key."
                      : "Add a working key first to search the catalog."}
                </span>
              </>
            ) : compatible ? (
              <div className="flex flex-col gap-2">
                <AdminSearchablePicker
                  disabled={!modelIdentity || busy}
                  emptyDescription="The endpoint reported no model ids. Enter the exact id below."
                  emptyTitle="No models reported"
                  error={compatibleCatalog.error}
                  items={compatibleCatalog.items.map((entry) => ({ id: entry.id, label: entry.id, secondaryText: "Reported by the endpoint" }))}
                  label="Model"
                  loading={compatibleCatalog.status === "loading"}
                  noun={{ plural: "models", singular: "model" }}
                  onRetry={() => void discovery.compatibleModels.retry(modelIdentity)}
                  onSelect={(item) => {
                    setForm(applyCompatibleModel(form, compatibleCatalog.items.find(({ id }) => id === item.id) ?? null, item.id));
                    setError(null);
                  }}
                  placeholder="Choose a reported model"
                  searchPlaceholder="Search model ids"
                  selectedFallbackLabel={form.upstreamModelId || "Configured model"}
                  selectedId={form.upstreamModelId || null}
                />
                <label className="block min-w-0">
                  <span className={fieldLabel}>Upstream model id</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    disabled={busy}
                    maxLength={256}
                    onChange={(event) => update({ upstreamModelId: event.currentTarget.value })}
                    required
                    spellCheck={false}
                    value={form.upstreamModelId}
                  />
                </label>
                <label className="block min-w-0">
                  <span className={fieldLabel}>Protocol</span>
                  <select
                    className={inputClass}
                    disabled={busy}
                    onChange={(event) => changeAdapter(event.currentTarget.value as AdminProviderAdapterKind)}
                    value={form.adapterKind}
                  >
                    <option value="openai_responses_compatible">Responses</option>
                    <option value="openai_chat_completions_compatible">Chat Completions</option>
                  </select>
                </label>
              </div>
            ) : (
              <>
                <input
                  aria-labelledby={`${formId}-model-label`}
                  className={`${inputClass} font-mono text-xs`}
                  disabled={busy}
                  list={hintsId}
                  maxLength={256}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const hint = hints.find((entry) => entry.upstreamModelId === value);
                    setForm(hint ? applyCatalogHint(form, hint) : { ...form, upstreamModelId: value });
                    setError(null);
                  }}
                  placeholder={hints[0]?.upstreamModelId ?? "model id"}
                  required
                  spellCheck={false}
                  value={form.upstreamModelId}
                />
                <datalist id={hintsId}>
                  {hints.map((hint) => <option key={hint.upstreamModelId} label={hint.displayName} value={hint.upstreamModelId} />)}
                </datalist>
                <span className={helpText}>The exact id the provider expects; known models fill the rest in.</span>
              </>
            )}
          </div>

          <label className="block min-w-0">
            <span className={fieldLabel}>Display name</span>
            <input
              className={inputClass}
              disabled={busy}
              maxLength={160}
              onChange={(event) => update({ displayName: event.currentTarget.value })}
              placeholder={form.upstreamModelId || "Shown in chat"}
              value={form.displayName}
            />
          </label>

          {openRouter && !imageModel ? (
            <div className="min-w-0">
              {savedRoute ? <p className="mb-2 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">Saved route: {savedRoute}.</p> : null}
              <RoutingField
                connection={connection}
                credentialId={discoveryCredential?.id ?? null}
                disabled={busy || !form.upstreamModelId}
                discovery={discovery}
                form={form}
                setForm={(next) => { setForm(next); setError(null); }}
              />
            </div>
          ) : null}

          {answer ? (
            <div className="border-y border-trace-subtle">
              <SettingRow
                checked={form.answerSelectable}
                detail="Off keeps it for internal roles and Search only"
                disabled={busy}
                label="Available in chat"
                onChange={(next) => update({ answerSelectable: next })}
              />
            </div>
          ) : null}

        </section>
        {answer ? (
          <section aria-label="Capabilities and reasoning" className="min-w-0 border-t border-trace-subtle pt-4">
            <fieldset className="min-w-0">
              <legend className={fieldLabel}>Capabilities and reasoning</legend>
              <div className="divide-y divide-trace-subtle">
                {capabilityRows.map(([key, label, detail]) => (
                  <SettingRow
                    checked={form.capabilities[key] === true}
                    detail={detail}
                    disabled={busy}
                    key={key}
                    label={label}
                    onChange={(next) => {
                      if (key === "nativeSearch" && compatible) return;
                      updateCapability(key, next);
                    }}
                  />
                ))}
                {compatible ? (
                  <>
                    <div className="py-2">
                      <label className="block">
                      <span className={fieldLabel}>Reasoning</span>
                      <select
                        className={inputClass}
                        disabled={busy}
                        onChange={(event) => update({
                          capabilities: applyReasoningCapabilities(
                            form.capabilities,
                            event.currentTarget.value === "automatic" ? automaticReasoning : reasoningForChoice(
                              event.currentTarget.value as AdminProviderReasoningChoice,
                              selectedCompatibleModel ? [selectedCompatibleModel] : []
                            )
                          )
                        })}
                        value={reasoningChoice}
                      >
                        {reasoningChoice === "custom" ? <option disabled value="custom">Current custom settings</option> : null}
                        <option value="automatic">As reported by the endpoint</option>
                        <option value="openai_gpt_5_6_sol">OpenAI GPT-5.6 Sol profile</option>
                        <option value="disabled">Off</option>
                      </select>
                      </label>
                      <span className={helpText}>{reasoningCapabilitiesSummary(form.capabilities)}</span>
                    </div>
                    <SettingRow
                      checked={form.capabilities.nativeSearch === true}
                      detail="Uses the Responses protocol so AIQSA can read its citations."
                      disabled={busy}
                      label="Hosted web search"
                      onChange={(next) => {
                        const capabilities = { ...form.capabilities, nativeSearch: next };
                        if (next) delete capabilities.streamUsage;
                        update({
                          adapterKind: next ? "openai_responses_compatible" : form.adapterKind,
                          capabilities,
                          ...(next && form.adapterKind !== "openai_responses_compatible"
                            ? { reasoningEffortPath: "reasoning.effort", reasoningModePath: "reasoning.mode" }
                            : {})
                        });
                      }}
                    />
                    {form.adapterKind === "openai_chat_completions_compatible" ? (
                      <SettingRow
                        checked={form.capabilities.streamUsage === true}
                        detail="Sends stream_options.include_usage; only when the endpoint supports it."
                        disabled={busy}
                        label="Streaming usage totals"
                        onChange={(next) => updateCapability("streamUsage", next || undefined)}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            </fieldset>
            {compatible && form.capabilities.reasoning ? (
              <div className="grid gap-3 grid-cols-[minmax(0,1fr)] sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className={fieldLabel}>Reasoning effort field</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    disabled={busy}
                    maxLength={128}
                    onChange={(event) => update({ reasoningEffortPath: event.currentTarget.value })}
                    required
                    value={form.reasoningEffortPath}
                  />
                </label>
                <label className="block min-w-0">
                  <span className={fieldLabel}>Reasoning mode field</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    disabled={busy}
                    maxLength={128}
                    onChange={(event) => update({ reasoningModePath: event.currentTarget.value })}
                    placeholder="Blank sends no mode"
                    value={form.reasoningModePath}
                  />
                </label>
              </div>
            ) : null}
          </section>
        ) : null}
        <section aria-label="Request settings" className="flex min-w-0 flex-col gap-3 border-t border-trace-subtle pt-4">
          <h3 className="text-sm font-semibold text-ink">Request settings</h3>
          <div className="min-w-0 sm:max-w-xs">
            <label className="block min-w-0">
              <span className={fieldLabel}>Response timeout (seconds)</span>
              <input
                aria-describedby={errorField === "timeout" ? errorId : undefined}
                aria-invalid={errorField === "timeout"}
                className={inputClass}
                disabled={busy}
                ref={timeoutRef}
                inputMode="numeric"
                onChange={(event) => update({ responseTimeoutSeconds: event.currentTarget.value })}
                placeholder={`Inherit ${connection.draftConfig.responseTimeoutSeconds ?? ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS}`}
                value={form.responseTimeoutSeconds}
              />
            </label>
            <span className={helpText}>Blank inherits the provider timeout. 5 to 900 seconds.</span>
          </div>
          {openRouter && !imageModel ? (
            <div className="border-t border-trace-subtle">
              <SettingRow
                checked={form.dataCollectionAllowed}
                detail="Only when a chosen provider requires it; off keeps prompts out of provider training."
                disabled={busy}
                label="Allow OpenRouter data collection"
                onChange={(next) => update({ dataCollectionAllowed: next })}
              />
            </div>
          ) : null}
        </section>
        {answer ? (
          <section aria-label="Default parameters" className="min-w-0 border-t border-trace-subtle pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">Default parameters</h3>
              <UiV2Button
                aria-describedby={errorField === "defaultParams" ? errorId : undefined}
                disabled={busy}
                onClick={() => setJsonEditing(true)}
                ref={jsonTriggerRef}
                tone="ghost"
                type="button"
              >Edit JSON</UiV2Button>
            </div>
            {/^\{\s*\}$/u.test(form.defaultParamsText.trim()) ? (
              <p className="text-xs text-ink-muted">No custom parameters. Uses provider defaults.</p>
            ) : (
              <pre className="line-clamp-4 max-h-28 whitespace-pre-wrap break-all rounded-control bg-control-surface/60 p-3 font-mono text-xs leading-5 text-ink-secondary" data-testid="model-parameters-preview">
                {form.defaultParamsText.slice(0, 800)}{form.defaultParamsText.length > 800 ? "…" : ""}
              </pre>
            )}
            <p className={helpText}>Edit JSON to read the full configuration. Apply updates this form; Test &amp; Save publishes it.</p>
          </section>
        ) : null}

        {error ? (
          <div className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical">
            <p id={errorId} role="alert">{error}</p>
            {answer && errorField === "configuration" ? (
              <UiV2Button disabled={busy} onClick={() => setJsonEditing(true)} tone="ghost" type="button">Review default parameters</UiV2Button>
            ) : null}
          </div>
        ) : null}
      </form>
      {jsonEditing ? (
        <ModelJsonDialog
          example={JSON.stringify(answer ? { maxOutputTokens: Math.min(1024, form.capabilities.maxOutputTokens ?? 1024) } : {})}
          modelLabel={form.displayName || form.upstreamModelId}
          onApply={(text) => { update({ defaultParamsText: text }); setJsonEditing(false); }}
          onClose={() => setJsonEditing(false)}
          providerLabel={connection.displayName}
          value={form.defaultParamsText}
        />
      ) : null}
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel={model ? "Discard unsaved model changes" : "Discard the new model"}
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="provider-model-discard"
          title={model ? "Discard changes?" : "Discard this model?"}
          tone="warning"
        >
          {model
            ? "The model keeps its current settings."
            : "Nothing has been saved yet."}
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/** The 600 px Add / edit model sheet (PRD 5.4.1). Mount only while open. */
export function AdminProviderModelSheet(props: AdminProviderModelSheetProps & { open: boolean }) {
  if (!props.open) return null;
  const { open: _open, ...rest } = props;
  return <SheetBody {...rest} />;
}

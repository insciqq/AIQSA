"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import {
  reasoningCapabilitiesEqual,
  reasoningCapabilitiesSummary,
  reasoningForChoice,
  applyReasoningCapabilities,
  type AdminProviderReasoningChoice
} from "@/components/admin/adminProviderReasoning";
import { AdminSearchablePicker } from "@/components/admin/AdminSearchablePicker";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { defaultCredentialOf } from "@/components/admin/providers/models/modelListView";
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
                      <span className="block truncate text-[13px] font-medium text-ink">{endpoint ? endpointLabel(endpoint) : tag}</span>
                      {endpoint ? <span className="block truncate font-mono text-metadata text-ink-muted">{endpointDetail(endpoint)}</span> : null}
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
                          <span className="truncate text-[13px] text-ink">{endpointLabel(endpoint)}</span>
                          <span className="shrink-0 font-mono text-metadata text-ink-muted">{endpointDetail(endpoint)}</span>
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
  model,
  onClose,
  onSaved
}: AdminProviderModelSheetProps) {
  const [form, setForm] = useState<ModelForm>(() => model ? modelFormFrom(model) : blankModelForm(connection));
  const [baseline] = useState(form);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const formId = useId();
  const errorId = useId();
  const hintsId = useId();
  const busy = controller.state.busy;
  const family = connection.family;
  const openRouter = family === "openrouter";
  const compatible = family === "openai_compatible";
  const answer = form.modelClass === "answer";
  const defaultCredential = defaultCredentialOf(connection);
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

  useEffect(() => {
    if (!answer || !modelIdentity) return;
    if (openRouter) void discovery.models.load(modelIdentity);
    else if (compatible) void discovery.compatibleModels.load(modelIdentity);
  }, [answer, compatible, discovery.compatibleModels, discovery.models, modelIdentity, openRouter]);

  const update = (patch: Partial<ModelForm>) => {
    setForm({ ...form, ...patch });
    setError(null);
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
  const automaticReasoning = reasoningForChoice("automatic", selectedCompatibleModel ? [selectedCompatibleModel] : []);
  const reasoningChoice: AdminProviderReasoningChoice | "custom" = !form.capabilities.reasoning
    ? "disabled"
    : reasoningCapabilitiesEqual(form.capabilities, automaticReasoning)
      ? "automatic"
      : reasoningCapabilitiesEqual(form.capabilities, reasoningForChoice("openai_gpt_5_6_sol", []))
        ? "openai_gpt_5_6_sol"
        : "custom";

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    const result = modelFormBody(form, connection, model);
    if (!result.ok) {
      if ((result.field === "defaultParams" || result.field === "timeout") && advancedRef.current) {
        advancedRef.current.open = true;
      }
      setError(result.error);
      return;
    }
    setError(null);
    const saved = await controller.actions.saveModel(connection.id, model?.id ?? null, result.body);
    if (saved.ok) {
      onSaved();
      return;
    }
    setError(saved.message);
  };

  const canSave = !busy && form.upstreamModelId.trim() !== "" && (model === null || dirty);
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
      closeBlocked={busy}
      description={`${providerFamilyLabel(family)} · ${checkKeyLabel ? `checked with key ${checkKeyLabel}` : "no default key yet"}`}
      footer={(
        <>
          <UiV2Button busy={busy} disabled={!canSave} form={formId} tone="primary" type="submit">
            Test &amp; Save
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          <span className="min-w-0 text-xs leading-5 text-ink-muted sm:ml-auto sm:text-right">
            {checkKeyLabel
              ? `Checks the model with key ${checkKeyLabel}, then turns it on`
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
        <div className="min-w-0">
          {/* The pickers render their own visible label; keep this one for the read-only id and aria-labelledby. */}
          <span className={answer ? "sr-only" : fieldLabel} id={`${formId}-model-label`}>Model</span>
          {!answer ? (
            <p className="flex min-h-control items-center rounded-control border border-trace-subtle bg-control-surface/60 px-3 font-mono text-xs text-ink-secondary">
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

        {openRouter ? (
          <RoutingField
            connection={connection}
            credentialId={discoveryCredential?.id ?? null}
            disabled={busy || !form.upstreamModelId}
            discovery={discovery}
            form={form}
            setForm={(next) => { setForm(next); setError(null); }}
          />
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

        <details className="group rounded-[10px] border border-trace-subtle bg-control-surface/45 px-3" ref={advancedRef}>
          <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 py-2.5 text-[13px] text-ink-secondary ${focusRing}`}>
            <UiV2Icon className="size-3.5 shrink-0 text-ink-muted transition-transform group-open:rotate-90" name="chevron-right" />
            <span>
              Advanced · timeout{answer ? ", capabilities, default parameters" : ""}
              {compatible && answer ? ", reasoning mapping" : ""}
              {openRouter ? ", data collection" : ""}
            </span>
          </summary>
          <div className="flex flex-col gap-4 border-t border-trace-subtle py-4">
            <div className="min-w-0 sm:max-w-xs">
              <label className="block min-w-0">
                <span className={fieldLabel}>Response timeout (seconds)</span>
                <input
                  className={inputClass}
                  disabled={busy}
                  inputMode="numeric"
                  onChange={(event) => update({ responseTimeoutSeconds: event.currentTarget.value })}
                  placeholder={`Inherit ${connection.draftConfig.responseTimeoutSeconds ?? ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS}`}
                  value={form.responseTimeoutSeconds}
                />
              </label>
              <span className={helpText}>Blank inherits the provider timeout. 5 to 900 seconds.</span>
            </div>
            {answer ? (
              <fieldset className="min-w-0">
                <legend className={fieldLabel}>Capabilities</legend>
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
                              reasoningForChoice(
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
                          <option value="disabled">Not supported</option>
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
            ) : null}
            {compatible && answer && form.capabilities.reasoning ? (
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
            {answer ? (
              <label className="block min-w-0">
                <span className={fieldLabel}>Default parameters (JSON)</span>
                <textarea
                  className={`${inputClass} min-h-24 py-2 font-mono text-xs`}
                  disabled={busy}
                  onChange={(event) => update({ defaultParamsText: event.currentTarget.value })}
                  spellCheck={false}
                  value={form.defaultParamsText}
                />
              </label>
            ) : null}
            {openRouter ? (
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
          </div>
        </details>

        {error ? (
          <p className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </form>
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

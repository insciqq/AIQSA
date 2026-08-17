"use client";

import {
  AdminSearchablePicker,
  type AdminSearchablePickerItem
} from "@/components/admin/AdminSearchablePicker";
import {
  dangerButton,
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import {
  applyReasoningCapabilities,
  reasoningCapabilitiesEqual,
  reasoningCapabilitiesSummary,
  reasoningForChoice,
  type AdminProviderReasoningChoice
} from "@/components/admin/adminProviderReasoning";
import {
  openRouterEndpointDiscoveryIdentity,
  openRouterModelDiscoveryIdentity,
  type AdminOpenRouterDiscoverySession
} from "@/components/admin/useAdminOpenRouterDiscovery";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderAdapterKind,
  AdminProviderConnection,
  AdminProviderModel,
  AdminProviderModelCapabilities
} from "@/lib/contracts/adminProviders";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "@/lib/contracts/adminProviders";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Plus,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-metadata text-ink-muted";
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type ModelForm = {
  adapterKind: AdminProviderAdapterKind;
  answerSelectable: boolean;
  availableInProjects: boolean;
  capabilities: AdminProviderModelCapabilities;
  defaultParamsText: string;
  displayName: string;
  openRouterRoutingMode: "automatic" | "only_selected";
  providerTags: string[];
  reasoningEffortPath: string;
  reasoningModePath: string;
  responseTimeoutSeconds: string;
  upstreamModelId: string;
};

function adapterFor(family: AdminProviderConnection["family"]): AdminProviderAdapterKind {
  if (family === "anthropic") return "anthropic_messages";
  if (family === "gemini") return "gemini_interactions_native";
  if (family === "openrouter") return "openrouter_chat_completions";
  if (family === "openai") return "openai_responses_native";
  return "openai_responses_compatible";
}

export function adminProviderAdapterLabel(kind: AdminProviderAdapterKind): string {
  const labels: Record<AdminProviderAdapterKind, string> = {
    anthropic_messages: "Anthropic Messages",
    gemini_interactions_native: "Gemini Interactions",
    openai_chat_completions_compatible: "Chat Completions",
    openai_embeddings_compatible: "Embeddings (OpenAI-compatible)",
    openai_responses_compatible: "Responses (compatible)",
    openai_responses_native: "Responses (native OpenAI)",
    openrouter_chat_completions: "OpenRouter Chat Completions"
  };
  return labels[kind];
}

function initialCapabilities(
  family: AdminProviderConnection["family"]
): AdminProviderModelCapabilities {
  return {
    backgroundStreaming: family === "openai",
    nativeBackground: family === "openai",
    nativePdfInput: family === "openai",
    nativeSearch: family === "openai" || family === "gemini",
    parallelToolCalls: family !== "gemini",
    pdf: family === "openai" || family === "gemini",
    reasoning: family === "gemini",
    streaming: true,
    toolCalling: true,
    vision: family === "gemini"
  };
}

function credentialCanDiscover(
  credential: AdminProviderConnection["credentials"][number] | undefined
): boolean {
  return Boolean(
    credential?.enabled &&
      (credential.draftSecretConfigured ||
        (credential.activeVersion && credential.activeVersion.revokedAt === null))
  );
}

function blankModel(connection: AdminProviderConnection): ModelForm {
  return {
    adapterKind: adapterFor(connection.family),
    answerSelectable: true,
    availableInProjects: false,
    capabilities: initialCapabilities(connection.family),
    defaultParamsText: "{}",
    displayName: "",
    openRouterRoutingMode: "automatic",
    providerTags: [],
    reasoningEffortPath: compatibleReasoningRequestMappingDefault(
      adapterFor(connection.family) === "openai_responses_compatible"
        ? "responses"
        : "chat_completions"
    ).effortPath,
    reasoningModePath: adapterFor(connection.family) === "openai_responses_compatible"
      ? "reasoning.mode"
      : "",
    responseTimeoutSeconds: "",
    upstreamModelId: ""
  };
}

function existingModel(model: AdminProviderModel): ModelForm {
  const protocol = model.draftConfig.adapterKind === "openai_responses_compatible"
    ? "responses"
    : "chat_completions";
  const mapping = model.draftConfig.reasoningRequestMapping ??
    compatibleReasoningRequestMappingDefault(protocol);
  return {
    adapterKind: model.draftConfig.adapterKind,
    answerSelectable: model.draftConfig.answerSelectable,
    availableInProjects: model.availableInProjects ?? false,
    capabilities: { ...model.draftConfig.capabilities },
    defaultParamsText: JSON.stringify(model.draftConfig.defaultParams, null, 2),
    displayName: model.displayName,
    openRouterRoutingMode: model.draftConfig.openRouterRouting?.mode ?? "automatic",
    providerTags: [...(model.draftConfig.openRouterRouting?.providers ?? [])],
    reasoningEffortPath: mapping.effortPath,
    reasoningModePath: mapping.modePath ?? "",
    responseTimeoutSeconds: model.draftConfig.responseTimeoutSeconds === undefined
      ? ""
      : String(model.draftConfig.responseTimeoutSeconds),
    upstreamModelId: model.draftConfig.upstreamModelId
  };
}

function capabilityFromDiscovery(
  model: AdminOpenRouterDiscoveredModel
): AdminProviderModelCapabilities {
  const parameters = new Set(model.supportedParameters);
  const inputs = new Set(model.inputModalities);
  return {
    ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
    nativePdfInput: false,
    nativeSearch: false,
    parallelToolCalls: parameters.has("tools"),
    pdf: inputs.has("file"),
    reasoning: parameters.has("reasoning"),
    streaming: true,
    toolCalling: parameters.has("tools"),
    vision: inputs.has("image")
  };
}

function modelPickerItem(model: AdminOpenRouterDiscoveredModel): AdminSearchablePickerItem {
  const author = model.id.includes("/") ? model.id.split("/")[0] ?? "" : "";
  return {
    id: model.id,
    keywords: [
      author,
      ...model.inputModalities,
      ...model.outputModalities,
      ...model.supportedParameters
    ],
    label: model.name,
    secondaryText: model.id
  };
}

function endpointLabel(endpoint: AdminOpenRouterDiscoveredEndpoint): string {
  return endpoint.providerName || endpoint.name;
}

function endpointDetail(endpoint: AdminOpenRouterDiscoveredEndpoint): string {
  return [endpoint.tag, endpoint.quantization, endpoint.name]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function moveItem(items: string[], index: number, direction: -1 | 1): string[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  return next;
}

function RouteEditor({
  credentialId,
  discovery,
  form,
  modelIdentity,
  onChange
}: {
  credentialId: string;
  discovery: AdminOpenRouterDiscoverySession;
  form: ModelForm;
  modelIdentity: ReturnType<typeof openRouterModelDiscoveryIdentity>;
  onChange(next: ModelForm): void;
}) {
  const [query, setQuery] = useState("");
  const endpointIdentity = useMemo(
    () => openRouterEndpointDiscoveryIdentity(modelIdentity, form.upstreamModelId),
    [form.upstreamModelId, modelIdentity]
  );
  const endpointState = discovery.endpoints.get(endpointIdentity);

  useEffect(() => {
    if (form.openRouterRoutingMode === "only_selected" && endpointIdentity) {
      void discovery.endpoints.load(endpointIdentity);
    }
  }, [discovery.endpoints, endpointIdentity, form.openRouterRoutingMode]);

  const endpointByTag = useMemo(
    () => new Map(endpointState.items.map((endpoint) => [endpoint.tag, endpoint])),
    [endpointState.items]
  );
  const selected = form.providerTags.map((tag) => ({
    endpoint: endpointByTag.get(tag) ?? null,
    tag
  }));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const available = [...endpointState.items]
    .filter((endpoint) => !form.providerTags.includes(endpoint.tag))
    .filter((endpoint) => !normalizedQuery || [
      endpoint.providerName,
      endpoint.name,
      endpoint.tag,
      endpoint.quantization ?? ""
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) =>
      collator.compare(endpointLabel(left), endpointLabel(right)) ||
      collator.compare(left.tag, right.tag)
    );

  return (
    <fieldset className="grid gap-3">
      <legend className={fieldLabel}>Provider routing</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={`flex min-h-touch items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
          <input
            checked={form.openRouterRoutingMode === "automatic"}
            className="mt-0.5 size-4 shrink-0 accent-proof"
            name="openrouter-routing-mode"
            onChange={() => onChange({
              ...form,
              openRouterRoutingMode: "automatic",
              providerTags: []
            })}
            type="radio"
          />
          <span>
            <span className="block font-medium text-ink">Automatic routing</span>
            <span className="mt-0.5 block leading-4 text-ink-muted">Recommended. OpenRouter chooses a healthy route using the installation safety policy.</span>
          </span>
        </label>
        <label className={`flex min-h-touch items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
          <input
            checked={form.openRouterRoutingMode === "only_selected"}
            className="mt-0.5 size-4 shrink-0 accent-proof"
            name="openrouter-routing-mode"
            onChange={() => onChange({ ...form, openRouterRoutingMode: "only_selected" })}
            type="radio"
          />
          <span>
            <span className="block font-medium text-ink">Only selected providers</span>
            <span className="mt-0.5 block leading-4 text-ink-muted">Use the ordered allowlist below and deny fallback outside it.</span>
          </span>
        </label>
      </div>

      {form.openRouterRoutingMode === "only_selected" ? (
        !credentialId || !form.upstreamModelId ? (
          <p className="text-xs text-ink-muted">Choose a usable key and model before selecting downstream providers.</p>
        ) : (
          <div className="grid gap-3 rounded-control bg-control-surface/60 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h5 className="text-xs font-semibold text-ink">Route priority</h5>
                <p className={helpText}>The first provider is tried first. Tags distinguish endpoints with the same provider name.</p>
              </div>
              <button
                className={quietButton}
                disabled={endpointState.status === "loading"}
                onClick={() => void discovery.endpoints.refresh(endpointIdentity)}
                type="button"
              >
                <RefreshCw aria-hidden="true" className={`size-3.5 ${endpointState.status === "loading" ? "animate-spin" : ""}`} />
                Refresh routes
              </button>
            </div>

            {selected.length ? (
              <ol aria-label="Selected provider route priority" className="grid gap-1">
                {selected.map(({ endpoint, tag }, index) => (
                  <li className="flex min-w-0 items-center gap-2 rounded-control bg-answer-paper px-2 py-1.5" key={tag}>
                    <span className="w-5 shrink-0 text-center font-mono text-metadata text-ink-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-xs font-medium text-ink [overflow-wrap:anywhere]">{endpoint ? endpointLabel(endpoint) : tag}</span>
                      <span className="block break-all font-mono text-metadata text-ink-muted">{endpoint ? endpointDetail(endpoint) : tag}</span>
                    </span>
                    <button aria-label={`Move ${tag} up`} className={quietButton} disabled={index === 0} onClick={() => onChange({ ...form, providerTags: moveItem(form.providerTags, index, -1) })} type="button"><ArrowUp aria-hidden="true" className="size-3" /></button>
                    <button aria-label={`Move ${tag} down`} className={quietButton} disabled={index === form.providerTags.length - 1} onClick={() => onChange({ ...form, providerTags: moveItem(form.providerTags, index, 1) })} type="button"><ArrowDown aria-hidden="true" className="size-3" /></button>
                    <button aria-label={`Remove ${tag} from route`} className={dangerButton} onClick={() => onChange({ ...form, providerTags: form.providerTags.filter((candidate) => candidate !== tag) })} type="button"><X aria-hidden="true" className="size-3" /></button>
                  </li>
                ))}
              </ol>
            ) : <p className="text-xs text-ink-muted">No providers selected yet.</p>}

            {endpointState.status === "loading" && endpointState.items.length === 0 ? <p className="text-xs text-ink-muted" role="status">Loading providers for this model…</p> : null}
            {endpointState.status === "error" ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">
                <span>{endpointState.error}</span>
                <button className={quietButton} onClick={() => void discovery.endpoints.retry(endpointIdentity)} type="button">Retry</button>
              </div>
            ) : null}
            {endpointState.status === "empty" ? <p className="text-xs text-ink-muted" role="status">OpenRouter returned no downstream providers for this model.</p> : null}

            {endpointState.items.length ? (
              <div className="grid gap-2">
                <label>
                  <span className={fieldLabel}>Add downstream provider</span>
                  <span className="flex min-h-control items-center gap-2 rounded-control border border-control-boundary bg-answer-paper px-3 focus-within:ring-2 focus-within:ring-focus">
                    <Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                    <input
                      aria-label="Search downstream providers"
                      className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted"
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder="Search provider, route tag, or endpoint"
                      type="search"
                      value={query}
                    />
                  </span>
                </label>
                <ul aria-label="Available downstream providers" className="grid max-h-52 gap-1 overflow-y-auto overscroll-contain">
                  {available.length ? available.map((endpoint) => (
                    <li key={endpoint.tag}>
                      <button
                        aria-label={`Add route ${endpointLabel(endpoint)} (${endpoint.tag})`}
                        className={`flex min-h-control w-full min-w-0 items-center gap-3 rounded-control bg-answer-paper px-3 py-2 text-left hover:bg-control-hover ${focusRing} ${touchTarget}`}
                        onClick={() => onChange({ ...form, providerTags: [...form.providerTags, endpoint.tag] })}
                        type="button"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-xs font-medium text-ink [overflow-wrap:anywhere]">{endpointLabel(endpoint)}</span>
                          <span className="block break-all font-mono text-metadata text-ink-muted">{endpointDetail(endpoint)}</span>
                        </span>
                        <Plus aria-hidden="true" className="size-3.5 shrink-0 text-proof" />
                      </button>
                    </li>
                  )) : <li><p className="px-3 py-4 text-center text-xs text-ink-muted" role="status">{query.trim() ? `No routes match “${query.trim()}”.` : "All available providers are selected."}</p></li>}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </fieldset>
  );
}

export function AdminProviderModelEditor({
  connection,
  controller,
  discovery,
  editing,
  onClose
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: AdminOpenRouterDiscoverySession;
  editing: AdminProviderModel | null;
  onClose(): void;
}) {
  const [form, setForm] = useState<ModelForm>(() =>
    editing ? existingModel(editing) : blankModel(connection)
  );
  const [baseline] = useState(form);
  const [credentialId, setCredentialId] = useState(() => {
    const defaultCredential = connection.credentials.find(
      ({ id }) => id === connection.defaultCredentialId
    );
    return credentialCanDiscover(defaultCredential)
      ? defaultCredential!.id
      : connection.credentials.find(credentialCanDiscover)?.id ?? "";
  });
  const [formError, setFormError] = useState<string | null>(null);
  const draftDirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const requestDraftDiscard = useAdminDraftProtection({
    dirty: draftDirty,
    onDiscard: () => {
      setForm(baseline);
      setFormError(null);
    },
    owner: "provider-model-editor",
    pending: draftDirty && controller.state.busy
  });
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const reasoningControlId = useId();
  const reasoningHelpId = useId();
  const compatibleAdapters = connection.family === "openai_compatible";
  const credential = connection.credentials.find(({ id }) => id === credentialId) ?? null;
  const modelIdentity = useMemo(
    () => openRouterModelDiscoveryIdentity(connection, credential),
    [connection, credential]
  );
  const modelState = discovery.models.get(modelIdentity);
  const catalogModels = modelState.items;
  const compatibleModelState = discovery.compatibleModels.get(modelIdentity);
  const selectedCompatibleModel = compatibleModelState.items.find(
    ({ id }) => id === form.upstreamModelId
  );
  const automaticReasoning = reasoningForChoice(
    "automatic",
    selectedCompatibleModel ? [selectedCompatibleModel] : []
  );
  const solReasoning = reasoningForChoice("openai_gpt_5_6_sol", []);
  const reasoningChoice: AdminProviderReasoningChoice | "custom" = !form.capabilities.reasoning
    ? "disabled"
    : reasoningCapabilitiesEqual(form.capabilities, automaticReasoning)
      ? "automatic"
      : reasoningCapabilitiesEqual(form.capabilities, solReasoning)
        ? "openai_gpt_5_6_sol"
        : "custom";
  const selectedCatalogModel = catalogModels.find(({ id }) => id === form.upstreamModelId);
  const terminalPath = form.adapterKind.includes("responses")
    ? "responses"
    : form.adapterKind === "gemini_interactions_native"
      ? "interactions"
    : form.adapterKind === "anthropic_messages"
      ? "messages"
      : "chat/completions";

  useEffect(() => {
    if (connection.family === "openrouter" && modelIdentity) {
      void discovery.models.load(modelIdentity);
    } else if (connection.family === "openai_compatible" && modelIdentity) {
      void discovery.compatibleModels.load(modelIdentity);
    }
  }, [connection.family, discovery.compatibleModels, discovery.models, modelIdentity]);

  function updateCapability(
    key: keyof AdminProviderModelCapabilities,
    value: boolean | number | undefined
  ) {
    const capabilities = { ...form.capabilities };
    if (value === undefined) delete capabilities[key];
    else Object.assign(capabilities, { [key]: value });
    setForm({ ...form, capabilities });
  }

  function changeCompatibleAdapter(adapterKind: AdminProviderAdapterKind) {
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
    setForm({
      ...form,
      adapterKind,
      capabilities,
      reasoningEffortPath: mapping.effortPath,
      reasoningModePath: mapping.modePath ?? ""
    });
  }

  function changeReasoning(choice: AdminProviderReasoningChoice) {
    setForm({
      ...form,
      capabilities: applyReasoningCapabilities(
        form.capabilities,
        reasoningForChoice(
          choice,
          selectedCompatibleModel ? [selectedCompatibleModel] : []
        )
      )
    });
  }

  function submit() {
    let defaultParams: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.defaultParamsText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      defaultParams = parsed as Record<string, unknown>;
    } catch {
      if (advancedRef.current) advancedRef.current.open = true;
      setFormError("Default parameters must be one JSON object.");
      return;
    }
    if (
      connection.family === "openrouter" &&
      form.openRouterRoutingMode === "only_selected" &&
      !form.providerTags.length
    ) {
      setFormError("Select at least one downstream provider or use Automatic routing.");
      return;
    }
    if (
      form.responseTimeoutSeconds.trim() && (
        !/^\d+$/u.test(form.responseTimeoutSeconds) ||
        !Number.isSafeInteger(Number(form.responseTimeoutSeconds)) ||
        Number(form.responseTimeoutSeconds) < ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS ||
        Number(form.responseTimeoutSeconds) > ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
      )
    ) {
      setFormError("Model timeout must be blank or a whole value from 5 to 900 seconds.");
      return;
    }
    setFormError(null);
    const body = {
      ...(editing ? { action: "update", expectedDraftVersion: editing.draftVersion } : {}),
      availableInProjects: form.availableInProjects,
      configuration: {
        adapterKind: form.adapterKind,
        answerSelectable: form.answerSelectable,
        capabilities: form.capabilities,
        defaultParams,
        modelClass: "answer" as const,
        ...(connection.family === "openrouter" ? {
          openRouterRouting: form.openRouterRoutingMode === "automatic"
            ? { mode: "automatic" as const, providers: [] as [] }
            : { mode: "only_selected" as const, providers: form.providerTags }
        } : {}),
        ...(compatibleAdapters && form.capabilities.reasoning ? {
          reasoningRequestMapping: {
            effortPath: form.reasoningEffortPath.trim(),
            ...(form.reasoningModePath.trim()
              ? { modePath: form.reasoningModePath.trim() }
              : {})
          }
        } : {}),
        ...(form.responseTimeoutSeconds.trim()
          ? { responseTimeoutSeconds: Number(form.responseTimeoutSeconds) }
          : {}),
        upstreamModelId: form.upstreamModelId
      },
      displayName: form.displayName
    };
    void (editing
      ? controller.actions.updateModel(
          connection.id,
          editing.id,
          body,
          "Model deployment draft saved; prior test evidence is stale."
        )
      : controller.actions.createModel(connection.id, body)
    ).then((ok) => {
      if (ok) onClose();
    });
  }

  return (
    <form
      className="grid gap-4 rounded-control bg-answer-paper p-3"
      id="provider-model-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <h4 className="text-sm font-semibold text-ink">
          {editing ? "Edit model" : "Add model"}
        </h4>
        <p className={helpText}>
          {connection.family === "openrouter"
            ? "Choose a model available to the selected account. AIQSA fills its safe defaults automatically."
            : connection.family === "openai_compatible"
              ? "Choose an ID reported by this endpoint, or enter one manually when /models is unavailable."
            : "Configure the concrete upstream deployment used by this connection."}
        </p>
      </div>

      {connection.family === "openrouter" ? (
        <div className="grid gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            {connection.credentials.length > 1 ? (
              <label className="min-w-0 flex-1">
                <span className={fieldLabel}>Credential used for discovery</span>
                <select
                  className={inputClass}
                  disabled={controller.state.busy}
                  onChange={(event) => setCredentialId(event.currentTarget.value)}
                  value={credentialId}
                >
                  {connection.credentials.map((candidate) => (
                    <option
                      disabled={
                        !candidate.enabled ||
                        (!candidate.draftSecretConfigured &&
                          (!candidate.activeVersion || candidate.activeVersion.revokedAt !== null))
                      }
                      key={candidate.id}
                      value={candidate.id}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="min-w-0 flex-1">
                <span className={fieldLabel}>Models available to credential</span>
                <p className="break-words text-sm text-ink">
                  {credential?.label ?? "No usable credential"}
                </p>
              </div>
            )}
            <button
              className={quietButton}
              disabled={!modelIdentity || modelState.status === "loading"}
              onClick={() => void discovery.models.refresh(modelIdentity)}
              type="button"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-3.5 ${modelState.status === "loading" ? "animate-spin" : ""}`}
              />
              Refresh catalog
            </button>
          </div>

          <AdminSearchablePicker
            description="Search the account-filtered OpenRouter catalog by display name, provider, capability, or raw model id."
            disabled={!modelIdentity}
            emptyDescription="This credential returned an empty model catalog. Refresh it or review the OpenRouter account policy."
            emptyTitle="No models available to this credential"
            error={modelState.error}
            items={catalogModels.map(modelPickerItem)}
            label="OpenRouter model"
            loading={modelState.status === "loading"}
            noun={{ plural: "models", singular: "model" }}
            onRetry={() => void discovery.models.retry(modelIdentity)}
            onSelect={(item) => {
              const model = catalogModels.find(({ id }) => id === item.id);
              if (!model) return;
              setForm({
                ...form,
                capabilities: capabilityFromDiscovery(model),
                displayName: model.name,
                openRouterRoutingMode: "automatic",
                providerTags: [],
                upstreamModelId: model.id
              });
            }}
            placeholder="Choose a model"
            searchPlaceholder="Search name, provider, capability, or model id"
            selectedFallbackLabel={form.displayName || "Configured model"}
            selectedId={form.upstreamModelId || null}
          />

          {form.upstreamModelId ? (
            <RouteEditor
              credentialId={credentialId}
              discovery={discovery}
              form={form}
              modelIdentity={modelIdentity}
              onChange={setForm}
            />
          ) : null}

          {selectedCatalogModel ? (
            <p className="rounded-control bg-control-surface px-3 py-2 text-xs leading-5 text-ink-secondary">
              {selectedCatalogModel.contextLength
                ? `${selectedCatalogModel.contextLength.toLocaleString()} context tokens`
                : "Context not reported"}
              {selectedCatalogModel.supportedParameters.length
                ? ` · ${selectedCatalogModel.supportedParameters.join(", ")}`
                : ""}
            </p>
          ) : null}

          <label>
            <span className={fieldLabel}>Deployment name</span>
            <input
              className={inputClass}
              disabled={controller.state.busy}
              maxLength={160}
              onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })}
              required
              value={form.displayName}
            />
            <span className={helpText}>
              Shown to administrators and entitled users; the upstream id remains available in Advanced.
            </span>
          </label>
        </div>
      ) : (
        <div className="grid gap-3">
          {compatibleAdapters ? (
            <div className="grid gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                {connection.credentials.length > 1 ? (
                  <label className="min-w-0 flex-1">
                    <span className={fieldLabel}>Credential used for discovery</span>
                    <select
                      className={inputClass}
                      disabled={controller.state.busy}
                      onChange={(event) => setCredentialId(event.currentTarget.value)}
                      value={credentialId}
                    >
                      {connection.credentials.map((candidate) => (
                        <option
                          disabled={!credentialCanDiscover(candidate)}
                          key={candidate.id}
                          value={candidate.id}
                        >
                          {candidate.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="min-w-0 flex-1">
                    <span className={fieldLabel}>Models available to credential</span>
                    <p className="break-words text-sm text-ink">
                      {credential?.label ?? "No usable credential"}
                    </p>
                  </div>
                )}
                <button
                  className={quietButton}
                  disabled={!modelIdentity || compatibleModelState.status === "loading"}
                  onClick={() => void discovery.compatibleModels.refresh(modelIdentity)}
                  type="button"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={`size-3.5 ${compatibleModelState.status === "loading" ? "animate-spin" : ""}`}
                  />
                  Refresh catalog
                </button>
              </div>

              <AdminSearchablePicker
                description="Search the bounded IDs reported by this endpoint's /models catalog. Selecting an ID also applies bounded context and reasoning metadata when available."
                disabled={!modelIdentity}
                emptyDescription="This endpoint returned no model IDs. Refresh it, review the credential, or enter an exact ID manually below."
                emptyTitle="No models reported by this endpoint"
                error={compatibleModelState.error}
                items={compatibleModelState.items.map((model) => ({
                  id: model.id,
                  label: model.id,
                  secondaryText: "Reported by /models"
                }))}
                label="Endpoint model"
                loading={compatibleModelState.status === "loading"}
                noun={{ plural: "models", singular: "model" }}
                onRetry={() => void discovery.compatibleModels.retry(modelIdentity)}
                onSelect={(model) => {
                  const discovered = compatibleModelState.items.find(({ id }) => id === model.id);
                  const capabilities = applyReasoningCapabilities(
                    form.capabilities,
                    reasoningForChoice("automatic", discovered ? [discovered] : [])
                  );
                  setForm({
                    ...form,
                    capabilities: {
                      ...capabilities,
                      ...(discovered?.capabilities?.contextWindow
                        ? { contextWindow: discovered.capabilities.contextWindow }
                        : {}),
                      ...(discovered?.capabilities?.defaultMaxOutputTokens
                        ? { defaultMaxOutputTokens: discovered.capabilities.defaultMaxOutputTokens }
                        : {})
                    },
                    displayName: model.id,
                    upstreamModelId: model.id
                  });
                }}
                placeholder="Choose a reported model"
                searchPlaceholder="Search model IDs"
                selectedFallbackLabel={form.upstreamModelId || "Configured model"}
                selectedId={form.upstreamModelId || null}
              />
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className={fieldLabel}>Display name</span>
              <input className={inputClass} disabled={controller.state.busy} maxLength={160} onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })} required value={form.displayName} />
            </label>
            <label>
              <span className={fieldLabel}>Upstream model ID</span>
              <input className={`${inputClass} font-mono text-xs`} disabled={controller.state.busy} maxLength={256} onChange={(event) => setForm({ ...form, upstreamModelId: event.currentTarget.value })} required value={form.upstreamModelId} />
            </label>
            {compatibleAdapters ? (
              <label className="md:col-span-2">
                <span className={fieldLabel}>Protocol</span>
                <select className={inputClass} disabled={controller.state.busy} onChange={(event) => changeCompatibleAdapter(event.currentTarget.value as AdminProviderAdapterKind)} value={form.adapterKind}>
                  <option value="openai_responses_compatible">Responses</option>
                  <option value="openai_chat_completions_compatible">Chat Completions</option>
                </select>
                <span className={helpText}>Required explicitly; compatible authentication does not prove the wire protocol.</span>
              </label>
            ) : null}
          </div>
        </div>
      )}

      <label className={`flex min-h-touch items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
        <input
          checked={form.answerSelectable}
          className="mt-0.5 size-4 shrink-0 accent-proof"
          disabled={controller.state.busy}
          onChange={(event) => setForm({
            ...form,
            answerSelectable: event.currentTarget.checked
          })}
          type="checkbox"
        />
        <span>
          <span className="block font-medium text-ink">Available as answer model</span>
          <span className="mt-0.5 block leading-4 text-ink-muted">
            Turn this off for a technical runtime used only by Search. Search integrations can still use it after activation.
          </span>
        </span>
      </label>

      <label className={`flex min-h-touch items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
        <input
          checked={form.availableInProjects}
          className="mt-0.5 size-4 shrink-0 accent-proof"
          disabled={controller.state.busy}
          onChange={(event) => setForm({
            ...form,
            availableInProjects: event.currentTarget.checked
          })}
          type="checkbox"
        />
        <span>
          <span className="block font-medium text-ink">Available in Projects</span>
          <span className="mt-0.5 block leading-4 text-ink-muted">
            Project runs use the installation default credential; member grants and personal credentials are ignored.
          </span>
        </span>
      </label>

      <label className="max-w-md">
        <span className={fieldLabel}>Response timeout override (seconds)</span>
        <input
          className={inputClass}
          disabled={controller.state.busy}
          max={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS}
          min={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS}
          onChange={(event) => setForm({
            ...form,
            responseTimeoutSeconds: event.currentTarget.value
          })}
          placeholder={`Inherit ${connection.draftConfig.responseTimeoutSeconds ?? ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS}`}
          step={1}
          type="number"
          value={form.responseTimeoutSeconds}
        />
        <span className={helpText}>
          Blank inherits the connection. Effective deadline: {form.responseTimeoutSeconds.trim() ||
            connection.draftConfig.responseTimeoutSeconds ||
            ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS} seconds, for buffered and streamed responses. Allowed override: 5–900.
        </span>
      </label>

      {compatibleAdapters ? (
        <section className="grid gap-3 rounded-control border border-trace-subtle bg-answer-paper p-3" aria-labelledby="compatible-model-features">
          <div>
            <h4 className="text-xs font-semibold text-ink" id="compatible-model-features">OpenAI-compatible model features</h4>
            <p className={helpText}>These controls are part of the model and request contract after activation.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={fieldLabel} htmlFor={reasoningControlId}>Reasoning controls</label>
              <select
                aria-describedby={reasoningHelpId}
                className={inputClass}
                disabled={controller.state.busy}
                id={reasoningControlId}
                onChange={(event) => changeReasoning(event.currentTarget.value as AdminProviderReasoningChoice)}
                value={reasoningChoice}
              >
                {reasoningChoice === "custom" ? <option value="custom" disabled>Current custom metadata</option> : null}
                <option value="automatic">Use reported metadata; GPT-5.6 Sol fallback</option>
                <option value="openai_gpt_5_6_sol">OpenAI GPT-5.6 Sol profile</option>
                <option value="disabled">Not supported</option>
              </select>
              <p className={helpText} id={reasoningHelpId}>{reasoningCapabilitiesSummary(form.capabilities)}</p>
            </div>
            <label className={`flex min-h-control items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
              <input
                checked={form.capabilities.nativeSearch === true}
                className="mt-0.5 size-4 shrink-0 accent-proof"
                disabled={controller.state.busy}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  const capabilities = {
                    ...form.capabilities,
                    nativeSearch: enabled
                  };
                  if (enabled) delete capabilities.streamUsage;
                  setForm({
                    ...form,
                    adapterKind: enabled
                      ? "openai_responses_compatible"
                      : form.adapterKind,
                    capabilities,
                    ...(enabled && form.adapterKind !== "openai_responses_compatible"
                      ? {
                          reasoningEffortPath: "reasoning.effort",
                          reasoningModePath: "reasoning.mode"
                        }
                      : {})
                  });
                }}
                type="checkbox"
              />
              <span>
                <span className="block font-medium text-ink">Hosted web search (`web_search`)</span>
                <span className="mt-0.5 block leading-4 text-ink-muted">Enabling this selects Responses, where AIQSA can serialize the hosted tool and citations.</span>
              </span>
            </label>
            {form.adapterKind === "openai_chat_completions_compatible" ? (
              <label className={`flex min-h-control items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
                <input
                  checked={form.capabilities.streamUsage === true}
                  className="mt-0.5 size-4 shrink-0 accent-proof"
                  disabled={controller.state.busy}
                  onChange={(event) => updateCapability(
                    "streamUsage",
                    event.currentTarget.checked || undefined
                  )}
                  type="checkbox"
                />
                <span>
                  <span className="block font-medium text-ink">Streaming usage totals</span>
                  <span className="mt-0.5 block leading-4 text-ink-muted">
                    Sends `stream_options.include_usage`; enable only when this endpoint supports it.
                  </span>
                </span>
              </label>
            ) : null}
            {form.capabilities.reasoning ? (
              <div className="grid gap-3 rounded-control border border-trace-subtle bg-control-surface/45 p-3 md:col-span-2 md:grid-cols-2">
                <label>
                  <span className={fieldLabel}>Reasoning effort field</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    disabled={controller.state.busy}
                    maxLength={128}
                    onChange={(event) => setForm({
                      ...form,
                      reasoningEffortPath: event.currentTarget.value
                    })}
                    required
                    value={form.reasoningEffortPath}
                  />
                  <span className={helpText}>Outbound dot path, for example `effort`, `reason`, or `reasoning.effort`.</span>
                </label>
                <label>
                  <span className={fieldLabel}>Reasoning mode field (optional)</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    disabled={controller.state.busy}
                    maxLength={128}
                    onChange={(event) => setForm({
                      ...form,
                      reasoningModePath: event.currentTarget.value
                    })}
                    placeholder="Blank means no mode is sent"
                    value={form.reasoningModePath}
                  />
                  <span className={helpText}>Configure this when the gateway accepts `standard` / `pro` or equivalent modes.</span>
                </label>
                <p className="break-words font-mono text-metadata text-ink-muted md:col-span-2">
                  Effort → {form.reasoningEffortPath.trim() || "missing"} · Mode → {form.reasoningModePath.trim() || "not sent"}
                </p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <details className="group rounded-control bg-control-surface/60" ref={advancedRef}>
        <summary className={`flex min-h-control cursor-pointer list-none items-center justify-between gap-3 rounded-control px-3 py-2 text-xs font-medium text-ink-secondary hover:bg-control-hover ${focusRing} ${touchTarget}`}>
          <span>Advanced model settings</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-trace-subtle p-3">
          <p className="text-xs leading-5 text-ink-muted">
            Override inferred capabilities or request defaults only when the upstream contract requires it.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {connection.family === "openrouter" ? (
              <label><span className={fieldLabel}>Upstream model ID</span><input className={`${inputClass} font-mono text-xs`} readOnly value={form.upstreamModelId} /></label>
            ) : null}
            <label><span className={fieldLabel}>Protocol</span><input className={inputClass} readOnly value={adminProviderAdapterLabel(form.adapterKind)} /></label>
            <label><span className={fieldLabel}>Context window (optional)</span><input className={inputClass} disabled={controller.state.busy} min="1" onChange={(event) => updateCapability("contextWindow", event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} type="number" value={form.capabilities.contextWindow ?? ""} /></label>
            <label><span className={fieldLabel}>Final request endpoint</span><input className={`${inputClass} font-mono text-xs`} readOnly value={`${connection.draftConfig.apiRoot}/${terminalPath}`} /></label>
          </div>
          <fieldset>
            <legend className={fieldLabel}>Capability overrides</legend>
            <div className="flex flex-wrap gap-2">
              {([['reasoning', 'Reasoning'], ['vision', 'Vision'], ['pdf', 'PDF'], ['nativePdfInput', 'Native PDF input'], ['nativeSearch', 'Search'], ['toolCalling', 'Tools'], ['streaming', 'Streaming'], ['parallelToolCalls', 'Parallel tools']] as const)
                .filter(([key]) => !compatibleAdapters || (key !== "reasoning" && key !== "nativeSearch"))
                .map(([key, label]) => (
                <label className={`flex min-h-control items-center gap-2 rounded-control bg-answer-paper px-3 text-xs text-ink-secondary ${touchTarget}`} key={key}>
                  <input checked={form.capabilities[key] === true} className="size-4 accent-proof" disabled={controller.state.busy} onChange={(event) => updateCapability(key, event.currentTarget.checked)} type="checkbox" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            <span className={fieldLabel}>Default request parameters (JSON object)</span>
            <textarea className={`${inputClass} min-h-24 py-2 font-mono text-xs`} disabled={controller.state.busy} onChange={(event) => setForm({ ...form, defaultParamsText: event.currentTarget.value })} value={form.defaultParamsText} />
          </label>
        </div>
      </details>

      {formError ? <p className="text-xs text-critical" role="alert">{formError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={controller.state.busy || !form.displayName.trim() || !form.upstreamModelId.trim()} type="submit">Save model</button>
        <button
          className={quietButton}
          disabled={controller.state.busy}
          onClick={() => requestDraftDiscard(onClose)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

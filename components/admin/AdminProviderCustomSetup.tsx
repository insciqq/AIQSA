"use client";

import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { AdminSearchablePicker } from "@/components/admin/AdminSearchablePicker";
import {
  reasoningCapabilitiesSummary,
  reasoningForChoice
} from "@/components/admin/adminProviderReasoning";
import type { AdminProviderCustomSetupController } from "@/components/admin/useAdminProviderCustomSetupController";
import { MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS } from "@/lib/contracts/adminProviderCustomSetup";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "@/lib/contracts/adminProviders";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import { ArrowLeft, ChevronDown, KeyRound, ServerCog, X } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-metadata text-ink-muted";

export type AdminProviderCustomSetupProps = Readonly<{
  controller: AdminProviderCustomSetupController;
  onBack(): void;
  onManageConnection(connectionId: string): void;
}>;

function requestEndpoint(apiRoot: string, protocol: "chat_completions" | "responses"): string {
  const root = apiRoot.trim().replace(/\/+$/u, "");
  const path = protocol === "responses" ? "responses" : "chat/completions";
  return root ? `${root}/${path}` : `API root + /${path}`;
}

export function AdminProviderCustomSetup({
  controller,
  onBack,
  onManageConnection
}: AdminProviderCustomSetupProps) {
  const reasoningControlId = useId();
  const reasoningHelpId = useId();
  const { form, ready } = controller.state;

  if (ready) {
    return (
      <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <section className="max-w-3xl border-t-2 border-positive pt-5">
          <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-positive">
            Ready to chat
          </p>
          <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink">
            {ready.models.length === 1
              ? ready.modelDisplayName
              : `${ready.models.length} models are ready`}
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">
            The custom OpenAI-compatible endpoint passed {ready.models.length === 1
              ? "its exact model test"
              : `all ${ready.models.length} exact model tests`} and is available to your administrator account.
          </p>
          <div
            className="mt-4 border-l-2 border-positive/50 pl-3 text-xs leading-5 text-ink-secondary"
            data-testid="provider-custom-ready-receipt"
          >
            <p>Connection: {ready.connectionDisplayName}.</p>
            <p>
              Authentication: {ready.authenticationMode === "bearer"
                ? "API key saved and verified."
                : "No API key is sent to this private endpoint."}
            </p>
            <p>Access: assigned directly to this administrator.</p>
            <p>
              Models: {ready.models.map(({ modelDisplayName }) => modelDisplayName).join(", ")}.
            </p>
            <p>Default models: unchanged. Choose one explicitly in chat or the Default model task.</p>
            {ready.search ? (
              <p>
                {ready.search.displayName}: {ready.search.status === "ready"
                  ? "ready for supported models"
                  : "requires attention; finish setup in Search"}.
              </p>
            ) : null}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link className={primaryButton} href="/">Start chatting</Link>
            <button
              className={quietButton}
              onClick={() => onManageConnection(ready.connectionId)}
              type="button"
            >
              Manage connection
            </button>
            <button className={quietButton} onClick={onBack} type="button">
              Add another provider
            </button>
            {ready.search ? (
              <Link className={quietButton} href="/admin?section=search">
                Manage Search
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  const noKey = !form.secret.trim();
  const endpoint = requestEndpoint(form.apiRoot, form.protocol);
  const discoveredModels = controller.state.discoveredModels ?? [];
  const hasDiscoveredCatalog = discoveredModels.length > 0;
  const availableDiscoveredModels = discoveredModels.filter(
    ({ id }) => !form.selectedModelIds.includes(id)
  );
  const selectedDiscoveredModels = discoveredModels.filter(({ id }) =>
    form.selectedModelIds.includes(id)
  );
  const selectedReasoning = reasoningForChoice(
    form.reasoningChoice,
    selectedDiscoveredModels
  );
  const noKeyAllowed = form.allowPrivateNetwork && (() => {
    try {
      return new URL(form.apiRoot.trim()).protocol === "http:";
    } catch {
      return false;
    }
  })() && form.protocol === "chat_completions";

  return (
    <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-4xl">
        <button className={quietButton} onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Back to Quick setup
        </button>

        <div className="mt-5 max-w-3xl">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-proof/10 text-proof">
              <ServerCog aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight text-ink">
                Connect a custom endpoint
              </h2>
              <p className="mt-1 text-sm leading-6 text-ink-secondary">
                Discover models from an OpenAI-compatible endpoint, choose one or more, then let AIQSA test every selected model before saving anything.
              </p>
            </div>
          </div>
        </div>

        <form
          className="mt-6 grid max-w-3xl gap-5 border-t border-trace-subtle pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.actions.submit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <label className="md:col-span-2">
              <span className={fieldLabel}>API root</span>
              <input
                autoComplete="url"
                className={`${inputClass} font-mono text-xs`}
                disabled={controller.state.formLocked}
                onChange={(event) => controller.actions.update({
                  apiRoot: event.currentTarget.value
                })}
                placeholder="https://llm.example.com/v1"
                required
                type="url"
                value={form.apiRoot}
              />
              <span className={helpText}>
                Enter the API root, not the terminal request path. Embedded credentials, query strings, and fragments are rejected.
              </span>
            </label>
            <label>
              <span className={fieldLabel}>API key</span>
              <span className="relative block">
                <KeyRound
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
                />
                <input
                  autoComplete="new-password"
                  className={`${inputClass} pl-9 font-mono`}
                  disabled={controller.state.formLocked}
                  onChange={(event) => controller.actions.update({
                    secret: event.currentTarget.value
                  })}
                  placeholder="Required for hosted endpoints"
                  type="password"
                  value={form.secret}
                />
              </span>
              <span className={helpText}>
                Write-only. It may be empty only for an explicitly allowed local/private HTTP endpoint.
              </span>
            </label>
            <div className="flex items-end">
              <button
                className={`${quietButton} w-full justify-center`}
                disabled={
                  controller.state.formLocked ||
                  !form.apiRoot.trim() ||
                  (noKey && !noKeyAllowed)
                }
                onClick={() => void controller.actions.discoverModels()}
                type="button"
              >
                {controller.state.discovering ? "Discovering models…" : "Discover models"}
              </button>
            </div>
          </div>

          <div className="rounded-control border border-trace-subtle bg-control-surface/40 p-3">
            {hasDiscoveredCatalog ? (
              <div className="grid gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className={fieldLabel}>Selected models</p>
                    <p className="text-metadata text-ink-muted">
                      {form.selectedModelIds.length} of {discoveredModels.length} selected · up to {MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS}. The first selection is used as the primary setup model.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <button
                      className={quietButton}
                      disabled={controller.state.formLocked || form.selectedModelIds.length === Math.min(
                        discoveredModels.length,
                        MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS
                      )}
                      onClick={controller.actions.selectAllDiscoveredModels}
                      type="button"
                    >
                      {discoveredModels.length > MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS
                        ? `Select first ${MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS}`
                        : "Select all"}
                    </button>
                    <button
                      className={quietButton}
                      disabled={controller.state.formLocked || form.selectedModelIds.length === 0}
                      onClick={controller.actions.clearDiscoveredModels}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {availableDiscoveredModels.length > 0 &&
                form.selectedModelIds.length < MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS ? (
                  <AdminSearchablePicker
                    description="Catalog entries are discovery evidence only. AIQSA saves and tests only the IDs you explicitly add."
                    disabled={controller.state.formLocked}
                    items={availableDiscoveredModels.map((model) => ({
                      id: model.id,
                      label: model.id,
                      secondaryText: "Reported by /models"
                    }))}
                    label={`Add models reported by this endpoint (${discoveredModels.length})`}
                    noun={{ plural: "models", singular: "model" }}
                    onSelect={(model) => controller.actions.selectDiscoveredModel(model.id)}
                    placeholder="Add a model"
                    searchPlaceholder="Search model IDs"
                    selectedId={null}
                  />
                ) : null}

                {form.selectedModelIds.length ? (
                  <div aria-label="Models selected for setup" className="divide-y divide-trace-subtle rounded-control bg-answer-paper" role="list">
                    {form.selectedModelIds.map((modelId, index) => (
                      <div
                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                        key={modelId}
                        role="listitem"
                      >
                        <span className="min-w-0">
                          <span className="block break-all font-mono text-xs text-ink">{modelId}</span>
                          {index === 0 ? (
                            <span className="mt-0.5 block text-metadata text-ink-muted">Primary setup model</span>
                          ) : null}
                        </span>
                        <button
                          aria-label={`Remove ${modelId}`}
                          className={quietButton}
                          disabled={controller.state.formLocked}
                          onClick={() => controller.actions.removeDiscoveredModel(modelId)}
                          type="button"
                        >
                          <X aria-hidden="true" className="size-3.5" />
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="border-l-2 border-caution pl-3 text-xs leading-5 text-caution" role="status">
                    Choose at least one reported model before Test & Save.
                  </p>
                )}
              </div>
            ) : (
              <label>
                <span className={fieldLabel}>Model ID</span>
                <input
                  className={`${inputClass} font-mono text-xs`}
                  disabled={controller.state.formLocked}
                  maxLength={256}
                  onChange={(event) => controller.actions.update({
                    modelId: event.currentTarget.value
                  })}
                  placeholder="vendor/model-name"
                  required
                  value={form.modelId}
                />
                <span className={helpText}>
                  Discover models first when the endpoint supports /models, or enter an exact ID manually.
                </span>
              </label>
            )}
            {controller.state.discoveryError ? (
              <p className="mt-2 border-l-2 border-caution pl-3 text-xs leading-5 text-caution" role="status">
                {controller.state.discoveryError}
              </p>
            ) : null}
          </div>

          <div className="rounded-control bg-control-surface/60 px-3 py-2.5">
            <p className="text-metadata font-medium uppercase tracking-[0.08em] text-ink-muted">
              Request endpoint
            </p>
            <p className="mt-1 break-all font-mono text-xs text-ink-secondary">
              {endpoint}
            </p>
          </div>

          <details className="group rounded-control bg-control-surface/60">
            <summary className="flex min-h-control cursor-pointer list-none items-center justify-between gap-3 rounded-control px-3 py-2 text-xs font-medium text-ink-secondary hover:bg-control-hover">
              <span>Advanced settings</span>
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 group-open:rotate-180"
              />
            </summary>
            <div className="grid gap-4 border-t border-trace-subtle p-3 md:grid-cols-2">
              <label className="flex min-h-touch items-start gap-3 rounded-control bg-caution/10 px-3 py-2.5 text-xs leading-5 text-caution md:col-span-2">
                <input
                  checked={form.allowPrivateNetwork}
                  className="mt-0.5 size-4 shrink-0 accent-proof"
                  disabled={controller.state.formLocked}
                  onChange={(event) => controller.actions.update({
                    allowPrivateNetwork: event.currentTarget.checked
                  })}
                  type="checkbox"
                />
                Allow only this exact configured private or local endpoint. This also permits HTTP and an empty API-key field; DNS and destination checks still fail closed.
              </label>
              <label>
                <span className={fieldLabel}>Response timeout (seconds)</span>
                <input
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  max={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS}
                  min={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS}
                  onChange={(event) => controller.actions.update({
                    responseTimeoutSeconds: event.currentTarget.value
                  })}
                  required
                  step={1}
                  type="number"
                  value={form.responseTimeoutSeconds}
                />
                <span className={helpText}>
                  Complete provider-response deadline, including streamed responses. Allowed range: 5–900 seconds.
                </span>
              </label>
              <label>
                <span className={fieldLabel}>OpenAI-compatible protocol</span>
                <select
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  onChange={(event) => {
                    const protocol = event.currentTarget.value === "responses"
                      ? "responses" as const
                      : "chat_completions" as const;
                    controller.actions.update({
                      protocol,
                      reasoningEffortPath:
                        compatibleReasoningRequestMappingDefault(protocol).effortPath,
                      reasoningModePath:
                        compatibleReasoningRequestMappingDefault(protocol).modePath ?? "",
                      ...(protocol === "chat_completions"
                        ? { imageGeneration: false, webSearch: false }
                        : {})
                    });
                  }}
                  value={form.protocol}
                >
                  <option value="chat_completions">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
                <span className={helpText}>
                  Hosted tools require Responses and bearer authentication.
                </span>
              </label>
              <div>
                <label className={fieldLabel} htmlFor={reasoningControlId}>Reasoning controls</label>
                <select
                  aria-describedby={reasoningHelpId}
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  id={reasoningControlId}
                  onChange={(event) => controller.actions.update({
                    reasoningChoice: event.currentTarget.value as typeof form.reasoningChoice
                  })}
                  value={form.reasoningChoice}
                >
                  <option value="automatic">Use reported metadata; GPT-5.6 Sol fallback</option>
                  <option value="openai_gpt_5_6_sol">OpenAI GPT-5.6 Sol profile</option>
                  <option value="disabled">Not supported</option>
                </select>
                <p className={helpText} id={reasoningHelpId}>{reasoningCapabilitiesSummary(selectedReasoning)}</p>
              </div>
              {selectedReasoning.reasoning ? (
                <div className="grid gap-3 rounded-control border border-trace-subtle bg-answer-paper p-3 md:col-span-2 md:grid-cols-2">
                  <label>
                    <span className={fieldLabel}>Reasoning effort field</span>
                    <input
                      className={`${inputClass} font-mono text-xs`}
                      disabled={controller.state.formLocked}
                      maxLength={128}
                      onChange={(event) => controller.actions.update({
                        reasoningEffortPath: event.currentTarget.value
                      })}
                      placeholder={form.protocol === "responses" ? "reasoning.effort" : "reasoning_effort"}
                      required
                      value={form.reasoningEffortPath}
                    />
                    <span className={helpText}>Dot path used in the outbound request, for example `effort`, `reason`, or `reasoning.effort`.</span>
                  </label>
                  <label>
                    <span className={fieldLabel}>Reasoning mode field (optional)</span>
                    <input
                      className={`${inputClass} font-mono text-xs`}
                      disabled={controller.state.formLocked}
                      maxLength={128}
                      onChange={(event) => controller.actions.update({
                        reasoningModePath: event.currentTarget.value
                      })}
                      placeholder={form.protocol === "responses" ? "reasoning.mode" : "Not sent by default"}
                      value={form.reasoningModePath}
                    />
                    <span className={helpText}>Set this only when the endpoint accepts modes such as `standard` and `pro`; blank means no mode is sent.</span>
                  </label>
                  <p className="break-words font-mono text-metadata text-ink-muted md:col-span-2">
                    Effort → {form.reasoningEffortPath.trim() || "missing"} · Mode → {form.reasoningModePath.trim() || "not sent"}
                  </p>
                </div>
              ) : null}
              <div className="rounded-control border border-trace-subtle bg-answer-paper p-3">
                <p className={fieldLabel}>Hosted tools declared by the administrator</p>
                <label className="flex min-h-control items-center gap-2 text-xs text-ink-secondary">
                  <input
                    checked={form.webSearch}
                    className="size-4 accent-proof"
                    disabled={controller.state.formLocked}
                    onChange={(event) => controller.actions.update({
                      ...(event.currentTarget.checked && form.protocol !== "responses"
                        ? {
                            protocol: "responses" as const,
                            reasoningEffortPath: "reasoning.effort",
                            reasoningModePath: "reasoning.mode"
                          }
                        : {}),
                      webSearch: event.currentTarget.checked
                    })}
                    type="checkbox"
                  />
                  Hosted web search
                </label>
                <label className="flex min-h-control items-center gap-2 text-xs text-ink-secondary">
                  <input
                    checked={form.imageGeneration}
                    className="size-4 accent-proof"
                    disabled={controller.state.formLocked}
                    onChange={(event) => controller.actions.update({
                      imageGeneration: event.currentTarget.checked,
                      ...(event.currentTarget.checked && form.protocol !== "responses"
                        ? {
                            protocol: "responses" as const,
                            reasoningEffortPath: "reasoning.effort",
                            reasoningModePath: "reasoning.mode"
                          }
                        : {})
                    })}
                    type="checkbox"
                  />
                  Image generation (future workflows)
                </label>
                <p className="mt-1 text-metadata text-ink-muted">
                  Web search is available in chat. Image support is recorded now but is not yet runnable.
                </p>
              </div>
              <label>
                <span className={fieldLabel}>Connection name (optional)</span>
                <input
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  maxLength={160}
                  onChange={(event) => controller.actions.update({
                    connectionDisplayName: event.currentTarget.value
                  })}
                  placeholder="Derived from hostname"
                  value={form.connectionDisplayName}
                />
              </label>
              {!hasDiscoveredCatalog || form.selectedModelIds.length <= 1 ? (
                <label>
                  <span className={fieldLabel}>Model name (optional)</span>
                  <input
                    className={inputClass}
                    disabled={controller.state.formLocked}
                    maxLength={160}
                    onChange={(event) => controller.actions.update({
                      modelDisplayName: event.currentTarget.value
                    })}
                    placeholder="Uses model ID"
                    value={form.modelDisplayName}
                  />
                </label>
              ) : (
                <div className="rounded-control bg-answer-paper px-3 py-2.5 text-xs leading-5 text-ink-muted">
                  Multiple selected models use their exact upstream IDs as display names. You can rename them later in Connections → Models.
                </div>
              )}
              <label>
                <span className={fieldLabel}>Context window</span>
                <input
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  min="1"
                  onChange={(event) => controller.actions.update({
                    contextWindow: Number(event.currentTarget.value)
                  })}
                  type="number"
                  value={form.contextWindow}
                />
              </label>
              <label>
                <span className={fieldLabel}>Default max output</span>
                <input
                  className={inputClass}
                  disabled={controller.state.formLocked}
                  min="1"
                  onChange={(event) => controller.actions.update({
                    defaultMaxOutputTokens: Number(event.currentTarget.value)
                  })}
                  type="number"
                  value={form.defaultMaxOutputTokens}
                />
              </label>
              <div className="flex flex-wrap gap-2 md:col-span-2">
                <label className="flex min-h-control items-center gap-2 rounded-control bg-answer-paper px-3 text-xs text-ink-secondary">
                  <input
                    checked={form.streaming}
                    className="size-4 accent-proof"
                    disabled={controller.state.formLocked}
                    onChange={(event) => controller.actions.update({
                      streaming: event.currentTarget.checked
                    })}
                    type="checkbox"
                  />
                  Streaming
                </label>
                <label className="flex min-h-control items-center gap-2 rounded-control bg-answer-paper px-3 text-xs text-ink-secondary">
                  <input
                    checked={form.toolCalling}
                    className="size-4 accent-proof"
                    disabled={controller.state.formLocked}
                    onChange={(event) => controller.actions.update({
                      toolCalling: event.currentTarget.checked
                    })}
                    type="checkbox"
                  />
                  Tool calling
                </label>
                {form.protocol === "chat_completions" ? (
                  <label className="flex min-h-control items-start gap-2 rounded-control bg-answer-paper px-3 py-2 text-xs text-ink-secondary">
                    <input
                      checked={form.streamUsage}
                      className="mt-0.5 size-4 shrink-0 accent-proof"
                      disabled={controller.state.formLocked}
                      onChange={(event) => controller.actions.update({
                        streamUsage: event.currentTarget.checked
                      })}
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
              </div>
            </div>
          </details>

          {noKey && !noKeyAllowed ? (
            <p className="border-l-2 border-caution pl-3 text-xs leading-5 text-caution">
              Hosted HTTPS endpoints require an API key. Keyless setup is limited to explicitly allowed local/private HTTP endpoints.
            </p>
          ) : null}
          {controller.state.error ? (
            <p className="border-l-2 border-critical bg-critical/5 px-3 py-2 text-xs leading-5 text-critical" role="alert">
              {controller.state.error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              className={`${primaryButton} w-full sm:w-auto sm:min-w-40`}
              disabled={
                controller.state.formLocked ||
                !form.apiRoot.trim() ||
                (hasDiscoveredCatalog
                  ? form.selectedModelIds.length === 0
                  : !form.modelId.trim()) ||
                (noKey && !noKeyAllowed)
              }
              type="submit"
            >
              {controller.state.submitting ? "Testing & saving…" : "Test & Save"}
            </button>
            <p className="text-metadata text-ink-muted">
              Sends {hasDiscoveredCatalog && form.selectedModelIds.length > 1
                ? `${form.selectedModelIds.length} small generation requests (one per model)`
                : "one small generation request"} and may use a small amount of provider quota. Nothing is saved unless every selected model passes.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}

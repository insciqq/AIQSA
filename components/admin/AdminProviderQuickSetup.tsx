"use client";

import {
  AdminAvailabilityStatus,
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import type { AdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type {
  AdminProviderQuickSetupConnection,
  AdminProviderQuickSetupProvider
} from "@/components/admin/adminProviderQuickSetupApi";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";
import Link from "next/link";
import { CheckCircle2, ChevronRight, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef } from "react";

const QUICK_SETUP_FEEDBACK_ID = "provider-quick-feedback";
const QUICK_SETUP_KEY_HELP_ID = "provider-quick-api-key-help";
const QUICK_SETUP_SETUP_ERROR_ID = "provider-quick-setup-error";

export type AdminProviderQuickSetupProps = Readonly<{
  controller: AdminProviderQuickSetupController;
  onManageConnection(connectionId?: string): void;
  onOpenCustom(): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

function familyLabel(family: string): string {
  if (family === "openai") return "OpenAI";
  if (family === "openai_compatible") return "OpenAI-compatible";
  if (family === "openrouter") return "OpenRouter";
  return family.split("_").map((part) =>
    part ? `${part[0].toUpperCase()}${part.slice(1)}` : part
  ).join(" ");
}

function ConfiguredConnections({
  connections,
  onManageConnection
}: Readonly<{
  connections: readonly AdminProviderQuickSetupConnection[];
  onManageConnection(connectionId?: string): void;
}>) {
  if (!connections.length) return null;
  const connectionLabels = resolveProviderConnectionLabels(
    connections.map(({ displayName: name, id }) => ({ id, name }))
  );
  return (
    <section className="mt-6" aria-labelledby="provider-configured-connections-title">
      <div className="flex items-baseline justify-between gap-3 border-b border-trace-subtle pb-2">
        <h3 className="text-xs font-semibold text-ink" id="provider-configured-connections-title">
          Configured connections
        </h3>
        <span className="text-metadata text-ink-muted">{connections.length} total</span>
      </div>
      <div className="divide-y divide-trace-subtle">
        {connections.map((connection) => {
          const connectionLabel = connectionLabels.get(connection.id) ?? connection.displayName;
          return (
            <button
              aria-label={`Open ${connectionLabel} connection · ${familyLabel(connection.family)} · ${connection.enabled ? "Enabled" : "Disabled"} · ${connection.activeModelCount} active models`}
              className={`flex min-h-touch w-full min-w-0 items-center gap-3 px-1 py-3 text-left hover:bg-control-hover ${focusRing} ${touchTarget}`}
              data-testid={`provider-configured-connection-${connection.id}`}
              key={connection.id}
              onClick={() => onManageConnection(connection.id)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
                  {connectionLabel}
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {familyLabel(connection.family)} · {connection.activeModelCount} active model{connection.activeModelCount === 1 ? "" : "s"}
                </span>
              </span>
              <AdminAvailabilityStatus enabled={connection.enabled} />
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function stateLabel(provider: AdminProviderQuickSetupProvider): string {
  if (provider.state === "ready") return "Ready";
  if (provider.state === "disabled") return "Disabled";
  if (provider.state === "needs_attention") return "Needs attention";
  if (provider.state === "advanced_required") return "Custom setup exists";
  return "Not configured";
}

function ManageConnectionButton({
  onManageConnection,
  providerDisplayName
}: {
  onManageConnection(): void;
  providerDisplayName: string;
}) {
  return (
    <button
      className={`${quietButton} border border-control-boundary bg-answer-paper`}
      onClick={() => onManageConnection()}
      type="button"
    >
      Manage {providerDisplayName} connection
    </button>
  );
}

function SetupFeedback({
  controller,
  onManageConnection
}: {
  controller: AdminProviderQuickSetupController;
  onManageConnection(): void;
}) {
  if (!controller.state.error) return null;
  const advancedRecommended = controller.state.errorCode ===
    "provider_quick_setup_advanced_required" || controller.state.errorCode ===
    "provider_quick_setup_unsupported_catalog";
  return (
    <div className="mt-4 border-l-2 border-critical bg-critical/5 px-3 py-2 text-xs leading-5 text-critical">
      <p id={QUICK_SETUP_SETUP_ERROR_ID}>{controller.state.error}</p>
      {advancedRecommended ? (
        <button
          className={`${quietButton} mt-2 text-critical hover:text-critical`}
          onClick={() => onManageConnection()}
          type="button"
        >
          Manage provider connection
        </button>
      ) : null}
    </div>
  );
}

function QuickSetupFeedback({
  controller
}: {
  controller: AdminProviderQuickSetupController;
}) {
  const feedback = controller.state.feedback;
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-feedback-tone={feedback?.tone}
      data-testid="provider-quick-feedback"
      id={QUICK_SETUP_FEEDBACK_ID}
      role="status"
    >
      {feedback?.message ?? ""}
    </p>
  );
}

function SnapshotFeedback({
  controller
}: {
  controller: AdminProviderQuickSetupController;
}) {
  if (controller.state.loading) {
    return (
      <p className="mt-4 text-xs leading-5 text-ink-muted">
        {controller.state.reconciliationRequired
          ? "Confirming saved provider status…"
          : "Refreshing provider status…"}
      </p>
    );
  }
  if (!controller.state.refreshError) return null;
  return (
    <div className="mt-4 border-l-2 border-critical bg-critical/5 px-3 py-2 text-xs leading-5 text-critical">
      <p>{controller.state.refreshError}</p>
      {controller.state.reconciliationRequired ? (
        <p className="mt-1 text-ink-secondary">
          The current provider status still needs confirmation before another change.
        </p>
      ) : null}
      <button
        className={`${quietButton} mt-2 text-critical hover:text-critical`}
        onClick={() => void controller.actions.refresh()}
        type="button"
      >
        Retry status refresh
      </button>
    </div>
  );
}

function ModelChoice({
  controller
}: {
  controller: AdminProviderQuickSetupController;
}) {
  const selection = controller.state.selection;
  const firstCandidateRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selection) return;
    firstCandidateRef.current?.focus();
  }, [selection]);

  if (!selection) return null;
  return (
    <fieldset
      aria-describedby="provider-quick-model-required"
      className="mt-5 border-y border-trace-subtle"
    >
      <legend className="px-0 pb-2 text-xs font-medium text-ink-secondary">
        Choose a model available to this key
      </legend>
      <p
        className="px-3 pb-2 text-xs leading-5 text-ink-secondary"
        data-testid="provider-quick-model-required"
        id="provider-quick-model-required"
      >
        A model choice is required. Choose one to finish setup.
      </p>
      <div className="divide-y divide-trace-subtle">
        {selection.candidates.map((candidate, index) => (
          <label
            className={`flex min-h-touch items-center gap-3 px-3 py-2.5 text-sm text-ink ${
              controller.state.formLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${touchTarget}`}
            key={candidate.candidateId}
          >
            <input
              checked={controller.state.selectedCandidateId === candidate.candidateId}
              className="size-4 shrink-0 accent-proof"
              disabled={controller.state.formLocked}
              name="provider-quick-model"
              onChange={() => controller.actions.chooseModel(candidate.candidateId)}
              ref={index === 0 ? firstCandidateRef : undefined}
              required
              type="radio"
              value={candidate.candidateId}
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {candidate.displayName}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function KeyForm({
  controller,
  onManageConnection,
  providerDisplayName,
  replacement = false
}: {
  controller: AdminProviderQuickSetupController;
  onManageConnection(): void;
  providerDisplayName: string;
  replacement?: boolean;
}) {
  const selectionRequired = Boolean(controller.state.selection);
  const keyError = controller.state.feedback?.tone === "error" && (
    controller.state.errorCode === "provider_credential_test_failed" ||
    controller.state.errorCode === "provider_quick_setup_unsupported_catalog"
  );
  const submitDisabled = controller.state.formLocked || !controller.state.secret.trim() ||
    (selectionRequired && !controller.state.selectedCandidateId);
  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.actions.submit();
      }}
    >
      {replacement ? (
        <p className="mb-4 max-w-xl text-xs leading-5 text-ink-secondary">
          Your current key stays active unless this replacement succeeds.
        </p>
      ) : null}
      <ModelChoice controller={controller} />
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <label
            className="mb-1 block text-xs font-medium text-ink-secondary"
            htmlFor="provider-quick-api-key"
          >
            API key
          </label>
          <input
            aria-describedby={keyError
              ? `${QUICK_SETUP_KEY_HELP_ID} ${QUICK_SETUP_SETUP_ERROR_ID}`
              : QUICK_SETUP_KEY_HELP_ID}
            aria-errormessage={keyError ? QUICK_SETUP_SETUP_ERROR_ID : undefined}
            aria-invalid={keyError || undefined}
            autoComplete="new-password"
            className={inputClass}
            disabled={controller.state.formLocked}
            id="provider-quick-api-key"
            name="provider-api-key"
            onChange={(event) => controller.actions.changeSecret(event.currentTarget.value)}
            placeholder={replacement ? "Enter replacement key" : "Paste provider key"}
            type="password"
            value={controller.state.secret}
          />
          <span
            className="mt-1 block text-xs leading-4 text-ink-muted"
            id={QUICK_SETUP_KEY_HELP_ID}
          >
            Write-only. Stored keys are never shown again.
          </span>
        </div>
        <button
          className={`${primaryButton} w-full sm:min-w-40`}
          disabled={submitDisabled}
          type="submit"
        >
          {controller.state.submitting
            ? "Testing & saving…"
            : selectionRequired
              ? "Use selected model & save"
              : "Test & Save"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ManageConnectionButton
          onManageConnection={onManageConnection}
          providerDisplayName={providerDisplayName}
        />
      </div>
      {replacement ? (
        <button
          className={`${quietButton} mt-3`}
          disabled={controller.state.submitting}
          onClick={controller.actions.cancelReplacement}
          type="button"
        >
          Cancel replacement
        </button>
      ) : null}
      <SetupFeedback controller={controller} onManageConnection={onManageConnection} />
    </form>
  );
}

function QuickAssignmentControl({
  controller,
  provider,
  requestConfirmation
}: {
  controller: AdminProviderQuickSetupController;
  provider: AdminProviderQuickSetupProvider;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}) {
  if (!provider.quickSetupAssigned) return null;
  return (
    <div className="mt-5 border-t border-trace-subtle pt-4">
      <p className="max-w-xl text-xs leading-5 text-ink-muted">
        Remove this Quick setup key assignment from your account. This action does not change the connection default; your account returns to normal team/default credential resolution. The stored credential and all team settings stay unchanged; the credential remains manageable in Connections.
      </p>
      <button
        className={`${quietButton} mt-2`}
        disabled={controller.state.formLocked}
        onClick={() => requestConfirmation({
          body: "AIQSA will remove only your direct Quick setup key assignment. This action does not change the connection default; your account returns to normal team/default credential resolution. The stored credential, grants, and team settings will remain unchanged.",
          confirmLabel: "Remove key assignment",
          dialogLabel: `Remove ${provider.providerDisplayName} Quick key assignment`,
          icon: "x",
          onConfirm: async () => {
            await controller.actions.clearAssignment();
          },
          testId: "admin-confirm-clear-provider-quick-assignment",
          title: "Remove your Quick key assignment?",
          tone: "warning"
        })}
        type="button"
      >
        {controller.state.clearing ? "Removing assignment…" : "Remove my key assignment"}
      </button>
    </div>
  );
}

function ReadyProvider({
  controller,
  onManageConnection,
  provider,
  requestConfirmation
}: {
  controller: AdminProviderQuickSetupController;
  onManageConnection(): void;
  provider: AdminProviderQuickSetupProvider;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}) {
  const confirmation = controller.state.readyConfirmation?.provider === provider.provider
    ? controller.state.readyConfirmation
    : null;
  const search = confirmation?.search ?? null;
  return (
    <section className="mt-6 border-t border-positive pt-5">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-positive">
        Ready to chat
      </p>
      <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        {provider.model?.displayName}
      </h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
        This provider is configured and available in chat. Personal and installation default models remain unchanged.
      </p>
      {confirmation ? (
        <div
          className="mt-4 border-l-2 border-positive/50 pl-3 text-xs leading-5 text-ink-secondary"
          data-testid="provider-quick-ready-summary"
        >
          <p>API key: saved and verified.</p>
          <p>Prepared model: {confirmation.model.displayName}.</p>
          <p>
            Available models: {confirmation.models.map(({ displayName }) => displayName).join(", ")}.
          </p>
          <p>Access: available to this administrator.</p>
          <p>
            Connection default credential: {confirmation.defaultCredentialChanged
              ? "set to this verified key."
              : "already uses this verified key."}
          </p>
          <p>Default models: unchanged. Choose one explicitly from the model picker or the Default model task.</p>
          {search ? (
            <p>
              {search.displayName}: {search.status === "ready"
                ? "ready for supported models"
                : "requires attention; finish setup in Search"}.
            </p>
          ) : null}
        </div>
      ) : null}

      {provider.provider === "openai" ? (
        <div className="mt-4 border-l-2 border-proof/45 pl-3 text-xs leading-5 text-ink-secondary">
          <p>
            {search?.status === "ready"
              ? "OpenAI Search is ready for supported OpenAI, Anthropic, Gemini, and other answer models."
              : search?.status === "needs_attention"
                ? "The provider is ready, but OpenAI Search still needs a successful source check before it can serve broader models."
                : "OpenAI Search can be reviewed and managed from the Search section."}
          </p>
          <Link className={`${quietButton} mt-2`} href="/admin?section=search">
            Manage OpenAI Search
          </Link>
        </div>
      ) : null}

      {controller.state.replacing ? (
        <KeyForm
          controller={controller}
          onManageConnection={onManageConnection}
          providerDisplayName={provider.providerDisplayName}
          replacement
        />
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {controller.state.loading || controller.state.reconciliationRequired ? (
              <span className={`${primaryButton} cursor-wait opacity-60`}>Confirming setup…</span>
            ) : (
              <Link className={primaryButton} href="/">Start chatting</Link>
            )}
            <button
              className={quietButton}
              disabled={controller.state.formLocked}
              onClick={controller.actions.beginReplacement}
              type="button"
            >
              Replace API key
            </button>
            <ManageConnectionButton
              onManageConnection={onManageConnection}
              providerDisplayName={provider.providerDisplayName}
            />
          </div>
          <QuickAssignmentControl
            controller={controller}
            provider={provider}
            requestConfirmation={requestConfirmation}
          />
          <SetupFeedback controller={controller} onManageConnection={onManageConnection} />
        </>
      )}
    </section>
  );
}

function SelectedProviderTask({
  controller,
  onManageConnection,
  provider,
  requestConfirmation
}: {
  controller: AdminProviderQuickSetupController;
  onManageConnection(): void;
  provider: AdminProviderQuickSetupProvider;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}) {
  if (provider.state === "ready") {
    return (
      <ReadyProvider
        controller={controller}
        onManageConnection={onManageConnection}
        provider={provider}
        requestConfirmation={requestConfirmation}
      />
    );
  }
  return (
    <section className={`mt-6 border-t pt-5 ${
      provider.state === "needs_attention"
        ? "border-caution"
        : provider.state === "disabled"
          ? "border-trace-strong"
          : "border-trace-subtle"
    }`}>
      {provider.state === "needs_attention" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-caution">
            Setup needs attention
          </p>
          <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
            Test and save a key again to restore a proven setup for your account. Existing active configuration is not changed unless this succeeds.
          </p>
        </>
      ) : provider.state === "disabled" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink">
            Provider disabled
          </p>
          <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
            Existing configuration is paused for new runs. Test and save a key to verify and enable it again, or manage the connection directly.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-lg font-semibold tracking-tight text-ink">
            Connect {provider.providerDisplayName}
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
            Paste a key. AIQSA will verify it, check proposed models with a small image-only PDF, and make the supported models available to your account.
          </p>
          {provider.state === "advanced_required" ? (
            <p className="mt-3 max-w-xl border-l-2 border-proof/40 pl-3 text-xs leading-5 text-ink-muted">
              Existing team or custom configuration will stay unchanged.
            </p>
          ) : null}
        </>
      )}
      <KeyForm
        controller={controller}
        onManageConnection={onManageConnection}
        providerDisplayName={provider.providerDisplayName}
      />
      <QuickAssignmentControl
        controller={controller}
        provider={provider}
        requestConfirmation={requestConfirmation}
      />
    </section>
  );
}

function SetupGuide() {
  const steps = [
    {
      detail: "The key and each proposed model’s Direct PDF input are checked before anything is saved. The small model probes may use provider quota.",
      Icon: ShieldCheck,
      title: "Verify the key"
    },
    {
      detail: "AIQSA activates the current supported answer models and makes the verified key the connection default without changing model defaults.",
      Icon: CheckCircle2,
      title: "Prepare a model"
    },
    {
      detail: "The key and model access are assigned directly to your administrator account.",
      Icon: UserRound,
      title: "Give your account access"
    }
  ];
  return (
    <aside className="hidden border-l border-trace-subtle pl-8 xl:block">
      <h3 className="text-sm font-semibold text-ink">What AIQSA will do</h3>
      <ol className="mt-5 grid gap-6">
        {steps.map(({ detail, Icon, title }) => (
          <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3" key={title}>
            <span className="grid size-8 place-items-center rounded-full bg-proof/10 text-proof">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-medium text-ink">{title}</span>
              <span className="mt-1 block text-xs leading-5 text-ink-muted">{detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-7 border-t border-trace-subtle pt-5">
        <p className="flex items-start gap-2 text-xs leading-5 text-ink-muted">
          <KeyRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Keys are encrypted at rest and remain write-only after saving.
        </p>
      </div>
    </aside>
  );
}

export function AdminProviderQuickSetup({
  controller,
  onManageConnection,
  onOpenCustom,
  requestConfirmation
}: AdminProviderQuickSetupProps) {
  const providers = controller.state.snapshot?.providers ?? [];
  const configuredConnections = controller.state.snapshot?.configuredConnections ?? [];
  const customConnectionCount = configuredConnections.filter(
    (connection) => connection.family === "openai_compatible"
  ).length;
  return (
    <div className="min-w-0 px-4 py-4 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-6xl">
        <h2 className="sr-only">Provider quick setup</h2>
        <QuickSetupFeedback controller={controller} />

        {!controller.state.snapshot && (!controller.state.loaded || controller.state.loading) ? (
          <p className="py-8 text-sm text-ink-muted">Loading provider setup…</p>
        ) : controller.state.snapshot && providers.length ? (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-10">
            <div className="min-w-0">
              <div
                className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-panel border border-trace-subtle bg-trace-subtle sm:grid-cols-3 lg:grid-cols-5"
                data-testid="provider-quick-choice-strip"
              >
                {providers.map((provider) => {
                  const selected = controller.state.selectedProviderId === provider.provider;
                  return (
                    <button
                      aria-label={`${provider.providerDisplayName} ${stateLabel(provider)}`}
                      className={`min-w-0 px-2 py-3 text-left sm:px-4 sm:py-4 ${focusRing} ${touchTarget} ${
                        selected
                          ? "bg-control-selected text-ink"
                          : "bg-answer-paper text-ink hover:bg-control-hover"
                      }`}
                      disabled={controller.state.formLocked}
                      key={provider.provider}
                      onClick={() => {
                        if (!selected) controller.actions.selectProvider(provider.provider);
                      }}
                      type="button"
                    >
                      <span className="block break-words text-sm font-semibold sm:text-base [overflow-wrap:anywhere]">
                        {provider.providerDisplayName}
                      </span>
                      {provider.state === "disabled" ? (
                        <span className="mt-1 inline-flex">
                          <AdminAvailabilityStatus enabled={false} />
                        </span>
                      ) : (
                        <span className={`mt-1 block text-xs ${
                          selected
                            ? "text-ink-secondary"
                            : provider.state === "ready"
                            ? "text-positive"
                            : provider.state === "needs_attention"
                              ? "text-caution"
                              : provider.state === "advanced_required"
                                ? "text-proof"
                                : "text-ink-muted"
                        }`}>
                          {stateLabel(provider)}
                        </span>
                      )}
                    </button>
                  );
                })}
                <button
                  aria-label={`Custom ${
                    customConnectionCount ? `${customConnectionCount} configured` : "OpenAI-compatible"
                  }`}
                  className={`min-w-0 bg-answer-paper px-2 py-3 text-left text-ink hover:bg-control-hover sm:px-4 sm:py-4 ${focusRing} ${touchTarget}`}
                  disabled={controller.state.formLocked}
                  onClick={onOpenCustom}
                  type="button"
                >
                  <span className="block break-words text-sm font-semibold sm:text-base">
                    Custom
                  </span>
                  <span className="mt-1 block text-xs text-ink-muted">
                    {customConnectionCount
                      ? `${customConnectionCount} configured`
                      : "OpenAI-compatible"}
                  </span>
                </button>
              </div>

              <SnapshotFeedback controller={controller} />
              <ConfiguredConnections
                connections={configuredConnections}
                onManageConnection={onManageConnection}
              />

              {controller.state.selectedProvider ? (
                <SelectedProviderTask
                  controller={controller}
                  onManageConnection={onManageConnection}
                  provider={controller.state.selectedProvider}
                  requestConfirmation={requestConfirmation}
                />
              ) : (
                <div className="mt-6 border-t border-trace-subtle pt-5">
                  <p className="text-sm text-ink-secondary">Choose a provider to continue.</p>
                  <SetupFeedback controller={controller} onManageConnection={onManageConnection} />
                </div>
              )}
            </div>
            <SetupGuide />
          </div>
        ) : (
          <>
            <SnapshotFeedback controller={controller} />
            <ConfiguredConnections
              connections={configuredConnections}
              onManageConnection={onManageConnection}
            />
            <div className="mt-4 grid max-w-52 overflow-hidden rounded-panel border border-trace-subtle">
              <button
                className={`bg-answer-paper px-4 py-4 text-left text-ink hover:bg-control-hover ${focusRing} ${touchTarget}`}
                onClick={onOpenCustom}
                type="button"
              >
                <span className="block text-base font-semibold">Custom</span>
                <span className="mt-1 block text-xs text-ink-muted">OpenAI-compatible</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

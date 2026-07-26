"use client";

import {
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import type { AdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type { AdminProviderQuickSetupProvider } from "@/components/admin/adminProviderQuickSetupApi";
import Link from "next/link";

export type AdminProviderQuickSetupProps = Readonly<{
  controller: AdminProviderQuickSetupController;
  onOpenAdvanced(): void;
}>;

function stateLabel(provider: AdminProviderQuickSetupProvider): string {
  if (provider.state === "ready") return "Ready";
  if (provider.state === "needs_attention") return "Needs attention";
  if (provider.state === "advanced_required") return "Advanced";
  return "Not connected";
}

function AdvancedLink({ onOpenAdvanced }: { onOpenAdvanced(): void }) {
  return (
    <button
      className={`text-left text-xs font-medium text-proof hover:text-proof-hover ${focusRing} ${touchTarget}`}
      onClick={onOpenAdvanced}
      type="button"
    >
      Advanced configuration
    </button>
  );
}

function SetupFeedback({
  controller,
  onOpenAdvanced
}: {
  controller: AdminProviderQuickSetupController;
  onOpenAdvanced(): void;
}) {
  if (!controller.state.error) return null;
  const advancedRecommended = controller.state.errorCode ===
    "provider_quick_setup_advanced_required" || controller.state.errorCode ===
    "provider_quick_setup_unsupported_catalog";
  return (
    <div className="mt-4 border-l-2 border-critical bg-critical/5 px-3 py-2 text-xs leading-5 text-critical">
      <p>{controller.state.error}</p>
      {advancedRecommended ? (
        <button
          className={`${quietButton} mt-2 text-critical hover:text-critical`}
          onClick={onOpenAdvanced}
          type="button"
        >
          Open Advanced configuration
        </button>
      ) : null}
    </div>
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
  if (!selection) return null;
  return (
    <fieldset className="mt-5 border-y border-trace-subtle">
      <legend className="px-0 pb-2 text-xs font-medium text-ink-secondary">
        Choose a model available to this key
      </legend>
      <div className="divide-y divide-trace-subtle">
        {selection.candidates.map((candidate) => (
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
              name="personal-provider-model"
              onChange={() => controller.actions.chooseModel(candidate.candidateId)}
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
  onOpenAdvanced,
  replacement = false
}: {
  controller: AdminProviderQuickSetupController;
  onOpenAdvanced(): void;
  replacement?: boolean;
}) {
  const selectionRequired = Boolean(controller.state.selection);
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
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <label
            className="mb-1 block text-xs font-medium text-ink-secondary"
            htmlFor="personal-provider-api-key"
          >
            API key
          </label>
          <input
            autoComplete="new-password"
            className={inputClass}
            disabled={controller.state.formLocked}
            id="personal-provider-api-key"
            name="provider-api-key"
            onChange={(event) => controller.actions.changeSecret(event.currentTarget.value)}
            placeholder={replacement ? "Enter replacement key" : "Paste provider key"}
            type="password"
            value={controller.state.secret}
          />
          <span className="mt-1 block text-[11px] leading-4 text-ink-muted">
            Write-only. Stored keys are never shown again.
          </span>
        </div>
        <button
          className={`${primaryButton} w-full sm:w-auto`}
          disabled={submitDisabled}
          type="submit"
        >
          {controller.state.submitting ? "Testing & saving…" : "Test & Save"}
        </button>
      </div>
      <ModelChoice controller={controller} />
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
      <SetupFeedback controller={controller} onOpenAdvanced={onOpenAdvanced} />
    </form>
  );
}

function ReadyProvider({
  controller,
  onOpenAdvanced,
  provider
}: {
  controller: AdminProviderQuickSetupController;
  onOpenAdvanced(): void;
  provider: AdminProviderQuickSetupProvider;
}) {
  const confirmation = controller.state.readyConfirmation?.provider === provider.provider
    ? controller.state.readyConfirmation
    : null;
  const profileLabels = confirmation?.profilesFilled.map((profile) =>
    profile.charAt(0).toUpperCase() + profile.slice(1)
  ) ?? [];
  return (
    <section className="mt-6 border-t border-positive pt-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-positive">
        Ready to chat
      </p>
      <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        {provider.model?.displayName}
      </h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
        {confirmation?.defaultChanged === false
          ? "Available in chat. Your existing default model remained unchanged."
          : "This provider is configured and available in chat."}
      </p>
      {confirmation ? (
        <div
          className="mt-4 border-l-2 border-positive/50 pl-3 text-xs leading-5 text-ink-secondary"
          data-testid="provider-quick-ready-receipt"
        >
          <p>API key: saved and verified.</p>
          <p>Active model: {confirmation.model.displayName}.</p>
          <p>Access: available to this administrator.</p>
          <p>Default model: {confirmation.defaultChanged ? "updated" : "unchanged"}.</p>
          <p>Run profiles filled: {profileLabels.length ? profileLabels.join(", ") : "none"}.</p>
        </div>
      ) : null}

      {controller.state.replacing ? (
        <KeyForm controller={controller} onOpenAdvanced={onOpenAdvanced} replacement />
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
          </div>
          <div className="mt-4">
            <AdvancedLink onOpenAdvanced={onOpenAdvanced} />
          </div>
          <SetupFeedback controller={controller} onOpenAdvanced={onOpenAdvanced} />
        </>
      )}
    </section>
  );
}

function SelectedProviderTask({
  controller,
  onOpenAdvanced,
  provider
}: {
  controller: AdminProviderQuickSetupController;
  onOpenAdvanced(): void;
  provider: AdminProviderQuickSetupProvider;
}) {
  if (provider.state === "ready") {
    return <ReadyProvider controller={controller} onOpenAdvanced={onOpenAdvanced} provider={provider} />;
  }
  if (provider.state === "advanced_required") {
    return (
      <section className="mt-6 border-t border-caution pt-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-caution">
          Advanced configuration required
        </p>
        <h3 className="mt-2 text-lg font-semibold text-ink">Keep the existing setup intact</h3>
        <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
          This provider has custom or team configuration that Personal setup cannot safely replace.
        </p>
        <button className={`${primaryButton} mt-5`} onClick={onOpenAdvanced} type="button">
          Open Advanced configuration
        </button>
      </section>
    );
  }
  return (
    <section className={`mt-6 border-t pt-5 ${
      provider.state === "needs_attention" ? "border-caution" : "border-trace-subtle"
    }`}>
      {provider.state === "needs_attention" ? (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-caution">
            Setup needs attention
          </p>
          <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
            Test and save a key again to restore a proven personal setup. Existing active configuration is not changed unless this succeeds.
          </p>
        </>
      ) : (
        <p className="max-w-xl text-sm leading-6 text-ink-secondary">
          Paste a key from {provider.providerDisplayName}. AIQSA will check the account catalog and configure one supported model.
        </p>
      )}
      <KeyForm controller={controller} onOpenAdvanced={onOpenAdvanced} />
      <div className="mt-4">
        <AdvancedLink onOpenAdvanced={onOpenAdvanced} />
      </div>
    </section>
  );
}

export function AdminProviderQuickSetup({
  controller,
  onOpenAdvanced
}: AdminProviderQuickSetupProps) {
  const providers = controller.state.snapshot?.providers ?? [];
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[44rem] lg:mx-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
          Personal setup
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">Connect a provider</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
          Choose a provider, paste its API key, then test and save. Team assignments and custom routing stay in Advanced configuration.
        </p>

        {!controller.state.snapshot && (!controller.state.loaded || controller.state.loading) ? (
          <p className="mt-8 text-sm text-ink-muted">Loading provider setup…</p>
        ) : controller.state.snapshot && providers.length ? (
          <>
            <div
              className="mt-6 grid min-w-0 divide-y divide-trace-subtle border-y border-trace-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0"
              data-testid="provider-quick-choice-strip"
            >
              {providers.map((provider) => {
                const selected = controller.state.selectedProviderId === provider.provider;
                return (
                  <button
                    className={`min-w-0 px-3 py-3 text-left ${focusRing} ${touchTarget} ${
                      selected ? "bg-proof/10 text-proof" : "text-ink hover:bg-control-hover"
                    }`}
                    disabled={controller.state.formLocked}
                    key={provider.provider}
                    onClick={() => {
                      if (!selected) controller.actions.selectProvider(provider.provider);
                    }}
                    type="button"
                  >
                    <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">
                      {provider.providerDisplayName}
                    </span>
                    <span className={`mt-1 block text-[11px] ${
                      provider.state === "ready"
                        ? "text-positive"
                        : provider.state === "needs_attention" || provider.state === "advanced_required"
                          ? "text-caution"
                          : "text-ink-muted"
                    }`}>
                      {stateLabel(provider)}
                    </span>
                  </button>
                );
              })}
            </div>

            <SnapshotFeedback controller={controller} />

            {controller.state.selectedProvider ? (
              <SelectedProviderTask
                controller={controller}
                onOpenAdvanced={onOpenAdvanced}
                provider={controller.state.selectedProvider}
              />
            ) : (
              <div className="mt-6 border-t border-trace-subtle pt-5">
                <p className="text-sm text-ink-secondary">Choose a provider to continue.</p>
                <SetupFeedback controller={controller} onOpenAdvanced={onOpenAdvanced} />
                <div className="mt-4"><AdvancedLink onOpenAdvanced={onOpenAdvanced} /></div>
              </div>
            )}
          </>
        ) : (
          <>
            <SnapshotFeedback controller={controller} />
            <div className="mt-4"><AdvancedLink onOpenAdvanced={onOpenAdvanced} /></div>
          </>
        )}
      </div>
    </div>
  );
}

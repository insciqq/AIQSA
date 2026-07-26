"use client";

import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminProviderCustomSetupController } from "@/components/admin/useAdminProviderCustomSetupController";
import { ArrowLeft, ChevronDown, KeyRound, ServerCog } from "lucide-react";
import Link from "next/link";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-[11px] leading-4 text-ink-muted";

export type AdminProviderCustomSetupProps = Readonly<{
  controller: AdminProviderCustomSetupController;
  onBack(): void;
  onManageConnection(connectionId: string): void;
}>;

function requestEndpoint(apiRoot: string): string {
  const root = apiRoot.trim().replace(/\/+$/u, "");
  return root ? `${root}/chat/completions` : "API root + /chat/completions";
}

export function AdminProviderCustomSetup({
  controller,
  onBack,
  onManageConnection
}: AdminProviderCustomSetupProps) {
  const { form, ready } = controller.state;

  if (ready) {
    return (
      <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <section className="max-w-3xl border-t-2 border-positive pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-positive">
            Ready to chat
          </p>
          <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink">
            {ready.modelDisplayName}
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-secondary">
            The custom Chat Completions endpoint passed its exact model test and is available to your administrator account.
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
            <p>Default selection: {ready.defaultChanged ? "updated" : "unchanged"}.</p>
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
          </div>
        </section>
      </div>
    );
  }

  const noKey = !form.secret.trim();
  const endpoint = requestEndpoint(form.apiRoot);
  const noKeyAllowed = form.allowPrivateNetwork && (() => {
    try {
      return new URL(form.apiRoot.trim()).protocol === "http:";
    } catch {
      return false;
    }
  })();

  return (
    <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-4xl">
        <button className={quietButton} onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Back to provider setup
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
                Use an OpenAI-compatible Chat Completions API. AIQSA tests this exact model before saving anything.
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
          </div>

          <div className="rounded-control bg-control-surface/60 px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
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
                !form.modelId.trim() ||
                (noKey && !noKeyAllowed)
              }
              type="submit"
            >
              {controller.state.submitting ? "Testing & saving…" : "Test & Save"}
            </button>
            <p className="text-[11px] leading-4 text-ink-muted">
              Sends one small generation request and may use a small amount of provider quota.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}

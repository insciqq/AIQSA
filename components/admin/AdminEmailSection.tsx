"use client";

import {
  dangerButton,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import { formatDate } from "@/components/admin/adminViewUtils";
import {
  useAdminEmailController,
  type AdminEmailController
} from "@/components/admin/useAdminEmailController";
import type {
  AdminEmailConfiguration,
  AdminEmailPasswordAction,
  AdminEmailTransportMode
} from "@/lib/contracts/email";
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  Power,
  RefreshCw,
  Save,
  Send,
  Trash2
} from "lucide-react";
import { useState } from "react";

type EmailForm = {
  allowInternalNetwork: boolean;
  authenticationMode: "none" | "password";
  displayName: string;
  fromAddress: string;
  host: string;
  password: string;
  passwordAction: "preserve" | "replace";
  port: string;
  transport: AdminEmailTransportMode;
  username: string;
};

const fieldLabel = "text-xs font-medium text-content-secondary";
const helpText = "mt-1 text-[11px] leading-4 text-content-muted";

function formFrom(controller: AdminEmailController): EmailForm {
  const draft = controller.state.email?.draft;
  const configuration = draft?.configuration;
  return {
    allowInternalNetwork: configuration?.allowInternalNetwork ?? false,
    authenticationMode: configuration?.authentication.mode ?? "password",
    displayName: configuration?.from.displayName ?? "AIQSA",
    fromAddress: configuration?.from.address ?? "",
    host: configuration?.host ?? "",
    password: "",
    passwordAction: draft?.passwordConfigured ? "preserve" : "replace",
    port: String(configuration?.port ?? 587),
    transport: configuration?.transport ?? "starttls_required",
    username: configuration?.authentication.mode === "password"
      ? configuration.authentication.username
      : ""
  };
}

function configurationFrom(form: EmailForm): AdminEmailConfiguration {
  return {
    allowInternalNetwork: form.allowInternalNetwork,
    authentication: form.authenticationMode === "password"
      ? { mode: "password", username: form.username }
      : { mode: "none" },
    from: {
      address: form.fromAddress,
      displayName: form.displayName.trim() || null
    },
    host: form.host,
    port: Number(form.port),
    transport: form.transport
  };
}

function passwordActionFrom(form: EmailForm): AdminEmailPasswordAction {
  if (form.authenticationMode === "none") {
    return { confirm: true, kind: "clear" };
  }
  return form.passwordAction === "replace"
    ? { kind: "replace", password: form.password }
    : { kind: "preserve" };
}

function status(controller: AdminEmailController) {
  const email = controller.state.email;
  if (!email?.draft.configuration && !email?.active.configuration) {
    return { label: "Not configured", tone: "bg-surface-raised text-content-muted" };
  }
  if (email.health.degraded) {
    return { label: "Degraded", tone: "bg-accent-rose/10 text-accent-rose" };
  }
  if (email.active.enabled) {
    return { label: "Active", tone: "bg-accent-green/10 text-accent-green" };
  }
  if (email.active.configuration) {
    return { label: "Disabled", tone: "bg-accent-amber/10 text-accent-amber" };
  }
  if (email.draft.test?.tested) {
    return { label: "Tested", tone: "bg-accent-cyan/10 text-accent-cyan" };
  }
  return { label: "Needs test", tone: "bg-accent-amber/10 text-accent-amber" };
}

function Feedback({ controller }: { controller: AdminEmailController }) {
  if (!controller.state.error && !controller.state.notice) return null;
  return (
    <div className="grid gap-2 px-4 pt-4">
      {controller.state.error ? (
        <div className="flex flex-col gap-2 rounded-control bg-accent-rose/10 px-3 py-2 text-xs leading-5 text-accent-rose sm:flex-row sm:items-start sm:justify-between" role="alert">
          <span>{controller.state.error}</span>
          <button className={quietButton} onClick={controller.actions.dismissError} type="button">Dismiss</button>
        </div>
      ) : null}
      {controller.state.notice ? (
        <div className="flex flex-col gap-2 rounded-control bg-accent-green/10 px-3 py-2 text-xs leading-5 text-accent-green sm:flex-row sm:items-start sm:justify-between" role="status">
          <span>{controller.state.notice}</span>
          <button className={quietButton} onClick={controller.actions.dismissNotice} type="button">Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  children,
  help,
  label
}: Readonly<{ children: React.ReactNode; help?: string; label: string }>) {
  return (
    <label className="min-w-0">
      <span className={fieldLabel}>{label}</span>
      {children}
      {help ? <span className={`${helpText} block`}>{help}</span> : null}
    </label>
  );
}

function AdminEmailContent({ controller }: Readonly<{ controller: AdminEmailController }>) {
  const [form, setForm] = useState<EmailForm>(() => formFrom(controller));
  const [recipient, setRecipient] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [plaintextAcknowledged, setPlaintextAcknowledged] = useState(false);
  const email = controller.state.email;
  if (!email) return null;
  const currentStatus = status(controller);

  const tested = email.draft.test?.tested === true && email.draft.test.version === email.draft.version;
  const busy = controller.state.busy;
  const hasDraft = Boolean(email.draft.configuration);
  const hasActive = Boolean(email.active.configuration);
  const plaintext = form.transport === "plaintext_internal_no_auth";
  const plaintextApproved = !plaintext || (
    form.authenticationMode === "none" &&
    form.allowInternalNetwork &&
    plaintextAcknowledged
  );
  const draftDirty = JSON.stringify(form) !== JSON.stringify(formFrom(controller));

  const patchForm = (patch: Partial<EmailForm>) => {
    setPlaintextAcknowledged(false);
    setForm((current) => ({ ...current, ...patch }));
  };
  const save = () => controller.actions.save({
    configuration: configurationFrom(form),
    expectedDraftVersion: email.draft.version,
    passwordAction: passwordActionFrom(form)
  });

  return (
    <div className="min-w-0">
      <Feedback controller={controller} />
      <div className="grid min-w-0 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 rounded-panel bg-surface-raised/40 p-4" aria-label="Email delivery draft">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-content-primary">SMTP draft</h3>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-content-muted">
                Saving changes does not affect outgoing email. Send a real test message, then activate the exact tested draft.
              </p>
            </div>
            <span className={`inline-flex rounded-pill px-2 py-1 text-[11px] ${currentStatus.tone}`}>
              {currentStatus.label}
            </span>
          </div>

          <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
            <Field label="SMTP host" help="Hostname or IP address, without a URL scheme.">
              <input aria-label="SMTP host" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ host: event.currentTarget.value })} required type="text" value={form.host} />
            </Field>
            <Field label="Port">
              <input aria-label="Port" className={`${inputClass} mt-1.5`} disabled={busy} inputMode="numeric" max={65535} min={1} onChange={(event) => patchForm({ port: event.currentTarget.value })} required type="number" value={form.port} />
            </Field>
            <Field label="From address">
              <input aria-label="From address" autoComplete="email" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ fromAddress: event.currentTarget.value })} required type="email" value={form.fromAddress} />
            </Field>
            <Field label="From display name" help="Optional. Plain printable text only.">
              <input aria-label="From display name" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ displayName: event.currentTarget.value })} type="text" value={form.displayName} />
            </Field>
            <Field label="Transport security">
              <select
                aria-label="Transport security"
                className={`${inputClass} mt-1.5`}
                disabled={busy}
                onChange={(event) => patchForm({ transport: event.currentTarget.value as AdminEmailTransportMode })}
                value={form.transport}
              >
                <option value="starttls_required">STARTTLS required</option>
                <option value="implicit_tls">Implicit TLS</option>
                <option value="plaintext_internal_no_auth">Plaintext internal relay</option>
              </select>
            </Field>
            <Field label="Authentication">
              <select
                aria-label="Authentication"
                className={`${inputClass} mt-1.5`}
                disabled={busy}
                onChange={(event) => patchForm({
                  authenticationMode: event.currentTarget.value as EmailForm["authenticationMode"],
                  password: "",
                  passwordAction: email.draft.passwordConfigured ? "preserve" : "replace"
                })}
                value={form.authenticationMode}
              >
                <option value="password">Username and password</option>
                <option value="none">No authentication</option>
              </select>
            </Field>
          </div>

          {form.authenticationMode === "password" ? (
            <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">
              <Field label="Username">
                <input aria-label="Username" autoComplete="username" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ username: event.currentTarget.value })} required type="text" value={form.username} />
              </Field>
              <Field label="Password action" help={email.draft.passwordConfigured ? "The stored password is write-only." : "A password is required before this draft can be saved."}>
                <select
                  aria-label="Password action"
                  className={`${inputClass} mt-1.5`}
                  disabled={busy || !email.draft.passwordConfigured}
                  onChange={(event) => patchForm({ passwordAction: event.currentTarget.value as EmailForm["passwordAction"], password: "" })}
                  value={form.passwordAction}
                >
                  {email.draft.passwordConfigured ? <option value="preserve">Keep stored password</option> : null}
                  <option value="replace">Replace password</option>
                </select>
              </Field>
              {form.passwordAction === "replace" ? (
                <Field label="New password" help="The value is encrypted before persistence and is never returned to this page.">
                  <input aria-label="New password" autoComplete="new-password" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ password: event.currentTarget.value })} required type="password" value={form.password} />
                </Field>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 rounded-control bg-surface-raised px-3 py-2 text-xs leading-5 text-content-secondary">
              Saving without authentication explicitly clears any stored draft password.
            </p>
          )}

          <label className={`mt-4 flex min-h-control items-start gap-2 rounded-control bg-surface-raised px-3 py-2 text-xs text-content-secondary ${touchTarget}`}>
            <input
              checked={form.allowInternalNetwork}
              className="mt-0.5 size-4 shrink-0 accent-accent-cyan"
              disabled={busy}
              onChange={(event) => patchForm({ allowInternalNetwork: event.currentTarget.checked })}
              type="checkbox"
            />
            <span>
              Allow a reviewed internal-network relay
              <span className="mt-0.5 block text-[11px] leading-4 text-content-muted">
                Enables private or loopback destinations. Metadata, link-local, multicast, and unspecified addresses remain blocked.
              </span>
            </span>
          </label>

          {plaintext ? (
            <div className="mt-3 rounded-control bg-accent-amber/10 px-3 py-2 text-xs leading-5 text-accent-amber" role="note">
              <div className="flex gap-2">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Plaintext is allowed only for an explicitly approved internal relay and cannot carry a username or password.
              </div>
              <label className={`mt-2 flex items-start gap-2 rounded-control border border-accent-amber/25 px-2 py-2 ${touchTarget}`}>
                <input
                  aria-label="Acknowledge exact plaintext relay"
                  checked={plaintextAcknowledged}
                  className="mt-0.5 size-4 shrink-0 accent-accent-amber"
                  disabled={busy}
                  onChange={(event) => setPlaintextAcknowledged(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>
                  I reviewed this exact plaintext relay ({form.host || "host"}:{form.port || "port"}) and accept unencrypted SMTP for this test and activation.
                </span>
              </label>
            </div>
          ) : null}

          {draftDirty ? (
            <p className="mt-3 rounded-control bg-accent-amber/10 px-3 py-2 text-xs leading-5 text-accent-amber" role="status">
              These fields are not part of the stored draft yet. Save before testing or activation.
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button className={primaryButton} disabled={busy || !plaintextApproved} onClick={() => void save()} type="button">
              <Save aria-hidden="true" className="size-3.5" />
              Save draft
            </button>
            <button className={quietButton} disabled={busy} onClick={() => setForm(formFrom(controller))} type="button">
              Reset fields
            </button>
          </div>
        </section>

        <aside className="grid min-w-0 content-start gap-3" aria-label="Email delivery status and actions">
          <section className="rounded-panel bg-surface-raised/50 p-4">
            <div className="flex items-center gap-2">
              <Mail aria-hidden="true" className="size-4 text-accent-cyan" />
              <h3 className="text-sm font-semibold text-content-primary">Status</h3>
            </div>
            <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-xs">
              <dt className="text-content-muted">Draft version</dt><dd className="font-mono text-content-primary">{email.draft.version}</dd>
              <dt className="text-content-muted">Active version</dt><dd className="font-mono text-content-primary">{email.active.version}</dd>
              <dt className="text-content-muted">Draft password</dt><dd className="text-content-primary">{email.draft.passwordConfigured ? "Configured" : "None"}</dd>
              <dt className="text-content-muted">Last draft test</dt><dd className="text-right text-content-primary">{email.draft.test ? `${email.draft.test.code} · ${formatDate(email.draft.test.attemptedAt)}` : "Never"}</dd>
              <dt className="text-content-muted">Last accepted send</dt><dd className="text-right text-content-primary">{formatDate(email.health.lastAcceptedAt)}</dd>
              <dt className="text-content-muted">Last failure</dt><dd className="text-right text-content-primary">{email.health.lastFailureCode ?? "None"}</dd>
            </dl>
            {tested ? (
              <p className="mt-3 flex gap-2 rounded-control bg-accent-green/10 px-3 py-2 text-xs leading-5 text-accent-green">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Draft {email.draft.version} passed a complete SMTP transaction.
              </p>
            ) : hasDraft ? (
              <p className="mt-3 rounded-control bg-accent-amber/10 px-3 py-2 text-xs leading-5 text-accent-amber">
                The current draft must be tested before activation.
              </p>
            ) : null}
          </section>

          <section className="rounded-panel bg-surface-raised/50 p-4">
            <h3 className="text-sm font-semibold text-content-primary">Test and activate</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              Testing sends one configuration-only message to this one-use recipient. The address is not stored.
            </p>
            <Field label="Test recipient">
              <input aria-label="Test recipient" autoComplete="email" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => setRecipient(event.currentTarget.value)} placeholder="you@example.com" type="email" value={recipient} />
            </Field>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={quietButton} disabled={busy || draftDirty || !plaintextApproved || !hasDraft || !recipient.trim()} onClick={() => void controller.actions.test(email.draft.version, recipient)} type="button">
                <Send aria-hidden="true" className="size-3.5" />
                Test draft
              </button>
              <button className={primaryButton} disabled={busy || draftDirty || !plaintextApproved || !tested} onClick={() => void controller.actions.activate(email.draft.version, email.active.version)} type="button">
                <CheckCircle2 aria-hidden="true" className="size-3.5" />
                Activate
              </button>
            </div>
          </section>

          <section className="rounded-panel bg-surface-raised/50 p-4">
            <h3 className="text-sm font-semibold text-content-primary">Runtime delivery</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              Each message loads the current enabled configuration from the database. Changes apply without restart.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {email.active.enabled ? (
                <button className={quietButton} disabled={busy} onClick={() => void controller.actions.disable(email.active.version)} type="button">
                  <Power aria-hidden="true" className="size-3.5" />
                  Disable
                </button>
              ) : (
                <button className={primaryButton} disabled={busy || !hasActive} onClick={() => void controller.actions.enable(email.active.version)} type="button">
                  <Power aria-hidden="true" className="size-3.5" />
                  Enable
                </button>
              )}
              <button className={quietButton} disabled={busy || controller.state.loading} onClick={() => void controller.actions.refresh()} type="button">
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Refresh
              </button>
            </div>
          </section>

          <section className="rounded-panel border border-accent-rose/25 bg-accent-rose/5 p-4">
            <h3 className="text-sm font-semibold text-content-primary">Clear configuration</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              Disables delivery and removes both draft and active configuration. Version counters remain monotonic.
            </p>
            <label className={`mt-3 flex items-start gap-2 text-xs text-content-secondary ${touchTarget}`}>
              <input checked={confirmClear} className="mt-0.5 size-4 accent-accent-rose" disabled={busy} onChange={(event) => setConfirmClear(event.currentTarget.checked)} type="checkbox" />
              I understand that the current SMTP configuration will be cleared.
            </label>
            <button
              className={`${dangerButton} mt-3`}
              disabled={busy || !confirmClear}
              onClick={async () => {
                const cleared = await controller.actions.clear({
                  confirm: true,
                  expectedActiveVersion: email.active.version,
                  expectedDraftVersion: email.draft.version
                });
                if (cleared) setConfirmClear(false);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Clear email delivery
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function AdminEmailSection({ active = true }: Readonly<{ active?: boolean }>) {
  const controller = useAdminEmailController({ active });
  const email = controller.state.email;

  if (!controller.state.loaded && controller.state.loading) {
    return (
      <div className="grid min-h-52 place-items-center px-4 py-12" role="status">
        <span className="inline-flex items-center gap-2 text-sm text-content-muted">
          <RefreshCw aria-hidden="true" className="size-4 animate-spin" />
          Loading email delivery settings…
        </span>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="grid gap-3 p-4">
        <Feedback controller={controller} />
        <p className="text-sm text-content-muted">Email delivery settings are unavailable.</p>
        <button className={quietButton} disabled={controller.state.loading} onClick={() => void controller.actions.refresh()} type="button">
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <AdminEmailContent
      controller={controller}
      key={`${email.draft.version}:${email.active.version}`}
    />
  );
}

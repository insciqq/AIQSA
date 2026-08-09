"use client";

import {
  type AdminEmailAxis,
  deriveAdminEmailPresentation
} from "@/components/admin/adminEmailPresentation";
import {
  AdminAvailabilityStatus,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  enableButton,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import { formatDate } from "@/components/admin/adminViewUtils";
import {
  useAdminEmailController,
  type AdminEmailController
} from "@/components/admin/useAdminEmailController";
import type {
  AdminEmailConfiguration,
  AdminEmailPasswordAction,
  AdminEmailState,
  AdminEmailTransportMode
} from "@/lib/contracts/email";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FilePenLine,
  Gauge,
  Power,
  RefreshCw,
  Save,
  Send,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

type EmailTask = "clear" | "commissioning" | "configuration" | "overview" | "runtime";

const tasks: ReadonlyArray<{
  description: string;
  icon: typeof Gauge;
  id: EmailTask;
  label: string;
}> = [
  { description: "Draft, active, and health", icon: Gauge, id: "overview", label: "Overview" },
  { description: "Connection and credentials", icon: FilePenLine, id: "configuration", label: "Draft configuration" },
  { description: "Exact test and activation", icon: Send, id: "commissioning", label: "Test & activate" },
  { description: "Delivery and safe health", icon: Activity, id: "runtime", label: "Runtime & health" },
  { description: "Remove both versions", icon: Trash2, id: "clear", label: "Clear configuration" }
];

const fieldLabel = "text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-metadata text-ink-muted";

function formFrom(email: AdminEmailState): EmailForm {
  const configuration = email.draft.configuration;
  return {
    allowInternalNetwork: configuration?.allowInternalNetwork ?? false,
    authenticationMode: configuration?.authentication.mode ?? "password",
    displayName: configuration?.from.displayName ?? "AIQSA",
    fromAddress: configuration?.from.address ?? "",
    host: configuration?.host ?? "",
    password: "",
    passwordAction: email.draft.passwordConfigured ? "preserve" : "replace",
    port: String(configuration?.port ?? 587),
    transport: configuration?.transport ?? "starttls_required",
    username: configuration?.authentication.mode === "password" ? configuration.authentication.username : ""
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
  if (form.authenticationMode === "none") return { confirm: true, kind: "clear" };
  return form.passwordAction === "replace"
    ? { kind: "replace", password: form.password }
    : { kind: "preserve" };
}

function toneClasses(tone: AdminEmailAxis["tone"]): string {
  if (tone === "critical") return "border-critical text-critical";
  if (tone === "inactive") return "border-trace-strong text-ink";
  if (tone === "positive") return "border-positive text-positive";
  if (tone === "proof") return "border-proof text-proof";
  if (tone === "warning") return "border-caution text-caution";
  return "border-trace-strong text-ink-muted";
}

function toneTextClass(tone: AdminEmailAxis["tone"]): string {
  if (tone === "critical") return "text-critical";
  if (tone === "inactive") return "text-ink";
  if (tone === "positive") return "text-positive";
  if (tone === "proof") return "text-proof";
  if (tone === "warning") return "text-caution";
  return "text-ink-muted";
}

function AxisFact({ availability, axis, label }: Readonly<{
  availability?: boolean;
  axis: AdminEmailAxis;
  label: string;
}>) {
  return (
    <div className={`min-w-0 border-l-2 pl-3 ${toneClasses(axis.tone)}`}>
      <dt className="text-metadata font-semibold uppercase tracking-[0.09em] text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
        {availability === undefined ? axis.label : <AdminAvailabilityStatus enabled={availability} />}
      </dd>
      <dd className="mt-1 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">{axis.detail}</dd>
    </div>
  );
}

function Feedback({ controller }: Readonly<{ controller: AdminEmailController }>) {
  if (!controller.state.error && !controller.state.notice) return null;
  return (
    <div className="grid gap-2 px-4 pt-4">
      {controller.state.error ? (
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs leading-5 text-critical sm:flex-row sm:items-start sm:justify-between" role="alert">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{controller.state.error}</span>
          <button className={quietButton} onClick={controller.actions.dismissError} type="button">Dismiss</button>
        </div>
      ) : null}
      {controller.state.notice ? (
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-positive bg-positive/10 px-3 py-2 text-xs leading-5 text-positive sm:flex-row sm:items-start sm:justify-between" role="status">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{controller.state.notice}</span>
          <button className={quietButton} onClick={controller.actions.dismissNotice} type="button">Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ children, help, label }: Readonly<{
  children: ReactNode;
  help?: string;
  label: string;
}>) {
  return (
    <label className="min-w-0">
      <span className={fieldLabel}>{label}</span>
      {children}
      {help ? <span className={`${helpText} block`}>{help}</span> : null}
    </label>
  );
}

function PlaintextAcknowledgement({
  acknowledged,
  busy,
  form,
  setAcknowledged
}: Readonly<{
  acknowledged: boolean;
  busy: boolean;
  form: EmailForm;
  setAcknowledged(value: boolean): void;
}>) {
  if (form.transport !== "plaintext_internal_no_auth") return null;
  return (
    <div className="border-l-2 border-caution bg-caution/10 px-3 py-3 text-xs leading-5 text-caution">
      <div className="flex gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>Plaintext is allowed only for an explicitly approved internal relay and cannot carry a username or password.</p>
      </div>
      <label className={`mt-3 flex items-start gap-2 border border-caution/25 px-2 py-2 ${touchTarget}`}>
        <input
          aria-label="Acknowledge exact plaintext relay"
          checked={acknowledged}
          className="mt-0.5 size-4 shrink-0 accent-proof"
          disabled={busy}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>I reviewed this exact plaintext relay ({form.host || "host"}:{form.port || "port"}) and accept unencrypted SMTP for this test and activation.</span>
      </label>
    </div>
  );
}

function EmailTaskIndex({
  email,
  onOpenTask,
  task
}: Readonly<{
  email: AdminEmailState;
  onOpenTask(task: EmailTask): void;
  task: EmailTask;
}>) {
  const presentation = deriveAdminEmailPresentation(email);
  return (
    <div className="min-w-0">
      <div className="border-b border-trace-subtle p-4">
        <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">SMTP delivery</p>
        <h3 className="mt-1 text-base font-semibold text-ink">Email tasks</h3>
        <dl className="mt-3 grid gap-2 text-xs">
          <div className="flex items-center justify-between gap-2"><dt className="text-ink-muted">Draft</dt><dd className={toneTextClass(presentation.draft.tone)}>{presentation.draft.label}</dd></div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-ink-muted">Active</dt>
            <dd className={toneTextClass(presentation.active.tone)}>
              {email.active.configuration
                ? <AdminAvailabilityStatus enabled={email.active.enabled} />
                : presentation.active.label}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2"><dt className="text-ink-muted">Health</dt><dd className={toneTextClass(presentation.health.tone)}>{presentation.health.label}</dd></div>
        </dl>
      </div>
      <nav className="p-2" aria-label="Email delivery tasks">
        {tasks.map((item) => {
          const Icon = item.icon;
          const active = item.id === task;
          return (
            <button
              className={`flex min-h-control w-full min-w-0 items-center gap-2 border-l-2 px-3 py-2 text-left ${active ? "border-proof bg-answer-paper text-ink" : "border-transparent text-ink-secondary hover:bg-control-hover hover:text-ink"}`}
              data-admin-task-opener="true"
              key={item.id}
              onClick={() => onOpenTask(item.id)}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{item.label}</span>
                <span className="mt-0.5 block truncate text-metadata text-ink-muted">{item.description}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 lg:hidden" />
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function OverviewTask({ email, onOpenTask }: Readonly<{
  email: AdminEmailState;
  onOpenTask(task: EmailTask): void;
}>) {
  const presentation = deriveAdminEmailPresentation(email);
  const nextTask: EmailTask = !email.draft.configuration || !presentation.tested
    ? !email.draft.configuration ? "configuration" : "commissioning"
    : !email.active.configuration
      ? "commissioning"
      : "runtime";
  const nextLabel = nextTask === "configuration"
    ? "Configure SMTP draft"
    : nextTask === "commissioning"
      ? email.active.configuration ? "Review test & activation" : "Test and activate"
      : "Review runtime";
  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        <AxisFact axis={presentation.draft} label="Draft" />
        <AxisFact
          availability={email.active.configuration ? email.active.enabled : undefined}
          axis={presentation.active}
          label="Active"
        />
        <AxisFact axis={presentation.health} label="Health" />
      </dl>
      <section className="border-l border-trace-strong pl-4">
        <h4 className="text-sm font-semibold text-ink">Safe staged delivery</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Saving and testing change only the mutable draft. Outgoing email keeps using the current enabled active version until the exact tested draft is activated.</p>
        <button className={`${primaryButton} mt-3`} onClick={() => onOpenTask(nextTask)} type="button">{nextLabel}</button>
      </section>
      <section className="border-t border-trace-subtle pt-4">
        <h4 className="text-sm font-semibold text-ink">Current facts</h4>
        <dl className="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
          <div><dt className="text-ink-muted">Draft version</dt><dd className="mt-1 font-mono text-ink">{email.draft.version}</dd></div>
          <div><dt className="text-ink-muted">Active version</dt><dd className="mt-1 font-mono text-ink">{email.active.version}</dd></div>
          <div><dt className="text-ink-muted">Draft password</dt><dd className="mt-1 text-ink">{email.draft.passwordConfigured ? "Configured · write-only" : "None"}</dd></div>
          <div><dt className="text-ink-muted">Last draft test</dt><dd className="mt-1 break-words text-ink [overflow-wrap:anywhere]">{email.draft.test ? `${email.draft.test.code} · ${formatDate(email.draft.test.attemptedAt)}` : "Never"}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function ConfigurationTask({
  busy,
  draftDirty,
  email,
  form,
  onReset,
  onSave,
  patchForm,
  plaintextAcknowledged,
  setPlaintextAcknowledged
}: Readonly<{
  busy: boolean;
  draftDirty: boolean;
  email: AdminEmailState;
  form: EmailForm;
  onReset(): void;
  onSave(): void;
  patchForm(patch: Partial<EmailForm>): void;
  plaintextAcknowledged: boolean;
  setPlaintextAcknowledged(value: boolean): void;
}>) {
  const plaintext = form.transport === "plaintext_internal_no_auth";
  const plaintextApproved = !plaintext || (
    form.authenticationMode === "none" &&
    form.allowInternalNetwork &&
    plaintextAcknowledged
  );
  const credentialsReady = form.authenticationMode === "none" || (
    Boolean(form.username.trim()) &&
    (form.passwordAction === "preserve" || Boolean(form.password))
  );
  const configurationReady = Boolean(
    form.host.trim() &&
    form.fromAddress.trim() &&
    Number.isInteger(Number(form.port)) &&
    Number(form.port) >= 1 &&
    Number(form.port) <= 65535 &&
    credentialsReady
  );
  return (
    <div className="grid gap-7">
      <section>
        <h4 className="text-sm font-semibold text-ink">Connection</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">Saving produces a new draft version. It does not affect outgoing email.</p>
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
          <Field label="From display name" help="Optional printable text.">
            <input aria-label="From display name" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ displayName: event.currentTarget.value })} type="text" value={form.displayName} />
          </Field>
        </div>
      </section>

      <section className="border-t border-trace-subtle pt-5">
        <h4 className="text-sm font-semibold text-ink">Security boundary</h4>
        <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
          <Field label="Transport security">
            <select aria-label="Transport security" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ transport: event.currentTarget.value as AdminEmailTransportMode })} value={form.transport}>
              <option value="starttls_required">STARTTLS required</option>
              <option value="implicit_tls">Implicit TLS</option>
              <option value="plaintext_internal_no_auth">Plaintext internal relay</option>
            </select>
          </Field>
          <label className={`flex min-h-control items-start gap-2 bg-control-surface px-3 py-2 text-xs text-ink-secondary ${touchTarget}`}>
            <input checked={form.allowInternalNetwork} className="mt-0.5 size-4 shrink-0 accent-proof" disabled={busy} onChange={(event) => patchForm({ allowInternalNetwork: event.currentTarget.checked })} type="checkbox" />
            <span>Allow a reviewed internal-network relay<span className="mt-0.5 block text-metadata text-ink-muted">Private and loopback destinations become eligible; metadata and unsafe address classes stay blocked.</span></span>
          </label>
        </div>
        <div className="mt-3">
          <PlaintextAcknowledgement acknowledged={plaintextAcknowledged} busy={busy} form={form} setAcknowledged={setPlaintextAcknowledged} />
        </div>
      </section>

      <section className="border-t border-trace-subtle pt-5">
        <h4 className="text-sm font-semibold text-ink">Authentication</h4>
        <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
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
          {form.authenticationMode === "password" ? (
            <Field label="Username">
              <input aria-label="Username" autoComplete="username" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ username: event.currentTarget.value })} required type="text" value={form.username} />
            </Field>
          ) : null}
          {form.authenticationMode === "password" ? (
            <Field label="Password action" help={email.draft.passwordConfigured ? "The stored password is write-only." : "A password is required before this draft can be saved."}>
              <select aria-label="Password action" className={`${inputClass} mt-1.5`} disabled={busy || !email.draft.passwordConfigured} onChange={(event) => patchForm({ passwordAction: event.currentTarget.value as EmailForm["passwordAction"], password: "" })} value={form.passwordAction}>
                {email.draft.passwordConfigured ? <option value="preserve">Keep stored password</option> : null}
                <option value="replace">Replace password</option>
              </select>
            </Field>
          ) : null}
          {form.authenticationMode === "password" && form.passwordAction === "replace" ? (
            <Field label="New password" help="Encrypted before persistence and never returned to this page.">
              <input aria-label="New password" autoComplete="new-password" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => patchForm({ password: event.currentTarget.value })} required type="password" value={form.password} />
            </Field>
          ) : null}
        </div>
        {form.authenticationMode === "none" ? <p className="mt-3 bg-workspace-rail/45 px-3 py-2 text-xs leading-5 text-ink-secondary">Saving without authentication explicitly clears any stored draft password.</p> : null}
      </section>

      {draftDirty ? <p className="border-l-2 border-caution bg-caution/10 px-3 py-2 text-xs leading-5 text-caution" role="status">These fields are not part of the stored draft yet. Save before testing or activation.</p> : null}
      <div className="flex flex-wrap gap-2 border-t border-trace-subtle pt-4">
        <button className={primaryButton} disabled={busy || !configurationReady || !plaintextApproved} onClick={onSave} type="button"><Save aria-hidden="true" className="size-3.5" />Save draft</button>
        <button className={quietButton} disabled={busy} onClick={onReset} type="button">Reset fields</button>
      </div>
    </div>
  );
}

function CommissioningTask({
  busy,
  controller,
  draftDirty,
  email,
  form,
  onActivated,
  plaintextAcknowledged,
  recipient,
  setPlaintextAcknowledged,
  setRecipient
}: Readonly<{
  busy: boolean;
  controller: AdminEmailController;
  draftDirty: boolean;
  email: AdminEmailState;
  form: EmailForm;
  onActivated(): void;
  plaintextAcknowledged: boolean;
  recipient: string;
  setPlaintextAcknowledged(value: boolean): void;
  setRecipient(value: string): void;
}>) {
  const presentation = deriveAdminEmailPresentation(email);
  const hasDraft = Boolean(email.draft.configuration);
  const plaintext = form.transport === "plaintext_internal_no_auth";
  const plaintextApproved = !plaintext || (
    form.authenticationMode === "none" &&
    form.allowInternalNetwork &&
    plaintextAcknowledged
  );
  const runTest = async () => {
    const oneUseRecipient = recipient;
    try {
      await controller.actions.test(email.draft.version, oneUseRecipient);
    } finally {
      setRecipient("");
    }
  };
  return (
    <div className="grid gap-6">
      <section>
        <h4 className="text-sm font-semibold text-ink">Test exact draft {email.draft.version}</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Testing sends one configuration-only message to a one-use recipient. The address is not stored. Accepted means the SMTP relay accepted the transaction; it does not prove inbox delivery.</p>
        {draftDirty ? <p className="mt-3 border-l-2 border-caution bg-caution/10 px-3 py-2 text-xs leading-5 text-caution">Unsaved fields differ from draft {email.draft.version}. Save them before testing.</p> : null}
        <div className="mt-4 max-w-xl">
          <Field label="Test recipient">
            <input aria-label="Test recipient" autoComplete="email" className={`${inputClass} mt-1.5`} disabled={busy} onChange={(event) => setRecipient(event.currentTarget.value)} placeholder="you@example.com" type="email" value={recipient} />
          </Field>
        </div>
        <div className="mt-3"><PlaintextAcknowledgement acknowledged={plaintextAcknowledged} busy={busy} form={form} setAcknowledged={setPlaintextAcknowledged} /></div>
        <button className={`${primaryButton} mt-4`} disabled={busy || draftDirty || !plaintextApproved || !hasDraft || !recipient.trim()} onClick={() => void runTest()} type="button">
          <Send aria-hidden="true" className="size-3.5" />Test draft
        </button>
      </section>

      <section className="border-t border-trace-subtle pt-5">
        <h4 className="text-sm font-semibold text-ink">Activate tested version</h4>
        <div className={`mt-3 border-l-2 px-3 py-3 text-xs leading-5 ${presentation.tested ? "border-positive bg-positive/10 text-positive" : "border-caution bg-caution/10 text-caution"}`}>
          {presentation.tested
            ? `Draft ${email.draft.version} passed a complete SMTP transaction and can replace active version ${email.active.version}.`
            : "The current draft must pass an exact test before activation."}
        </div>
        <p className="mt-3 text-xs leading-5 text-ink-muted">Activation is atomic. Failed tests or stale versions leave the current active configuration unchanged.</p>
        <button
          className={`${primaryButton} mt-4`}
          disabled={busy || draftDirty || !plaintextApproved || !presentation.tested}
          onClick={async () => {
            const activated = await controller.actions.activate(email.draft.version, email.active.version);
            if (activated) onActivated();
          }}
          type="button"
        >
          <CheckCircle2 aria-hidden="true" className="size-3.5" />Activate
        </button>
      </section>
    </div>
  );
}

function RuntimeTask({ controller, email, onRefresh }: Readonly<{
  controller: AdminEmailController;
  email: AdminEmailState;
  onRefresh(): void;
}>) {
  const presentation = deriveAdminEmailPresentation(email);
  const hasActive = Boolean(email.active.configuration);
  return (
    <div className="grid gap-6">
      <section>
        <h4 className="text-sm font-semibold text-ink">Runtime delivery</h4>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">Each message loads the current enabled active version from the database. Enable and disable apply without restart. SMTP is optional and never changes core application readiness.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {hasActive ? (
            <>
              <AdminAvailabilityStatus enabled={email.active.enabled} />
              {email.active.enabled ? (
                <button className={quietButton} disabled={controller.state.busy} onClick={() => void controller.actions.disable(email.active.version)} type="button"><Power aria-hidden="true" className="size-3.5" />Disable</button>
              ) : (
                <button className={enableButton} disabled={controller.state.busy} onClick={() => void controller.actions.enable(email.active.version)} type="button"><Power aria-hidden="true" className="size-3.5" />Enable</button>
              )}
            </>
          ) : (
            <span className="text-sm font-medium text-ink-secondary">Not configured</span>
          )}
          <button className={quietButton} disabled={controller.state.busy || controller.state.loading} onClick={onRefresh} type="button"><RefreshCw aria-hidden="true" className="size-3.5" />Refresh</button>
        </div>
      </section>
      <section className="border-t border-trace-subtle pt-5">
        <h4 className="text-sm font-semibold text-ink">Safe active health</h4>
        <div className={`mt-3 border-l-2 pl-3 ${toneClasses(presentation.health.tone)}`}>
          <p className="text-sm font-medium">{presentation.health.label}</p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">{presentation.health.detail}</p>
        </div>
        <dl className="mt-4 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
          <div><dt className="text-ink-muted">Health active version</dt><dd className="mt-1 font-mono text-ink">{email.health.activeVersion ?? "None"}</dd></div>
          <div><dt className="text-ink-muted">Last attempt</dt><dd className="mt-1 text-ink">{formatDate(email.health.lastAttemptAt)}</dd></div>
          <div><dt className="text-ink-muted">Last accepted send</dt><dd className="mt-1 text-ink">{formatDate(email.health.lastAcceptedAt)}</dd></div>
          <div><dt className="text-ink-muted">Last failure</dt><dd className="mt-1 break-words text-ink [overflow-wrap:anywhere]">{email.health.lastFailureCode ? `${email.health.lastFailureCode} · ${formatDate(email.health.lastFailureAt)}` : "None"}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function ClearTask({ controller, email, onCleared }: Readonly<{
  controller: AdminEmailController;
  email: AdminEmailState;
  onCleared(): void;
}>) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="max-w-3xl border-l-2 border-critical bg-critical/10 px-4 py-4">
      <h4 className="text-sm font-semibold text-ink">Clear email delivery</h4>
      <p className="mt-1 text-xs leading-5 text-ink-secondary">This disables delivery and removes both draft version {email.draft.version} and active version {email.active.version}, including their stored password generations and health. There is no restore or history action; counters remain monotonic.</p>
      <label className={`mt-4 flex items-start gap-2 text-xs text-ink-secondary ${touchTarget}`}>
        <input checked={confirm} className="mt-0.5 size-4 accent-proof" disabled={controller.state.busy} onChange={(event) => setConfirm(event.currentTarget.checked)} type="checkbox" />
        I understand that the current SMTP configuration will be cleared.
      </label>
      <button
        className={`${dangerButton} mt-4`}
        disabled={controller.state.busy || !confirm}
        onClick={async () => {
          const cleared = await controller.actions.clear({
            confirm: true,
            expectedActiveVersion: email.active.version,
            expectedDraftVersion: email.draft.version
          });
          if (cleared) {
            setConfirm(false);
            onCleared();
          }
        }}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />Clear email delivery
      </button>
    </section>
  );
}

function AdminEmailContent({ controller, email }: Readonly<{
  controller: AdminEmailController;
  email: AdminEmailState;
}>) {
  const [task, setTask] = useState<EmailTask>("overview");
  const [compactTaskOpen, setCompactTaskOpen] = useState(false);
  const [form, setForm] = useState<EmailForm>(() => formFrom(email));
  const [recipient, setRecipient] = useState("");
  const [plaintextAcknowledged, setPlaintextAcknowledged] = useState(false);
  const versionKey = `${email.draft.version}:${email.active.version}`;
  const synchronizedVersion = useRef(versionKey);

  useEffect(() => {
    if (synchronizedVersion.current === versionKey) return;
    synchronizedVersion.current = versionKey;
    setForm(formFrom(email));
    setPlaintextAcknowledged(false);
    setRecipient("");
  }, [email, versionKey]);

  const presentation = deriveAdminEmailPresentation(email);
  const draftDirty = JSON.stringify(form) !== JSON.stringify(formFrom(email));
  const valueDirty = draftDirty || recipient.length > 0;
  const busy = controller.state.busy;
  const discardDraft = () => {
    setForm(formFrom(email));
    setPlaintextAcknowledged(false);
    setRecipient("");
  };
  const requestDiscard = useAdminDraftProtection({
    dirty: valueDirty,
    onDiscard: discardDraft,
    owner: "email-delivery-draft",
    pending: valueDirty && busy
  });
  const current = tasks.find((item) => item.id === task) ?? tasks[0];
  const openTask = (nextTask: EmailTask) => {
    setTask(nextTask);
    setCompactTaskOpen(true);
  };
  const patchForm = (patch: Partial<EmailForm>) => {
    setPlaintextAcknowledged(false);
    setForm((currentForm) => ({ ...currentForm, ...patch }));
  };

  return (
    <div className="min-w-0">
      <Feedback controller={controller} />
      <div className="border-b border-trace-subtle px-4 py-3">
        <p className="text-xs text-ink-muted">Singleton SMTP delivery control plane · draft {email.draft.version} · active {email.active.version}</p>
      </div>
      <AdminTaskWorkspace detailOpen={compactTaskOpen} indexWidth="18rem">
        <AdminTaskIndexPane compactDetailOpen={compactTaskOpen} testId="email-task-index">
          <EmailTaskIndex email={email} onOpenTask={openTask} task={task} />
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen={compactTaskOpen} testId="email-task-detail">
          <article className="min-w-0 p-4 sm:p-5 lg:p-6">
            <AdminTaskBackButton label="Back to email tasks" onClick={() => setCompactTaskOpen(false)} />
            <header className="mb-6 border-b border-trace-subtle pb-4">
              <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Email delivery</p>
              <h3 className="mt-1 text-lg font-semibold tracking-tight text-ink">{current.label}</h3>
              <p className="mt-1 text-xs leading-5 text-ink-muted">{current.description}</p>
            </header>
            {task === "configuration" ? (
              <ConfigurationTask
                busy={busy}
                draftDirty={draftDirty}
                email={email}
                form={form}
                onReset={() => {
                  requestDiscard(discardDraft);
                }}
                onSave={() => void (async () => {
                  const saved = await controller.actions.save({
                    configuration: configurationFrom(form),
                    expectedDraftVersion: email.draft.version,
                    passwordAction: passwordActionFrom(form)
                  });
                  if (saved) openTask("commissioning");
                })()}
                patchForm={patchForm}
                plaintextAcknowledged={plaintextAcknowledged}
                setPlaintextAcknowledged={setPlaintextAcknowledged}
              />
            ) : task === "commissioning" ? (
              <CommissioningTask
                busy={busy}
                controller={controller}
                draftDirty={draftDirty}
                email={email}
                form={form}
                onActivated={() => openTask("runtime")}
                plaintextAcknowledged={plaintextAcknowledged}
                recipient={recipient}
                setPlaintextAcknowledged={setPlaintextAcknowledged}
                setRecipient={setRecipient}
              />
            ) : task === "runtime" ? (
              <RuntimeTask
                controller={controller}
                email={email}
                onRefresh={() => requestDiscard(() => void controller.actions.refresh())}
              />
            ) : task === "clear" ? (
              <ClearTask controller={controller} email={email} onCleared={() => openTask("overview")} />
            ) : (
              <OverviewTask email={email} onOpenTask={openTask} />
            )}
            {task !== "overview" ? (
              <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-trace-subtle pt-4 text-metadata leading-5 text-ink-muted">
                <span>Draft: {presentation.draft.label} · Health: {presentation.health.label}</span>
                {task !== "runtime" && email.active.configuration ? (
                  <span className="inline-flex items-center gap-1.5">
                    Runtime
                    <AdminAvailabilityStatus enabled={email.active.enabled} />
                  </span>
                ) : task !== "runtime" ? (
                  <span>Active: Not configured</span>
                ) : null}
              </div>
            ) : null}
          </article>
        </AdminTaskDetailPane>
      </AdminTaskWorkspace>
    </div>
  );
}

export function AdminEmailSection({
  active = true,
  onMutationCommitted
}: Readonly<{
  active?: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const controller = useAdminEmailController({ active, onMutationCommitted });
  const email = controller.state.email;

  if (!controller.state.loaded && controller.state.loading) {
    return (
      <div className="grid min-h-52 place-items-center px-4 py-12" role="status">
        <span className="inline-flex items-center gap-2 text-sm text-ink-muted"><RefreshCw aria-hidden="true" className="size-4 animate-spin" />Loading email delivery settings…</span>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="grid gap-3 p-4">
        <Feedback controller={controller} />
        <p className="text-sm text-ink-muted">Email delivery settings are unavailable.</p>
        <button className={quietButton} disabled={controller.state.loading} onClick={() => void controller.actions.refresh()} type="button"><RefreshCw aria-hidden="true" className="size-3.5" />Retry</button>
      </div>
    );
  }

  return <AdminEmailContent controller={controller} email={email} />;
}

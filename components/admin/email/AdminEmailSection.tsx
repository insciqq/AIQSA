"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import {
  emailDeliveryStatus,
  emailDraftFrom,
  emailFormDirty,
  emailFormEdits,
  emailFormFrom,
  emailFormValidation,
  emailFormWithTransport,
  transportLabels,
  type EmailDeliveryStatus,
  type EmailFieldErrors,
  type EmailFieldName,
  type EmailForm
} from "@/components/admin/email/emailView";
import {
  useAdminEmailController,
  type AdminEmailController
} from "@/components/admin/email/useAdminEmailController";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button, type UiV2MenuAction } from "@/components/ui-v2";
import type { AdminEmailState, AdminEmailTransportMode } from "@/lib/contracts/email";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";

const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";
const fieldErrorClass = "mt-1 block text-xs leading-5 text-critical";
const checkboxClass = "mt-0.5 size-4 shrink-0 accent-proof";

const pillTone: Record<EmailDeliveryStatus["tone"], string> = {
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive"
};

export type AdminEmailSectionProps = Readonly<{
  active?: boolean;
  /** The signed-in administrator's address; prefills “Send a test to”. */
  adminEmail?: string;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  onMutationCommitted?(): void | Promise<unknown>;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

type FieldControlProps = Readonly<{
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  id: string;
}>;

function Field({
  error,
  help,
  label,
  render
}: Readonly<{
  error?: string;
  help?: string;
  label: string;
  render(props: FieldControlProps): ReactNode;
}>) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="min-w-0">
      <label className={fieldLabelClass} htmlFor={id}>{label}</label>
      {render({ "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, id })}
      {help ? <span className={helpTextClass} id={helpId}>{help}</span> : null}
      {error ? <span className={fieldErrorClass} id={errorId}>{error}</span> : null}
    </div>
  );
}

function CheckboxField({
  checked,
  disabled,
  error,
  help,
  label,
  onChange
}: Readonly<{
  checked: boolean;
  disabled: boolean;
  error?: string;
  help?: string;
  label: string;
  onChange(next: boolean): void;
}>) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="min-w-0">
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          checked={checked}
          className={checkboxClass}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span className="min-w-0">
          {label}
          {help ? <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{help}</span> : null}
        </span>
      </label>
      {error ? <span className={`${fieldErrorClass} pl-6`} id={errorId}>{error}</span> : null}
    </div>
  );
}

/** The one delivery-state line on top of the page: a status word and where mail goes out from. */
function DeliveryState({ email }: Readonly<{ email: AdminEmailState }>) {
  const status = emailDeliveryStatus(email);
  return (
    <div className="min-w-0" data-testid="email-delivery-state" role="status">
      <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[status.tone]}`}
          data-status-tone={status.tone}
          data-testid="email-delivery-status"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {status.label}
        </span>
        <span className="min-w-0 break-words text-sm text-ink [overflow-wrap:anywhere]" data-testid="email-delivery-summary">
          {status.summary}
        </span>
      </p>
      {status.detail ? (
        <p className="mt-1.5 text-xs leading-5 text-ink-muted" data-testid="email-delivery-detail">{status.detail}</p>
      ) : null}
    </div>
  );
}

function EmailSettingsForm({
  adminEmail,
  controller,
  email
}: Readonly<{
  adminEmail: string;
  controller: AdminEmailController;
  email: AdminEmailState;
}>) {
  // The form is the last stored settings plus the edits in progress, so a
  // server change under an untouched field shows through while edits stay.
  const baseline = useMemo(() => emailFormFrom(email, ""), [email]);
  const [edits, setEdits] = useState<Partial<EmailForm>>({});
  const [testRecipient, setTestRecipient] = useState(adminEmail);
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<EmailFieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const failureId = useId();
  const busy = controller.state.busy;
  const form: EmailForm = { ...baseline, ...edits, plaintextAcknowledged: acknowledged, testRecipient };
  const dirty = emailFormDirty(form, baseline);
  const plaintext = form.transport === "plaintext_internal_no_auth";
  const passwordConfigured = email.draft.passwordConfigured;

  const patch = (update: (current: EmailForm) => EmailForm) => {
    const next = update(form);
    setEdits(emailFormEdits(next, baseline));
    setAcknowledged(next.plaintextAcknowledged);
    setTestRecipient(next.testRecipient);
    setFailure(null);
  };
  const set = <K extends keyof EmailForm>(key: K, value: EmailForm[K]) => {
    patch((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const field = key as EmailFieldName;
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };
  const discard = useCallback(() => {
    setEdits({});
    setAcknowledged(false);
    setErrors({});
    setFailure(null);
  }, []);
  useBeforeUnloadGuard(dirty);

  const submit = async () => {
    if (busy) return;
    const validation = emailFormValidation(form, passwordConfigured);
    setErrors(validation);
    setFailure(null);
    if (Object.values(validation).some(Boolean)) {
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
      return;
    }
    const outcome = await controller.actions.testAndActivate({
      draft: emailDraftFrom(form, email),
      testRecipient: form.testRecipient.trim()
    });
    if (outcome.ok) {
      discard();
      return;
    }
    setFailure(outcome.message);
  };

  return (
    <form
      aria-describedby={failure ? failureId : undefined}
      aria-label="Email settings"
      className={`${cardClass} max-w-[760px]`}
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      ref={formRef}
    >
      <div className="flex flex-col gap-6 px-5 py-5">
        <section aria-labelledby={`${formId}-server`} className="grid gap-4">
          <h2 className={sectionHeadingClass} id={`${formId}-server`}>Mail server</h2>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field
              error={errors.host}
              label="Host"
              render={(props) => (
                <input
                  {...props}
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  onChange={(event) => set("host", event.currentTarget.value)}
                  placeholder="smtp.example.com"
                  spellCheck={false}
                  type="text"
                  value={form.host}
                />
              )}
            />
            <Field
              error={errors.port}
              label="Port"
              render={(props) => (
                <input
                  {...props}
                  className={inputClass}
                  disabled={busy}
                  inputMode="numeric"
                  max={65_535}
                  min={1}
                  onChange={(event) => set("port", event.currentTarget.value)}
                  type="number"
                  value={form.port}
                />
              )}
            />
          </div>
          <Field
            label="Transport security"
            render={(props) => (
              <select
                {...props}
                className={inputClass}
                disabled={busy}
                onChange={(event) => {
                  const transport = event.currentTarget.value as AdminEmailTransportMode;
                  patch((current) => emailFormWithTransport(current, transport));
                  setErrors({});
                }}
                value={form.transport}
              >
                {(Object.keys(transportLabels) as AdminEmailTransportMode[]).map((mode) => (
                  <option key={mode} value={mode}>{transportLabels[mode]}</option>
                ))}
              </select>
            )}
          />
          <CheckboxField
            checked={form.allowInternalNetwork}
            disabled={busy}
            error={errors.allowInternalNetwork}
            help="For a mail server on the internal network."
            label="Allow a private or loopback address"
            onChange={(next) => set("allowInternalNetwork", next)}
          />
          {plaintext ? (
            <div className="rounded-[10px] border border-caution/25 bg-caution/5 px-3 py-3" data-testid="email-plaintext-notice">
              <p className="text-xs leading-5 text-caution">
                Mail to this relay is sent without encryption, so it cannot use a username or password. Use it only for a relay on the internal network.
              </p>
              <div className="mt-2">
                <CheckboxField
                  checked={form.plaintextAcknowledged}
                  disabled={busy}
                  error={errors.plaintextAcknowledged}
                  label={`I accept unencrypted delivery to ${form.host.trim() || "this relay"}`}
                  onChange={(next) => set("plaintextAcknowledged", next)}
                />
              </div>
            </div>
          ) : null}
        </section>

        <section aria-labelledby={`${formId}-sender`} className="grid gap-4">
          <h2 className={sectionHeadingClass} id={`${formId}-sender`}>Sender</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              error={errors.fromAddress}
              label="From address"
              render={(props) => (
                <input
                  {...props}
                  autoComplete="off"
                  className={inputClass}
                  disabled={busy}
                  onChange={(event) => set("fromAddress", event.currentTarget.value)}
                  placeholder="noreply@example.com"
                  spellCheck={false}
                  type="email"
                  value={form.fromAddress}
                />
              )}
            />
            <Field
              help="Optional."
              label="From name"
              render={(props) => (
                <input
                  {...props}
                  className={inputClass}
                  disabled={busy}
                  onChange={(event) => set("fromName", event.currentTarget.value)}
                  type="text"
                  value={form.fromName}
                />
              )}
            />
          </div>
        </section>

        <section aria-labelledby={`${formId}-auth`} className="grid gap-4">
          <h2 className={sectionHeadingClass} id={`${formId}-auth`}>Sign-in</h2>
          <Field
            help={plaintext ? "An unencrypted relay cannot use a username or password." : undefined}
            label="Authentication"
            render={(props) => (
              <select
                {...props}
                className={inputClass}
                disabled={busy || plaintext}
                onChange={(event) => {
                  const mode = event.currentTarget.value as EmailForm["authenticationMode"];
                  patch((current) => ({ ...current, authenticationMode: mode, password: "" }));
                  setErrors((current) => ({ ...current, password: undefined, username: undefined }));
                }}
                value={form.authenticationMode}
              >
                <option value="password">Username and password</option>
                <option value="none">None</option>
              </select>
            )}
          />
          {form.authenticationMode === "password" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                error={errors.username}
                label="Username"
                render={(props) => (
                  <input
                    {...props}
                    autoComplete="off"
                    className={inputClass}
                    disabled={busy}
                    onChange={(event) => set("username", event.currentTarget.value)}
                    spellCheck={false}
                    type="text"
                    value={form.username}
                  />
                )}
              />
              <Field
                error={errors.password}
                help={passwordConfigured
                  ? "Leave blank to keep the stored password. It is never shown here."
                  : "Stored encrypted and never shown again."}
                label="Password"
                render={(props) => (
                  <input
                    {...props}
                    autoComplete="new-password"
                    className={inputClass}
                    disabled={busy}
                    onChange={(event) => set("password", event.currentTarget.value)}
                    type="password"
                    value={form.password}
                  />
                )}
              />
            </div>
          ) : null}
        </section>

        <section aria-labelledby={`${formId}-test`} className="grid gap-4">
          <h2 className={sectionHeadingClass} id={`${formId}-test`}>Test</h2>
          <Field
            error={errors.testRecipient}
            help="One message goes here before the settings take effect. The address is not stored."
            label="Send a test to"
            render={(props) => (
              <input
                {...props}
                autoComplete="email"
                className={`${inputClass} sm:max-w-[24rem]`}
                disabled={busy}
                onChange={(event) => set("testRecipient", event.currentTarget.value)}
                spellCheck={false}
                type="email"
                value={form.testRecipient}
              />
            )}
          />
        </section>

        {failure ? (
          <p
            className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical"
            data-testid="email-test-failure"
            id={failureId}
            role="alert"
          >
            {failure}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-trace-subtle px-5 py-4">
        <UiV2Button busy={busy} data-testid="email-test-and-save" tone="primary" type="submit">
          Test &amp; Save
        </UiV2Button>
        <span className="min-w-0 text-xs leading-5 text-ink-muted">
          A test message goes to that address first. If it fails, the current delivery settings stay as they are.
        </span>
      </div>
    </form>
  );
}

/**
 * Email page (PRD 5.12): the delivery-state line, one form for the mail
 * server, sender, sign-in and the test address, and `Test & Save`, which
 * stores, tests and activates as one server operation (B6). Disable/Enable
 * and Clear configuration live in the topbar `⋯`.
 */
export function AdminEmailSection({
  active = true,
  adminEmail = "",
  feedback,
  onMutationCommitted,
  requestConfirmation
}: AdminEmailSectionProps) {
  const controller = useAdminEmailController({
    active,
    onError: feedback.reportError,
    onMutationCommitted,
    onNotice: feedback.reportNotice
  });
  const { busy, email, error, loaded, loading } = controller.state;

  const requestClear = useCallback(() => {
    requestConfirmation({
      body: "Delivery stops and the mail server settings and password are removed. Invitations, sign-up verification and password resets are not sent until email is set up again.",
      confirmLabel: "Clear configuration",
      dialogLabel: "Clear email configuration",
      icon: "trash",
      onConfirm: async () => {
        await controller.actions.clear();
      },
      testId: "admin-confirm-clear-email",
      title: "Clear email configuration?",
      tone: "destructive"
    });
  }, [controller.actions, requestConfirmation]);

  const topbar = useMemo<AdminShellTopbar>(() => {
    if (!email || (!email.active.configuration && !email.draft.configuration)) return { title: "Email" };
    const actions: UiV2MenuAction[] = [];
    if (email.active.configuration) {
      actions.push(email.active.enabled
        ? { disabled: busy, label: "Disable", onSelect: () => void controller.actions.setEnabled(false) }
        : { disabled: busy, label: "Enable", onSelect: () => void controller.actions.setEnabled(true) });
    }
    actions.push({
      disabled: busy,
      icon: "trash",
      label: "Clear configuration",
      onSelect: requestClear,
      separatorBefore: actions.length > 0,
      tone: "destructive"
    });
    return { actions: <AdminTopbarMenu actions={actions} label="More actions" />, title: "Email" };
  }, [busy, controller.actions, email, requestClear]);
  useAdminSectionTopbar(topbar);

  if (!email) {
    return (
      <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-email-section" role={loaded && error ? "alert" : "status"}>
        {loaded && error ? (
          <>
            <p className="text-sm font-semibold text-ink-secondary">{error}</p>
            <UiV2Button className="mt-4" disabled={loading} onClick={() => void controller.actions.refresh()} tone="ghost" type="button">
              Try again
            </UiV2Button>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Loading email settings…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-email-section">
      <DeliveryState email={email} />
      <EmailSettingsForm adminEmail={adminEmail} controller={controller} email={email} />
    </div>
  );
}

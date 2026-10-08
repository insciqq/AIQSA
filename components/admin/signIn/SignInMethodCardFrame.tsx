"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  formatSignInTime,
  signInDraftActivatable,
  signInEnvironmentVariables,
  signInFailureMessage,
  signInMethodLabels,
  signInStatusPresentation,
  signInTestMessage
} from "@/components/admin/signIn/signInView";
import type { AdminSignInController, AdminSignInDraftInput } from "@/components/admin/signIn/useAdminSignInController";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminSignInMethodState, AdminSignInSecretAction } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { useId, useRef, useState, type ReactNode } from "react";

const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";
const fieldErrorClass = "mt-1 block text-xs leading-5 text-critical";
const lineClass = "text-xs leading-5 text-ink-muted";

const pillTone = {
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive"
} as const;

/** The props every method card receives from the Sign-in section. */
export type AdminSignInMethodCardProps<M extends AuthSignInMethod = AuthSignInMethod> = Readonly<{
  /** `AIQSA_APP_BASE_URL`, for the callback URLs the card shows. */
  appBaseUrl: string;
  controller: AdminSignInController;
  state: AdminSignInMethodState<M>;
}>;

/** A card's unsaved edits, as the frame's Save button needs them. */
export type SignInCardDraft = Readonly<{
  /** The draft to save, or null after the card marked its invalid fields. */
  build(): AdminSignInDraftInput | null;
  dirty: boolean;
  /** Drops the card's local edits after the server stored them. */
  reset(): void;
}>;

/** A write-only secret field's change: blank keeps the stored value, an explicit clear removes it. */
export function signInSecretAction(value: string, cleared = false): AdminSignInSecretAction {
  if (cleared) return { confirm: true, kind: "clear" };
  return value ? { kind: "replace", value } : { kind: "preserve" };
}

type FieldControlProps = Readonly<{
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  id: string;
}>;

export function SignInField({
  error,
  help,
  label,
  render
}: Readonly<{
  error?: string;
  help?: ReactNode;
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

export function SignInTextField({
  disabled,
  error,
  help,
  label,
  onChange,
  placeholder,
  value
}: Readonly<{
  disabled: boolean;
  error?: string;
  help?: ReactNode;
  label: string;
  onChange(value: string): void;
  placeholder?: string;
  value: string;
}>) {
  return (
    <SignInField
      error={error}
      help={help}
      label={label}
      render={(props) => (
        <input
          {...props}
          autoComplete="off"
          className={inputClass}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          spellCheck={false}
          type="text"
          value={value}
        />
      )}
    />
  );
}

/**
 * A write-only secret: the stored value is never sent to the browser, so the field starts
 * empty and says whether a value is stored. An optional secret also offers an explicit
 * removal (`clear`), which `signInSecretAction(value, cleared)` turns into the clear action.
 */
export function SignInSecretField({
  clear,
  configured,
  disabled,
  error,
  label,
  onChange,
  value
}: Readonly<{
  clear?: Readonly<{ cleared: boolean; onChange(cleared: boolean): void }>;
  configured: boolean;
  disabled: boolean;
  error?: string;
  label: string;
  onChange(value: string): void;
  value: string;
}>) {
  const cleared = clear?.cleared === true;
  return (
    <SignInField
      error={error}
      help={
        <>
          {cleared
            ? "The stored value is removed when you save."
            : configured ? "Stored. Leave blank to keep it; it is never shown here." : "Stored encrypted and never shown again."}
          {clear && configured ? (
            <label className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
              <input
                checked={cleared}
                className="size-4 shrink-0 accent-proof"
                disabled={disabled}
                onChange={(event) => clear.onChange(event.currentTarget.checked)}
                type="checkbox"
              />
              Remove the stored value
            </label>
          ) : null}
        </>
      }
      label={label}
      render={(props) => (
        <input
          {...props}
          autoComplete="new-password"
          className={inputClass}
          disabled={disabled || cleared}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={configured && !cleared ? "••••••••" : undefined}
          spellCheck={false}
          type="password"
          value={value}
        />
      )}
    />
  );
}

/** A value the administrator copies into the identity provider, such as a callback URL. */
export function SignInCopyValue({ label, value }: Readonly<{ label: string; value: string }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      inputRef.current?.select();
    }
  };
  return (
    <SignInField
      label={label}
      render={(props) => (
        <div className="flex min-w-0 gap-2">
          <input
            {...props}
            className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={inputRef}
            type="text"
            value={value}
          />
          <UiV2Button icon={copied ? "check" : "copy"} onClick={() => void copy()} tone="ghost" type="button">
            {copied ? "Copied" : "Copy"}
          </UiV2Button>
        </div>
      )}
    />
  );
}

function StatusPill({ state }: Readonly<{ state: AdminSignInMethodState }>) {
  const status = signInStatusPresentation(state.status);
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[status.tone]}`}
      data-status={state.status}
      data-testid="admin-sign-in-status"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {status.label}
    </span>
  );
}

function EnvironmentHint({ state }: Readonly<{ state: AdminSignInMethodState }>) {
  const variables = signInEnvironmentVariables[state.method];
  if (!variables || !state.environmentConfigured) return null;
  const label = signInMethodLabels[state.method];
  return (
    <div className="rounded-[10px] border border-trace-subtle bg-control-surface px-3 py-2.5 text-xs leading-5 text-ink-secondary" data-testid="admin-sign-in-environment">
      <p>
        {state.status === "active_admin"
          ? `The configuration here overrides the environment variables `
          : `${label} sign-in comes from the environment variables `}
        {variables.map((variable, index) => (
          <span key={variable}>
            {index > 0 ? " and " : null}
            <code className="font-mono text-metadata [overflow-wrap:anywhere]">{variable}</code>
          </span>
        ))}
        .
      </p>
      <p className="mt-1">
        {state.status === "active_admin"
          ? "Remove them from the environment once you no longer need the fallback."
          : "To manage it here: enter the same values, Test, Activate, then remove the variables."}
      </p>
    </div>
  );
}

function StateLines({ state }: Readonly<{ state: AdminSignInMethodState }>) {
  const test = state.draft.test;
  const health = state.health;
  const failureAt = formatSignInTime(health.lastFailureAt);
  const acceptedAt = formatSignInTime(health.lastAcceptedAt);
  const recentFailure = health.lastFailureCode && failureAt &&
    (!health.lastAcceptedAt || (health.lastFailureAt ?? "") > health.lastAcceptedAt);
  return (
    <div className="flex flex-col gap-1" data-testid="admin-sign-in-state">
      {state.problem ? (
        <p className="text-xs leading-5 text-critical" role="alert">
          {state.problem === "secret_unreadable"
            ? "The stored secret cannot be read. Enter it again, save, test and activate."
            : "The stored settings are no longer valid. Check the fields, save, test and activate."}
        </p>
      ) : null}
      {state.draft.config ? (
        <p className={lineClass}>
          {state.draft.matchesActive ? "The saved settings are active." : "The saved settings are not active yet."}
        </p>
      ) : null}
      {test && !state.draft.matchesActive ? (
        <p className={test.passed ? lineClass : "text-xs leading-5 text-critical"} data-testid="admin-sign-in-test">
          {test.passed ? "Test passed: " : "Test failed: "}
          {signInTestMessage(test.code)}
        </p>
      ) : null}
      {recentFailure ? (
        <p className="text-xs leading-5 text-caution" data-testid="admin-sign-in-health">
          Last sign-in failed {failureAt}: {signInFailureMessage(health.lastFailureCode ?? "")}.
        </p>
      ) : acceptedAt ? (
        <p className={lineClass} data-testid="admin-sign-in-health">Last sign-in accepted {acceptedAt}.</p>
      ) : null}
    </div>
  );
}

/**
 * The shared frame of a sign-in method card: status, environment hint, values to copy into
 * the IdP, the method's own fields, and Save → Test → Activate / Disable. Method cards render
 * only their fields and hand the frame a `SignInCardDraft`.
 */
export function SignInMethodCardFrame({
  children,
  controller,
  copyValues = [],
  description,
  draft,
  state,
  title
}: Readonly<{
  children: ReactNode;
  controller: AdminSignInController;
  copyValues?: readonly Readonly<{ label: string; value: string }>[];
  description: ReactNode;
  draft: SignInCardDraft;
  state: AdminSignInMethodState;
  title?: string;
}>) {
  const headingId = useId();
  const messageId = useId();
  const [message, setMessage] = useState<string | null>(null);
  const busy = controller.state.busy !== null;
  const ownBusy = controller.state.busy === state.method;
  const label = title ?? signInMethodLabels[state.method];
  const saved = Boolean(state.draft.config);
  useBeforeUnloadGuard(draft.dirty);

  const run = async (operation: () => Promise<{ message: string; ok: false } | { ok: true }>) => {
    setMessage(null);
    const outcome = await operation();
    if (!outcome.ok && outcome.message) setMessage(outcome.message);
    return outcome.ok;
  };

  const save = async () => {
    const next = draft.build();
    if (!next) return;
    if (await run(() => controller.actions.saveDraft(state.method, next))) draft.reset();
  };

  return (
    <section
      aria-labelledby={headingId}
      className={`${cardClass} flex min-w-0 flex-col`}
      data-method={state.method}
      data-testid={`admin-sign-in-card-${state.method}`}
    >
      <header className="flex min-w-0 flex-col gap-1.5 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="text-[15px] font-semibold text-ink" id={headingId}>{label}</h3>
          <StatusPill state={state} />
        </div>
        <p className="text-xs leading-5 text-ink-muted">{description}</p>
      </header>
      <form
        aria-describedby={message ? messageId : undefined}
        aria-label={`${label} settings`}
        className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <EnvironmentHint state={state} />
        {copyValues.length ? (
          <div className="grid gap-3">
            <h4 className={sectionHeadingClass}>Values for the identity provider</h4>
            {copyValues.map((value) => <SignInCopyValue key={value.label} label={value.label} value={value.value} />)}
          </div>
        ) : null}
        <fieldset className="grid min-w-0 gap-4" disabled={busy}>
          {children}
        </fieldset>
        <StateLines state={state} />
        {message ? (
          <p
            className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical"
            data-testid="admin-sign-in-message"
            id={messageId}
            role="alert"
          >
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-trace-subtle pt-4">
          <UiV2Button busy={ownBusy && draft.dirty} disabled={busy || !draft.dirty} tone={draft.dirty ? "primary" : "ghost"} type="submit">
            Save
          </UiV2Button>
          {state.requiresTest ? (
            <UiV2Button
              disabled={busy || draft.dirty || !saved || state.draft.matchesActive}
              onClick={() => void run(() => controller.actions.test(state.method))}
              tone="ghost"
              type="button"
            >
              Test
            </UiV2Button>
          ) : null}
          <UiV2Button
            disabled={busy || draft.dirty || !signInDraftActivatable(state)}
            onClick={() => void run(() => controller.actions.activate(state.method))}
            tone={!draft.dirty && signInDraftActivatable(state) ? "primary" : "ghost"}
            type="button"
          >
            Activate
          </UiV2Button>
          {state.status === "active_admin" ? (
            <UiV2Button
              disabled={busy}
              onClick={() => {
                setMessage(null);
                controller.actions.requestDisable(state.method, setMessage);
              }}
              tone="destructive"
              type="button"
            >
              Disable
            </UiV2Button>
          ) : null}
          <span className={`${lineClass} min-w-0 basis-full sm:basis-auto`}>
            {draft.dirty
              ? "Unsaved changes."
              : state.requiresTest && saved && !state.draft.matchesActive && !state.draft.test?.passed
                ? "Test the saved settings, then activate them."
                : null}
          </span>
        </div>
      </form>
    </section>
  );
}

import { formatDate } from "@/components/admin/adminViewUtils";
import type {
  AdminEmailAttemptCode,
  AdminEmailDraftInput,
  AdminEmailState,
  AdminEmailTransportMode
} from "@/lib/contracts/email";

/** The one Email form (PRD 5.12). Strings keep what the administrator typed. */
export type EmailForm = Readonly<{
  allowInternalNetwork: boolean;
  authenticationMode: "none" | "password";
  fromAddress: string;
  fromName: string;
  host: string;
  /** Empty means "keep the stored password" when one is stored. */
  password: string;
  /** Explicit per-attempt acknowledgement of an unencrypted relay; never stored. */
  plaintextAcknowledged: boolean;
  port: string;
  testRecipient: string;
  transport: AdminEmailTransportMode;
  username: string;
}>;

export type EmailFieldName =
  | "allowInternalNetwork"
  | "fromAddress"
  | "host"
  | "password"
  | "plaintextAcknowledged"
  | "port"
  | "testRecipient"
  | "username";

export type EmailFieldErrors = Partial<Record<EmailFieldName, string>>;

export const transportLabels: Readonly<Record<AdminEmailTransportMode, string>> = {
  implicit_tls: "TLS",
  plaintext_internal_no_auth: "Unencrypted (internal relay)",
  starttls_required: "STARTTLS"
};

export const transportDefaultPort: Readonly<Record<AdminEmailTransportMode, number>> = {
  implicit_tls: 465,
  plaintext_internal_no_auth: 25,
  starttls_required: 587
};

const DEFAULT_FROM_NAME = "AIQSA";

/** Seeds the form from the last stored settings (the latest attempt, else the active ones). */
export function emailFormFrom(email: AdminEmailState, testRecipient: string): EmailForm {
  const configuration = email.draft.configuration ?? email.active.configuration;
  return {
    allowInternalNetwork: configuration?.allowInternalNetwork ?? false,
    authenticationMode: configuration?.authentication.mode ?? "password",
    fromAddress: configuration?.from.address ?? "",
    fromName: configuration ? configuration.from.displayName ?? "" : DEFAULT_FROM_NAME,
    host: configuration?.host ?? "",
    password: "",
    plaintextAcknowledged: false,
    port: String(configuration?.port ?? transportDefaultPort.starttls_required),
    testRecipient,
    transport: configuration?.transport ?? "starttls_required",
    username: configuration?.authentication.mode === "password" ? configuration.authentication.username : ""
  };
}

const storedFields = [
  "allowInternalNetwork",
  "authenticationMode",
  "fromAddress",
  "fromName",
  "host",
  "password",
  "port",
  "transport",
  "username"
] as const satisfies readonly (keyof EmailForm)[];

/**
 * The stored fields of `form` that differ from `baseline` (a typed password
 * always counts); the test address and the acknowledgement are not settings.
 */
export function emailFormEdits(form: EmailForm, baseline: EmailForm): Partial<EmailForm> {
  const edits: Partial<Record<keyof EmailForm, EmailForm[keyof EmailForm]>> = {};
  for (const field of storedFields) {
    if (form[field] !== baseline[field]) edits[field] = form[field];
  }
  return edits as Partial<EmailForm>;
}

/** True when any stored setting differs from `baseline`. */
export function emailFormDirty(form: EmailForm, baseline: EmailForm): boolean {
  return Object.keys(emailFormEdits(form, baseline)).length > 0;
}

/**
 * Switching transport keeps the port unless it was the previous transport's
 * default, and an unencrypted relay cannot carry a username or password.
 */
export function emailFormWithTransport(form: EmailForm, transport: AdminEmailTransportMode): EmailForm {
  const port = form.port === String(transportDefaultPort[form.transport])
    ? String(transportDefaultPort[transport])
    : form.port;
  const plaintext = transport === "plaintext_internal_no_auth";
  return {
    ...form,
    authenticationMode: plaintext ? "none" : form.authenticationMode,
    password: plaintext ? "" : form.password,
    plaintextAcknowledged: false,
    port,
    transport
  };
}

function looksLikeMailbox(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1 && !/\s/u.test(value);
}

export function emailFormValidation(form: EmailForm, passwordConfigured: boolean): EmailFieldErrors {
  const errors: EmailFieldErrors = {};
  const host = form.host.trim();
  if (!host || /[\s/@:]/u.test(host)) errors.host = "Enter the mail server host name.";
  const port = Number(form.port);
  if (!/^\d+$/u.test(form.port.trim()) || port < 1 || port > 65_535) {
    errors.port = "Enter a port between 1 and 65535.";
  }
  if (!looksLikeMailbox(form.fromAddress.trim())) errors.fromAddress = "Enter the sender address.";
  if (form.authenticationMode === "password") {
    if (!form.username.trim()) errors.username = "Enter the username.";
    if (!form.password && !passwordConfigured) errors.password = "Enter the password.";
  }
  if (form.transport === "plaintext_internal_no_auth") {
    if (!form.allowInternalNetwork) {
      errors.allowInternalNetwork = "An unencrypted relay must be a private address; allow private addresses first.";
    }
    if (!form.plaintextAcknowledged) errors.plaintextAcknowledged = "Confirm unencrypted delivery to this relay.";
  }
  if (!looksLikeMailbox(form.testRecipient.trim())) {
    errors.testRecipient = "Enter the address that receives the test message.";
  }
  return errors;
}

/** The wire settings for `test_and_activate`; the password travels only when it was typed. */
export function emailDraftFrom(form: EmailForm, email: AdminEmailState): AdminEmailDraftInput {
  return {
    configuration: {
      allowInternalNetwork: form.allowInternalNetwork,
      authentication: form.authenticationMode === "password"
        ? { mode: "password", username: form.username.trim() }
        : { mode: "none" },
      from: {
        address: form.fromAddress.trim(),
        displayName: form.fromName.trim() || null
      },
      host: form.host.trim(),
      port: Number(form.port),
      transport: form.transport
    },
    expectedDraftVersion: email.draft.version,
    passwordAction: form.authenticationMode === "none"
      ? { confirm: true, kind: "clear" }
      : form.password
        ? { kind: "replace", password: form.password }
        : { kind: "preserve" }
  };
}

const attemptMessages: Readonly<Record<AdminEmailAttemptCode, string>> = {
  accepted: "The mail server accepted the message.",
  ambiguous_after_data: "The mail server did not confirm the message; it may or may not have been sent.",
  invalid_configuration: "The stored settings are incomplete. Check the fields and try again.",
  overloaded: "Too many test messages are being sent right now. Wait a moment and try again.",
  secret_unreadable: "The stored password cannot be read. Enter it again.",
  smtp_address_forbidden: "The mail server address is not allowed. A private address needs the private-address option.",
  smtp_authentication_failed: "The mail server rejected the username or password.",
  smtp_authentication_unavailable: "The mail server does not offer password sign-in on this connection.",
  smtp_command_timeout: "The mail server stopped responding.",
  smtp_connect_timeout: "The mail server did not answer in time.",
  smtp_connection_failed: "Could not connect to the mail server.",
  smtp_data_rejected: "The mail server rejected the message content.",
  smtp_dns_failed: "The mail server host name could not be resolved.",
  smtp_ehlo_failed: "The mail server rejected the greeting.",
  smtp_greeting_rejected: "The mail server refused the connection.",
  smtp_invalid_input: "The test address is not valid.",
  smtp_protocol_error: "The mail server answered in an unexpected way.",
  smtp_recipient_rejected: "The mail server rejected the test address.",
  smtp_reply_limit: "The mail server sent an oversized reply.",
  smtp_sender_rejected: "The mail server rejected the sender address.",
  smtp_starttls_failed: "STARTTLS failed on the mail server.",
  smtp_starttls_unavailable: "The mail server does not offer STARTTLS. Choose TLS or check the port.",
  smtp_tls_failed: "The TLS connection to the mail server failed. Check the host name and its certificate.",
  smtp_total_timeout: "Sending the test message took too long."
};

export function emailAttemptMessage(code: AdminEmailAttemptCode): string {
  return attemptMessages[code];
}

export type EmailDeliveryStatus = Readonly<{
  /** The last test or delivery outcome, or null when there is none to report. */
  detail: string | null;
  label: "Disabled" | "Failing" | "Not configured" | "Working";
  summary: string;
  tone: "critical" | "neutral" | "ok";
}>;

/** The one delivery-state line on top of the Email page (PRD 5.12). */
export function emailDeliveryStatus(email: AdminEmailState): EmailDeliveryStatus {
  const active = email.active.configuration;
  const test = email.draft.test && email.draft.test.version === email.draft.version ? email.draft.test : null;
  const testDetail = test
    ? test.tested
      ? `Test message sent · ${formatDate(test.attemptedAt)}`
      : `Last test failed: ${emailAttemptMessage(test.code)} · ${formatDate(test.attemptedAt)}`
    : null;

  if (!active) {
    return {
      detail: testDetail,
      label: "Not configured",
      summary: "Email is not set up. Invitations, sign-up verification and password resets are not sent.",
      tone: "neutral"
    };
  }
  const route = `${active.from.address} via ${active.host}:${active.port} (${transportLabels[active.transport]})`;
  if (!email.active.enabled) {
    return {
      detail: testDetail,
      label: "Disabled",
      summary: `Delivery is turned off. The settings for ${route} are kept.`,
      tone: "neutral"
    };
  }
  if (email.health.degraded) {
    const reason = email.health.lastFailureCode ? emailAttemptMessage(email.health.lastFailureCode) : "The last message was not delivered.";
    return {
      detail: `Last delivery failed: ${reason} · ${formatDate(email.health.lastFailureAt)}`,
      label: "Failing",
      summary: `Delivering from ${route}.`,
      tone: "critical"
    };
  }
  return {
    detail: testDetail,
    label: "Working",
    summary: `Delivering from ${route}.`,
    tone: "ok"
  };
}

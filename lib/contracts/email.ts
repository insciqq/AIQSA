import type { AdminAuthErrorCode, ErrorResponse, MutationOriginErrorCode } from "./http";

export type AdminEmailTransportMode =
  | "implicit_tls"
  | "starttls_required"
  | "plaintext_internal_no_auth";

export type AdminEmailConfiguration = {
  allowInternalNetwork: boolean;
  authentication:
    | { mode: "none" }
    | { mode: "password"; username: string };
  from: {
    address: string;
    displayName: string | null;
  };
  host: string;
  port: number;
  transport: AdminEmailTransportMode;
};

export type AdminEmailPasswordAction =
  | { kind: "clear"; confirm: true }
  | { kind: "preserve" }
  | { kind: "replace"; password: string };

export type AdminEmailAttemptCode =
  | "accepted"
  | "ambiguous_after_data"
  | "invalid_configuration"
  | "overloaded"
  | "secret_unreadable"
  | "smtp_address_forbidden"
  | "smtp_authentication_failed"
  | "smtp_authentication_unavailable"
  | "smtp_command_timeout"
  | "smtp_connect_timeout"
  | "smtp_connection_failed"
  | "smtp_data_rejected"
  | "smtp_dns_failed"
  | "smtp_ehlo_failed"
  | "smtp_greeting_rejected"
  | "smtp_invalid_input"
  | "smtp_protocol_error"
  | "smtp_recipient_rejected"
  | "smtp_reply_limit"
  | "smtp_sender_rejected"
  | "smtp_starttls_failed"
  | "smtp_starttls_unavailable"
  | "smtp_tls_failed"
  | "smtp_total_timeout";

export type AdminEmailState = {
  active: {
    activatedAt: string | null;
    activatedByUserId: string | null;
    configuration: AdminEmailConfiguration | null;
    enabled: boolean;
    passwordConfigured: boolean;
    version: number;
  };
  configurationUpdatedAt: string | null;
  configurationUpdatedByUserId: string | null;
  draft: {
    configuration: AdminEmailConfiguration | null;
    passwordConfigured: boolean;
    test: {
      attemptedAt: string;
      code: AdminEmailAttemptCode;
      tested: boolean;
      version: number;
    } | null;
    version: number;
  };
  health: {
    activeVersion: number | null;
    degraded: boolean;
    lastAcceptedAt: string | null;
    lastAttemptAt: string | null;
    lastFailureAt: string | null;
    lastFailureCode: AdminEmailAttemptCode | null;
  };
};

/** The settings `test_and_activate` stores before it sends the test message. */
export type AdminEmailDraftInput = {
  configuration: AdminEmailConfiguration;
  expectedDraftVersion: number;
  passwordAction: AdminEmailPasswordAction;
};

export type AdminEmailActionRequest =
  | { action: "disable" | "enable"; expectedActiveVersion: number }
  | {
      /**
       * Stores `draft`, sends one test message to `testRecipient`, and activates
       * on acceptance. Any failure leaves the active configuration untouched.
       */
      action: "test_and_activate";
      draft: AdminEmailDraftInput;
      expectedActiveVersion: number;
      testRecipient: string;
    };

export type AdminEmailClearRequest = {
  confirm: true;
  expectedActiveVersion: number;
  expectedDraftVersion: number;
};

export type AdminEmailMutationResponse = {
  email: AdminEmailState;
};

export type AdminEmailTestResponse = AdminEmailMutationResponse & {
  test: {
    code: AdminEmailAttemptCode;
    tested: boolean;
  };
};

export type AdminEmailErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | "email_active_conflict"
  | "email_configuration_invalid"
  | "email_draft_conflict"
  | "email_draft_not_configured"
  | "email_draft_not_tested"
  | "email_encryption_unavailable"
  | "email_state_invalid"
  | "email_test_failed"
  | "json_required";

export type AdminEmailErrorResponse = ErrorResponse<AdminEmailErrorCode>;

/**
 * 422 body of `test_and_activate` when the mail server did not accept the test
 * message: the settings are stored for the next attempt, `test.code` carries
 * the cause, and `email.active` is the untouched previous configuration.
 */
export type AdminEmailTestFailedResponse = ErrorResponse<"email_test_failed"> & AdminEmailMutationResponse & {
  test: {
    code: AdminEmailAttemptCode;
    tested: false;
  };
};

import type {
  AdminEmailActionRequest,
  AdminEmailAttemptCode,
  AdminEmailClearRequest,
  AdminEmailConfiguration,
  AdminEmailMutationResponse,
  AdminEmailSaveRequest,
  AdminEmailState,
  AdminEmailTestResponse
} from "@/lib/contracts/email";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminEmailClientResult<T> =
  | { data: T; ok: true }
  | { error: string; ok: false };

const ATTEMPT_CODES = new Set<AdminEmailAttemptCode>([
  "accepted",
  "ambiguous_after_data",
  "invalid_configuration",
  "overloaded",
  "secret_unreadable",
  "smtp_address_forbidden",
  "smtp_authentication_failed",
  "smtp_authentication_unavailable",
  "smtp_command_timeout",
  "smtp_connect_timeout",
  "smtp_connection_failed",
  "smtp_data_rejected",
  "smtp_dns_failed",
  "smtp_ehlo_failed",
  "smtp_greeting_rejected",
  "smtp_invalid_input",
  "smtp_protocol_error",
  "smtp_recipient_rejected",
  "smtp_reply_limit",
  "smtp_sender_rejected",
  "smtp_starttls_failed",
  "smtp_starttls_unavailable",
  "smtp_tls_failed",
  "smtp_total_timeout"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isConfiguration(value: unknown): value is AdminEmailConfiguration {
  if (!isRecord(value) || !isRecord(value.authentication) || !isRecord(value.from)) return false;
  const authentication = value.authentication;
  const validAuthentication = authentication.mode === "none" || (
    authentication.mode === "password" && typeof authentication.username === "string"
  );
  return validAuthentication &&
    typeof value.allowInternalNetwork === "boolean" &&
    typeof value.host === "string" &&
    Number.isInteger(value.port) &&
    ["implicit_tls", "starttls_required", "plaintext_internal_no_auth"].includes(String(value.transport)) &&
    typeof value.from.address === "string" &&
    isNullableString(value.from.displayName);
}

function isAttemptCode(value: unknown): value is AdminEmailAttemptCode {
  return typeof value === "string" && ATTEMPT_CODES.has(value as AdminEmailAttemptCode);
}

function isState(value: unknown): value is AdminEmailState {
  if (!isRecord(value) || !isRecord(value.active) || !isRecord(value.draft) || !isRecord(value.health)) {
    return false;
  }
  const active = value.active;
  const draft = value.draft;
  const health = value.health;
  const draftTest = draft.test;
  const validDraftTest = draftTest === null || (
    isRecord(draftTest) &&
    typeof draftTest.attemptedAt === "string" &&
    isAttemptCode(draftTest.code) &&
    typeof draftTest.tested === "boolean" &&
    isVersion(draftTest.version)
  );
  return (
    isNullableString(value.configurationUpdatedAt) &&
    isNullableString(value.configurationUpdatedByUserId) &&
    isNullableString(active.activatedAt) &&
    isNullableString(active.activatedByUserId) &&
    (active.configuration === null || isConfiguration(active.configuration)) &&
    typeof active.enabled === "boolean" &&
    typeof active.passwordConfigured === "boolean" &&
    isVersion(active.version) &&
    (draft.configuration === null || isConfiguration(draft.configuration)) &&
    typeof draft.passwordConfigured === "boolean" &&
    validDraftTest &&
    isVersion(draft.version) &&
    (health.activeVersion === null || isVersion(health.activeVersion)) &&
    typeof health.degraded === "boolean" &&
    isNullableString(health.lastAcceptedAt) &&
    isNullableString(health.lastAttemptAt) &&
    isNullableString(health.lastFailureAt) &&
    (health.lastFailureCode === null || isAttemptCode(health.lastFailureCode))
  );
}

function decodeMutation(value: unknown): AdminEmailMutationResponse | null {
  return isRecord(value) && isState(value.email) ? { email: value.email } : null;
}

function decodeTest(value: unknown): AdminEmailTestResponse | null {
  if (!isRecord(value) || !isState(value.email) || !isRecord(value.test) ||
    !isAttemptCode(value.test.code) || typeof value.test.tested !== "boolean") {
    return null;
  }
  return {
    email: value.email,
    test: { code: value.test.code, tested: value.test.tested }
  };
}

async function request<T>(
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminEmailClientResult<T>> {
  try {
    const response = await fetcher("/api/admin/email", init);
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: isRecord(value) && typeof value.error === "string"
          ? value.error
          : "email_admin_action_failed",
        ok: false
      };
    }
    const decoded = decode(value);
    return decoded
      ? { data: decoded, ok: true }
      : { error: "email_admin_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

function jsonInit(method: "DELETE" | "POST" | "PUT", body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  };
}

export function requestAdminEmail(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, decodeMutation, fetcher);
}

export function saveAdminEmail(body: AdminEmailSaveRequest, fetcher: Fetcher = fetch) {
  return request(jsonInit("PUT", body), decodeMutation, fetcher);
}

export function runAdminEmailAction(body: AdminEmailActionRequest, fetcher: Fetcher = fetch) {
  return body.action === "test"
    ? request(jsonInit("POST", body), decodeTest, fetcher)
    : request(jsonInit("POST", body), decodeMutation, fetcher);
}

export function clearAdminEmail(body: AdminEmailClearRequest, fetcher: Fetcher = fetch) {
  return request(jsonInit("DELETE", body), decodeMutation, fetcher);
}

export function adminEmailErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    email_active_conflict: "The active email configuration changed. Refresh and try again.",
    email_admin_action_failed: "The email delivery action could not be completed.",
    email_admin_response_invalid: "The email API returned an unexpected response. Refresh and try again.",
    email_configuration_invalid: "Review the email delivery fields and password action.",
    email_draft_conflict: "The email draft changed. Refresh before saving again.",
    email_draft_not_configured: "Save a complete draft before testing or activation.",
    email_draft_not_tested: "Test the current draft successfully before activation.",
    email_encryption_unavailable: "Secret storage is unavailable. Check AIQSA_ENCRYPTION_KEY.",
    email_state_invalid: "The stored email configuration is inconsistent. Clear it or restore a valid backup.",
    email_test_overloaded: "Too many email tests are running. Wait briefly and try again.",
    forbidden: "Your account no longer has permission to manage email delivery.",
    json_required: "The email request format was not accepted. Refresh and try again.",
    network_error: "Could not reach the email administration API.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  return messages[code] ?? "The email delivery action could not be completed.";
}

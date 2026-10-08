import {
  isSignInOutcomeCode,
  type AdminGroupSignIn,
  type AdminGroupSignInRequest,
  type AdminSignInDraftRequest,
  type AdminSignInMethodActionRequest,
  type AdminSignInMethodState,
  type AdminSignInOverview,
  type AdminSignInPolicyRequest,
  type AdminSignInPolicyState,
  type AdminUserSignIn,
  type AdminUserSignInRequest
} from "@/lib/contracts/adminSignIn";
import {
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  AUTH_SIGN_IN_METHODS,
  isAuthSessionSignInMethod,
  isExternalGroupSource,
  type AuthSignInMethod
} from "@/lib/contracts/authSignInMethods";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminSignInClientResult<T> =
  | { data: T; ok: true }
  | { affectedIdentities?: number; error: string; ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFlags(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((flag) => typeof flag === "boolean");
}

function isMethod(value: unknown): value is AuthSignInMethod {
  return typeof value === "string" && AUTH_SIGN_IN_METHODS.some((method) => method === value);
}

function isConfig(method: AuthSignInMethod, value: unknown): boolean {
  return value === null || AUTH_SIGN_IN_METHOD_SCHEMAS[method].config.safeParse(value).success;
}

function decodeMethod(value: unknown): AdminSignInMethodState | null {
  if (!isRecord(value) || !isMethod(value.method)) return null;
  const method = value.method;
  const { active, draft, health } = value;
  if (!isRecord(active) || !isRecord(draft) || !isRecord(health)) return null;
  const test = draft.test;
  const validTest = test === null || (
    isRecord(test) && typeof test.attemptedAt === "string" && isSignInOutcomeCode(test.code) &&
    typeof test.passed === "boolean" && isVersion(test.version)
  );
  const valid =
    ["active_admin", "active_environment", "off"].includes(String(value.status)) &&
    (value.problem === null || value.problem === "invalid_configuration" || value.problem === "secret_unreadable") &&
    typeof value.requiresTest === "boolean" &&
    typeof value.environmentConfigured === "boolean" &&
    isNullableString(active.activatedAt) && isConfig(method, active.config) && typeof active.enabled === "boolean" &&
    isFlags(active.secrets) && isVersion(active.version) &&
    isConfig(method, draft.config) && typeof draft.matchesActive === "boolean" && isFlags(draft.secrets) &&
    validTest && isVersion(draft.version) &&
    isNullableString(health.lastAcceptedAt) && isNullableString(health.lastAttemptAt) &&
    isNullableString(health.lastFailureAt) &&
    (health.lastFailureCode === null || isSignInOutcomeCode(health.lastFailureCode));
  return valid ? value as AdminSignInMethodState : null;
}

function decodePolicy(value: unknown): AdminSignInPolicyState | null {
  return isRecord(value) &&
    typeof value.passwordLoginEnabled === "boolean" &&
    typeof value.registrationEnabled === "boolean" &&
    isNullableString(value.updatedAt) &&
    isVersion(value.version)
    ? value as AdminSignInPolicyState
    : null;
}

export function decodeAdminSignInOverview(value: unknown): AdminSignInOverview | null {
  if (!isRecord(value) || typeof value.appBaseUrl !== "string" || !Array.isArray(value.methods)) return null;
  const methods = value.methods.map(decodeMethod);
  const policy = decodePolicy(value.policy);
  const sessionMethod = value.currentSessionSignInMethod;
  if (methods.some((method) => method === null) || !policy) return null;
  if (sessionMethod !== null && !isAuthSessionSignInMethod(sessionMethod)) return null;
  return {
    appBaseUrl: value.appBaseUrl,
    currentSessionSignInMethod: sessionMethod,
    methods: methods as AdminSignInMethodState[],
    policy
  };
}

function decodeMethodResponse(value: unknown): { method: AdminSignInMethodState } | null {
  const method = isRecord(value) ? decodeMethod(value.method) : null;
  return method ? { method } : null;
}

function decodeTestResponse(value: unknown): { method: AdminSignInMethodState; test: { code: string; passed: boolean } } | null {
  const method = isRecord(value) ? decodeMethod(value.method) : null;
  const test = isRecord(value) ? value.test : null;
  return method && isRecord(test) && isSignInOutcomeCode(test.code) && typeof test.passed === "boolean"
    ? { method, test: { code: test.code, passed: test.passed } }
    : null;
}

function decodePolicyResponse(value: unknown): { policy: AdminSignInPolicyState } | null {
  const policy = isRecord(value) ? decodePolicy(value.policy) : null;
  return policy ? { policy } : null;
}

export function decodeAdminGroupSignIn(value: unknown): AdminGroupSignIn | null {
  if (!isRecord(value) || !Array.isArray(value.externalNames) || !Array.isArray(value.managedMembers) ||
    typeof value.scimManaged !== "boolean") {
    return null;
  }
  const namesValid = value.externalNames.every((name) =>
    isRecord(name) && typeof name.id === "string" && isExternalGroupSource(name.source) && typeof name.value === "string");
  const managedValid = value.managedMembers.every((member) =>
    isRecord(member) && typeof member.userId === "string" &&
    (member.managedBy === "scim" || isExternalGroupSource(member.managedBy)));
  return namesValid && managedValid ? value as AdminGroupSignIn : null;
}

export function decodeAdminUserSignIn(value: unknown): AdminUserSignIn | null {
  if (!isRecord(value) || typeof value.hasPassword !== "boolean" || !Array.isArray(value.identities) ||
    !Array.isArray(value.managedGroups)) {
    return null;
  }
  const identitiesValid = value.identities.every((identity) =>
    isRecord(identity) && typeof identity.id === "string" && typeof identity.createdAt === "string" &&
    (identity.provider === "google" || identity.provider === "yandex" || isExternalGroupSource(identity.provider)) &&
    isNullableString(identity.lastSyncedAt) &&
    (identity.lastSyncWarning === null || isSignInOutcomeCode(identity.lastSyncWarning)) &&
    (identity.sourceCurrent === null || typeof identity.sourceCurrent === "boolean"));
  const managedValid = value.managedGroups.every((group) =>
    isRecord(group) && typeof group.groupId === "string" &&
    (group.managedBy === "scim" || isExternalGroupSource(group.managedBy)));
  return identitiesValid && managedValid ? value as AdminUserSignIn : null;
}

async function request<T>(
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminSignInClientResult<T>> {
  try {
    const response = await fetcher(url, init);
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ...(isRecord(value) && Number.isSafeInteger(value.affectedIdentities)
          ? { affectedIdentities: value.affectedIdentities as number }
          : {}),
        error: isRecord(value) && typeof value.error === "string" ? value.error : "sign_in_admin_action_failed",
        ok: false
      };
    }
    const decoded = decode(value);
    return decoded ? { data: decoded, ok: true } : { error: "sign_in_admin_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method };
}

function methodUrl(method: AuthSignInMethod): string {
  return `/api/admin/sign-in/methods/${encodeURIComponent(method)}`;
}

export function requestAdminSignIn(fetcher: Fetcher = fetch) {
  return request("/api/admin/sign-in", { cache: "no-store", method: "GET" }, decodeAdminSignInOverview, fetcher);
}

export function saveAdminSignInDraft(method: AuthSignInMethod, body: AdminSignInDraftRequest, fetcher: Fetcher = fetch) {
  return request(methodUrl(method), jsonInit("PUT", body), decodeMethodResponse, fetcher);
}

export function testAdminSignInMethod(
  method: AuthSignInMethod,
  body: Extract<AdminSignInMethodActionRequest, { action: "test" }>,
  fetcher: Fetcher = fetch
) {
  return request(methodUrl(method), jsonInit("POST", body), decodeTestResponse, fetcher);
}

export function runAdminSignInMethodAction(
  method: AuthSignInMethod,
  body: Exclude<AdminSignInMethodActionRequest, { action: "test" }>,
  fetcher: Fetcher = fetch
) {
  return request(methodUrl(method), jsonInit("POST", body), decodeMethodResponse, fetcher);
}

export function saveAdminSignInPolicy(body: AdminSignInPolicyRequest, fetcher: Fetcher = fetch) {
  return request("/api/admin/sign-in/policy", jsonInit("PUT", body), decodePolicyResponse, fetcher);
}

function decodeGroupResponse(value: unknown): AdminGroupSignIn | null {
  return isRecord(value) ? decodeAdminGroupSignIn(value.group) : null;
}

function decodeUserResponse(value: unknown): AdminUserSignIn | null {
  return isRecord(value) ? decodeAdminUserSignIn(value.user) : null;
}

export function requestAdminGroupSignIn(groupId: string, fetcher: Fetcher = fetch) {
  return request(`/api/admin/sign-in/groups/${encodeURIComponent(groupId)}`, { cache: "no-store", method: "GET" }, decodeGroupResponse, fetcher);
}

export function changeAdminGroupSignIn(groupId: string, body: AdminGroupSignInRequest, fetcher: Fetcher = fetch) {
  return request(`/api/admin/sign-in/groups/${encodeURIComponent(groupId)}`, jsonInit("POST", body), decodeGroupResponse, fetcher);
}

export function requestAdminUserSignIn(userId: string, fetcher: Fetcher = fetch) {
  return request(`/api/admin/sign-in/users/${encodeURIComponent(userId)}`, { cache: "no-store", method: "GET" }, decodeUserResponse, fetcher);
}

export function changeAdminUserSignIn(userId: string, body: AdminUserSignInRequest, fetcher: Fetcher = fetch) {
  return request(`/api/admin/sign-in/users/${encodeURIComponent(userId)}`, jsonInit("POST", body), decodeUserResponse, fetcher);
}

const BREAK_GLASS = "If every other way in fails, the bootstrap token (AIQSA_BOOTSTRAP_AUTH_TOKEN) remains the break-glass sign-in.";

/** Disable refused: password sign-in is off and the administrator signed in with this method. */
export function adminSignInDisableLockoutMessage(label: string): string {
  return `${label} stays on: password sign-in is off and you signed in with ${label}, so disabling it could leave ` +
    "no administrator a way back in. Sign in through another active method first, or turn password sign-in back on. " +
    BREAK_GLASS;
}

export function adminSignInErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    external_name_duplicate: "This group already has that external name for this source.",
    external_name_invalid: "Enter the exact value the identity provider sends: up to 512 characters, no control characters.",
    external_name_limit: "This group has the maximum number of external names for this source.",
    external_name_not_found: "This external name was already removed. The list was refreshed.",
    forbidden: "Your account no longer has permission to manage sign-in.",
    group_archived: "This group is archived. Restore it before adding external names.",
    group_not_found: "This group no longer exists.",
    identity_last_sign_in_method: "This is the user's only way to sign in.",
    identity_not_found: "This identity was already removed. The list was refreshed.",
    identity_unlink_forbidden: "A local password cannot be unlinked here.",
    invalid_origin: "The request was blocked by the same-origin security check. Reload AIQSA from its configured URL and try again.",
    json_required: "The request format was not accepted. Refresh and try again.",
    network_error: "Could not reach the sign-in administration API.",
    password_login_lockout_risk: "Password sign-in stays on: you signed in with a password or the bootstrap token. " +
      "Sign in through an active external method (Google, Yandex, OIDC, LDAP, SAML or a trusted header) first, " +
      `so you can still get back in once passwords are off. ${BREAK_GLASS}`,
    sign_in_active_conflict: "Sign-in settings changed elsewhere. The page was refreshed; try again.",
    sign_in_admin_action_failed: "The sign-in action could not be completed.",
    sign_in_admin_response_invalid: "The sign-in API returned an unexpected response. Refresh and try again.",
    sign_in_configuration_invalid: "Check the fields and try again.",
    sign_in_draft_conflict: "Sign-in settings changed elsewhere. The page was refreshed; try again.",
    sign_in_draft_not_configured: "Save the settings first.",
    sign_in_draft_not_tested: "Test the saved settings before activating them.",
    sign_in_encryption_unavailable: "Secret storage is unavailable. Check AIQSA_ENCRYPTION_KEY.",
    sign_in_method_unavailable: "This sign-in method is not available on this server.",
    sign_in_policy_conflict: "The sign-in switches changed elsewhere. The page was refreshed; try again.",
    sign_in_source_changed: "Activation needs confirmation.",
    sign_in_state_invalid: "The stored settings cannot be read. Enter the secret again, save, test and activate.",
    unauthorized: "Your administrator session is no longer valid. Sign in again.",
    user_not_found: "This user no longer exists."
  };
  return messages[code] ?? "The sign-in action could not be completed.";
}

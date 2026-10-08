import type {
  AuthSessionSignInMethod,
  AuthSignInMethod,
  AuthSignInMethodConfig,
  ExternalGroupSource
} from "./authSignInMethods";
import type { AdminAuthErrorCode, ErrorResponse, MutationOriginErrorCode } from "./http";

/**
 * A content-free outcome a method's tester or sign-in handler records: lowercase snake case,
 * never a message, address, claim or provider response.
 */
export const SIGN_IN_OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export function isSignInOutcomeCode(value: unknown): value is string {
  return typeof value === "string" && SIGN_IN_OUTCOME_CODE_PATTERN.test(value);
}

/** Where a method's active configuration comes from, as the admin panel shows it. */
export type AdminSignInMethodStatus = "active_admin" | "active_environment" | "off";

/** Why a stored slot cannot be used; the admin re-enters the configuration. */
export type AdminSignInMethodProblem = "invalid_configuration" | "secret_unreadable";

export type AdminSignInMethodTest = {
  attemptedAt: string;
  code: string;
  passed: boolean;
  version: number;
};

/**
 * One method's admin state. Configurations are the method's non-secret settings; secrets are
 * write-only and appear only as `{ <field>: configured }`.
 */
export type AdminSignInMethodState<M extends AuthSignInMethod = AuthSignInMethod> = {
  active: {
    activatedAt: string | null;
    config: AuthSignInMethodConfig<M> | null;
    enabled: boolean;
    secrets: Record<string, boolean>;
    version: number;
  };
  draft: {
    config: AuthSignInMethodConfig<M> | null;
    /** The saved draft is exactly what is active (configuration and secrets). */
    matchesActive: boolean;
    secrets: Record<string, boolean>;
    test: AdminSignInMethodTest | null;
    version: number;
  };
  /** The environment variables carry a usable fallback configuration (Google and Yandex only). */
  environmentConfigured: boolean;
  health: {
    lastAcceptedAt: string | null;
    lastAttemptAt: string | null;
    lastFailureAt: string | null;
    lastFailureCode: string | null;
  };
  method: M;
  problem: AdminSignInMethodProblem | null;
  /** Activation needs a passing test of the current draft. */
  requiresTest: boolean;
  status: AdminSignInMethodStatus;
};

export type AdminSignInPolicyState = {
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
  updatedAt: string | null;
  /** 0 while the switches were never changed (both on). */
  version: number;
};

export type AdminSignInOverview = {
  /** `AIQSA_APP_BASE_URL`, the origin of the redirect and callback URLs an IdP needs. */
  appBaseUrl: string;
  /** How the acting administrator's current session signed in; the lockout guard reads it. */
  currentSessionSignInMethod: AuthSessionSignInMethod | null;
  /** Methods this installation can configure, in display order. */
  methods: AdminSignInMethodState[];
  policy: AdminSignInPolicyState;
};

/** Write-only secret field change: an absent field keeps the stored value. */
export type AdminSignInSecretAction =
  | { kind: "clear"; confirm: true }
  | { kind: "preserve" }
  | { kind: "replace"; value: string };

export type AdminSignInDraftRequest = {
  config: unknown;
  expectedDraftVersion: number;
  secretActions: Record<string, AdminSignInSecretAction>;
};

export type AdminSignInMethodActionRequest =
  | { action: "test"; expectedDraftVersion: number }
  | {
      action: "activate";
      /** Set after the administrator confirmed `sign_in_source_changed`. */
      confirmSourceChange?: true;
      expectedActiveVersion: number;
      expectedDraftVersion: number;
    }
  | { action: "disable"; expectedActiveVersion: number };

export type AdminSignInPolicyRequest = {
  expectedVersion: number;
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
};

export type AdminSignInMethodResponse = { method: AdminSignInMethodState };
export type AdminSignInTestResponse = AdminSignInMethodResponse & { test: { code: string; passed: boolean } };
export type AdminSignInPolicyResponse = { policy: AdminSignInPolicyState };

export type AdminSignInErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | "json_required"
  | "password_login_lockout_risk"
  | "sign_in_active_conflict"
  | "sign_in_configuration_invalid"
  | "sign_in_draft_conflict"
  | "sign_in_draft_not_configured"
  | "sign_in_draft_not_tested"
  | "sign_in_encryption_unavailable"
  | "sign_in_environment_unsupported"
  | "sign_in_method_unavailable"
  | "sign_in_policy_conflict"
  | "sign_in_source_changed"
  | "sign_in_state_invalid";

export type AdminSignInErrorResponse = ErrorResponse<AdminSignInErrorCode> & {
  /** `sign_in_source_changed`: identities of the previous source that stop signing in. */
  affectedIdentities?: number;
};

// Group external names and IdP-managed memberships.

/** Who manages a membership: a sign-in source by its external group names, or SCIM. */
export type AdminMembershipManager = ExternalGroupSource | "scim";

export type AdminGroupExternalName = {
  id: string;
  source: ExternalGroupSource;
  value: string;
};

export type AdminGroupSignIn = {
  externalNames: AdminGroupExternalName[];
  /** Members whose membership in this group a source or SCIM manages. */
  managedMembers: { managedBy: AdminMembershipManager; userId: string }[];
  /** SCIM pushes this group and its members. */
  scimManaged: boolean;
};

export type AdminGroupSignInRequest =
  | { action: "add_external_name"; source: ExternalGroupSource; value: string }
  | { action: "remove_external_name"; externalNameId: string };

export type AdminGroupSignInResponse = { group: AdminGroupSignIn };

export type AdminGroupSignInErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | "external_name_duplicate"
  | "external_name_invalid"
  | "external_name_limit"
  | "external_name_not_found"
  | "group_archived"
  | "group_not_found"
  | "json_required";

/** Providers of identities other than a local password. */
export type AdminExternalIdentityProvider = "google" | "yandex" | ExternalGroupSource;

export type AdminUserSignInIdentity = {
  createdAt: string;
  id: string;
  /** Last group or admin-role sync from this identity's source. */
  lastSyncedAt: string | null;
  lastSyncWarning: string | null;
  provider: AdminExternalIdentityProvider;
  /**
   * False when the identity belongs to a source other than the method's active one: it no
   * longer signs in (`source_changed`) until unlinked. Null when the method has no source or
   * is not active in the admin panel.
   */
  sourceCurrent: boolean | null;
};

export type AdminUserSignIn = {
  /** A local password that can sign in. */
  hasPassword: boolean;
  identities: AdminUserSignInIdentity[];
  managedGroups: { groupId: string; managedBy: AdminMembershipManager }[];
};

export type AdminUserSignInRequest = {
  action: "unlink_identity";
  /** Set after the administrator confirmed `identity_last_sign_in_method`. */
  confirmLastSignInMethod?: true;
  identityId: string;
};

export type AdminUserSignInResponse = { user: AdminUserSignIn };

export type AdminUserSignInErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | "identity_last_sign_in_method"
  | "identity_not_found"
  | "identity_unlink_forbidden"
  | "json_required"
  | "user_not_found";

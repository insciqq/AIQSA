import type {
  AdminMembershipManager,
  AdminSignInMethodState,
  AdminSignInMethodStatus
} from "@/lib/contracts/adminSignIn";
import type { AuthSessionSignInMethod, AuthSignInMethod } from "@/lib/contracts/authSignInMethods";

export const signInMethodLabels: Record<AuthSignInMethod | AuthSessionSignInMethod, string> = {
  bootstrap: "Bootstrap token",
  google: "Google",
  invite: "Invitation",
  ldap: "LDAP",
  oidc: "OIDC",
  password: "Password",
  saml: "SAML",
  scim: "SCIM",
  trusted_header: "Trusted header",
  yandex: "Yandex"
};

export function membershipManagerLabel(manager: AdminMembershipManager): string {
  return signInMethodLabels[manager];
}

export type SignInStatusPresentation = Readonly<{ label: string; tone: "neutral" | "ok" }>;

export function signInStatusPresentation(status: AdminSignInMethodStatus): SignInStatusPresentation {
  switch (status) {
    case "active_admin":
      return { label: "Active (admin)", tone: "ok" };
    case "active_environment":
      return { label: "Active (environment)", tone: "ok" };
    case "off":
      return { label: "Off", tone: "neutral" };
  }
}

const testMessages: Record<string, string> = {
  client_id_format_invalid: "The client ID does not look like one this provider issues.",
  client_secret_format_invalid: "The client secret has an unexpected format: spaces or too short.",
  format_checked: "Format checked. The provider confirms the client at the first real sign-in.",
  invalid_configuration: "The saved settings are incomplete. Check the fields and save again.",
  no_test_required: "Nothing to test for this method.",
  secret_unreadable: "The stored secret cannot be read. Enter it again and save.",
  test_failed: "The test could not be completed.",
  test_timeout: "The test timed out."
};

/** A tester's code in words; method testers may add their own codes, shown as they are. */
export function signInTestMessage(code: string): string {
  return testMessages[code] ?? `Test result: ${code}.`;
}

const failureMessages: Record<string, string> = {
  account_conflict: "an identity could not be linked to an existing account",
  email_missing: "the provider sent no usable email",
  exchange_failed: "the provider rejected the sign-in or could not be reached",
  not_allowed: "the account is not allowed by the access rules",
  sign_in_failed: "the sign-in failed",
  source_changed: "the identity belongs to a previous source"
};

export function signInFailureMessage(code: string): string {
  return failureMessages[code] ?? code;
}

export function syncWarningMessage(code: string): string {
  if (code === "groups_claim_missing") {
    return "The last sign-in carried no groups, so managed memberships were left unchanged.";
  }
  if (code === "last_admin_kept") {
    return "The identity provider no longer lists this user as an administrator; they kept the role as the last active administrator.";
  }
  return `Last sync warning: ${code}.`;
}

export function formatSignInTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The draft is saved and may be activated now: a passing test, or a method without one. */
export function signInDraftActivatable(state: AdminSignInMethodState): boolean {
  if (!state.draft.config || state.draft.matchesActive) return false;
  return !state.requiresTest || state.draft.test?.passed === true;
}

/** Environment variables that configure a method's fallback (Google and Yandex). */
export const signInEnvironmentVariables: Partial<Record<AuthSignInMethod, readonly string[]>> = {
  google: ["AIQSA_GOOGLE_OAUTH_CLIENT_ID", "AIQSA_GOOGLE_OAUTH_CLIENT_SECRET"],
  yandex: ["AIQSA_YANDEX_OAUTH_CLIENT_ID", "AIQSA_YANDEX_OAUTH_CLIENT_SECRET"]
};

/** An absolute URL on the installation's own origin, e.g. a callback an IdP needs. */
export function appUrl(appBaseUrl: string, path: string): string {
  try {
    return new URL(path, appBaseUrl).toString();
  } catch {
    return path;
  }
}

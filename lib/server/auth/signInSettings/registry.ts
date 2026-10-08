import type {
  AuthSignInMethod,
  AuthSignInMethodConfig,
  AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";

/**
 * A tester's verdict on one draft. `code` is content-free (`SIGN_IN_OUTCOME_CODE_PATTERN`):
 * never a message, address, certificate subject or provider response.
 */
export type SignInMethodTestResult = { code: string; passed: boolean };

export type SignInMethodTestInput<M extends AuthSignInMethod> = {
  /** `AIQSA_APP_BASE_URL`, for redirect and callback URLs the tester checks. */
  appBaseUrl: string;
  config: AuthSignInMethodConfig<M>;
  secrets: AuthSignInMethodSecrets<M>;
  /** Aborts at the settings service's test deadline. */
  signal: AbortSignal;
};

/**
 * What a sign-in method contributes to the settings service. Each method task adds one entry
 * to `signInMethodServerRegistry` (`methods.ts`); a method without an entry cannot be
 * configured in the admin panel.
 */
export type SignInMethodServerDefinition<M extends AuthSignInMethod> = {
  /**
   * The source an identity of this method is bound to (OIDC issuer, LDAP server and base, SAML
   * IdP entity id), exactly as the method's handler passes it to settlement. Activating a
   * draft whose source differs from existing identities' asks the administrator to confirm.
   * Omit for methods whose identities carry no source.
   */
  identitySource?(config: AuthSignInMethodConfig<M>): string;
  /**
   * Checks a draft before it may be activated. A method with a tester activates only after a
   * passing test of its current draft; omit it for methods with nothing to test (SCIM).
   */
  test?(input: SignInMethodTestInput<M>): Promise<SignInMethodTestResult>;
};

export type SignInMethodServerRegistry = {
  readonly [M in AuthSignInMethod]?: SignInMethodServerDefinition<M>;
};

/** Generic access to one registry entry; the registry's mapped type keeps each entry exact. */
export function signInMethodDefinition(
  registry: SignInMethodServerRegistry,
  method: AuthSignInMethod
): SignInMethodServerDefinition<AuthSignInMethod> | null {
  return (registry[method] as SignInMethodServerDefinition<AuthSignInMethod> | undefined) ?? null;
}

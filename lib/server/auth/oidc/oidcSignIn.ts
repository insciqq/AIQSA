import type {
  AuthSignInMethodConfig,
  AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";
import {
  externalIdentityPolicy,
  type ExternalIdentityInput,
  type ExternalSignInResult
} from "../externalIdentity";
import type { OAuthProviderFlow } from "../oauthHandlers";
import { prepareAuthSession } from "../requestAuth";
import type { SignInSessionInput } from "../signInCompletion";
import { OidcError, type OidcClient } from "./oidcClient";

type OidcConfig = AuthSignInMethodConfig<"oidc">;

/** Settles a validated OIDC sign-in and issues its session in one transaction. */
export type OidcSettlement = (
  input: ExternalIdentityInput & { session: SignInSessionInput; signInMethod: "oidc" }
) => Promise<ExternalSignInResult>;

function failureCode(error: unknown): string {
  return error instanceof OidcError ? error.code : "sign_in_failed";
}

/**
 * The OIDC flow inside the shared OAuth start and callback: the IdP's own authorization URL,
 * then token validation, the shared settlement (subject `sub`, source = the configured issuer)
 * and a session whose method is `oidc`.
 */
export function createOidcSignInFlow(input: {
  client: OidcClient;
  config: OidcConfig;
  secrets: AuthSignInMethodSecrets<"oidc">;
  settle: OidcSettlement;
}): OAuthProviderFlow {
  const { client, config } = input;

  return {
    async authorizationUrl(request) {
      try {
        return { url: await client.authorizationUrl({ ...request, config }) };
      } catch (error) {
        return { code: failureCode(error) };
      }
    },

    async signIn(request) {
      let claims;
      try {
        claims = await client.signIn({
          code: request.code,
          codeVerifier: request.codeVerifier,
          config,
          nonce: request.nonce,
          now: request.now,
          redirectUri: request.redirectUri,
          secrets: input.secrets
        });
      } catch (error) {
        return { code: failureCode(error), status: "failed" };
      }

      const session = prepareAuthSession({ now: request.now, request: request.request, secureCookie: request.secureCookie });
      const result = await input.settle({
        displayName: claims.displayName,
        email: claims.email,
        emailVerified: claims.emailVerified,
        groups: claims.groups,
        now: request.now,
        policy: externalIdentityPolicy(config),
        provider: "oidc",
        session: session.input,
        signInMethod: "oidc",
        source: config.issuer,
        subject: claims.subject
      });

      if (result.status === "active") return { cookie: session.cookie, status: "active" };
      // OIDC relies on the IdP's own MFA; settlement never asks it for a second factor.
      if (result.status === "second_factor_required") return { code: "sign_in_failed", status: "failed" };
      return { status: result.status };
    }
  };
}

/**
 * Where logout sends the browser after revoking a session OIDC signed in: the IdP's
 * end-session endpoint with `client_id` and `post_logout_redirect_uri=<base>/login`, when
 * `idpLogout` is on and the IdP advertises one. No `id_token_hint`: the id token is never kept.
 * Otherwise, with `autoRedirect`, the login page without the redirect (`?local=1`).
 */
export async function oidcLogoutRedirect(input: {
  appBaseUrl: string;
  client: OidcClient;
  config: OidcConfig | null;
  signInMethod: string | null;
}): Promise<string | null> {
  if (input.signInMethod !== "oidc" || !input.config) return null;
  const idpLogout = input.config.idpLogout
    ? await input.client.endSessionUrl({
        config: input.config,
        postLogoutRedirectUri: new URL("/login", input.appBaseUrl).toString()
      })
    : null;
  // Without an IdP logout, `/login` would send an auto-redirect installation straight back
  // to the IdP, whose session signs the user in again.
  return idpLogout ?? (input.config.autoRedirect ? new URL("/login?local=1", input.appBaseUrl).toString() : null);
}

import { prisma } from "../../prisma";
import { completeExternalSignIn } from "../externalIdentity";
import type { ResolvedOAuthProvider } from "../oauthHandlers";
import type { SealedIdTokenHint } from "../requestAuth";
import { resolveSignInMethods } from "../signInMethods";
import { recordSignInMethodOutcome } from "../signInSettings/defaultSignInSettings";
import { defaultOidcClient } from "./oidcClient";
import { createOidcSignInFlow, oidcLogoutRedirect } from "./oidcSignIn";

/** The active OIDC configuration as an OAuth flow provider, or null while OIDC is off. */
export async function resolveOidcSignInProvider(): Promise<ResolvedOAuthProvider | null> {
  const method = (await resolveSignInMethods()).oidc;
  if (!method) return null;
  return {
    flow: createOidcSignInFlow({
      client: defaultOidcClient(),
      config: method.config,
      secrets: method.secrets,
      settle: (settlement) => completeExternalSignIn(prisma, settlement)
    }),
    recordOutcome: (code) => recordSignInMethodOutcome(method, code)
  };
}

/** The logout handler's IdP step for the active OIDC configuration. */
export async function activeOidcLogoutRedirect(input: {
  appBaseUrl: string;
  idTokenHint: SealedIdTokenHint | null;
  signInMethod: string | null;
}): Promise<string | null> {
  if (input.signInMethod !== "oidc") return null;
  const config = (await resolveSignInMethods()).oidc?.config ?? null;
  return oidcLogoutRedirect({ ...input, client: defaultOidcClient(), config });
}

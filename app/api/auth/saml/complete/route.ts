import { getAuthConfig } from "@/lib/server/auth/config";
import { completeSamlSignIn, resolveSamlSignInMethod } from "@/lib/server/auth/saml/defaultSaml";
import { createSamlCompleteHandler } from "@/lib/server/auth/saml/handlers";
import { samlSignInState } from "@/lib/server/auth/saml/state";
import { recordSignInMethodOutcome } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const GET = createSamlCompleteHandler({
  completeSignIn: completeSamlSignIn,
  completions: samlSignInState().completions,
  getConfig: () => getAuthConfig(),
  recordOutcome: recordSignInMethodOutcome,
  resolveMethod: resolveSamlSignInMethod
});

import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter } from "@/lib/server/auth/defaultAuth";
import { completeSamlSignIn, resolveSamlSignInMethod } from "@/lib/server/auth/saml/defaultSaml";
import { createSamlAcsHandler } from "@/lib/server/auth/saml/handlers";
import { samlSignInState } from "@/lib/server/auth/saml/state";
import { recordSignInMethodOutcome } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

const state = samlSignInState();

export const POST = createSamlAcsHandler({
  completeSignIn: completeSamlSignIn,
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  recordOutcome: recordSignInMethodOutcome,
  replayCache: state.replayCache,
  requests: state.requests,
  resolveMethod: resolveSamlSignInMethod
});

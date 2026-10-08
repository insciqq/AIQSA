import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveSamlSignInMethod, samlStartRateLimiter } from "@/lib/server/auth/saml/defaultSaml";
import { createSamlStartHandler } from "@/lib/server/auth/saml/handlers";
import { samlSignInState } from "@/lib/server/auth/saml/state";

export const runtime = "nodejs";

export const GET = createSamlStartHandler({
  getConfig: () => getAuthConfig(),
  rateLimiter: samlStartRateLimiter,
  requests: samlSignInState().requests,
  resolveMethod: resolveSamlSignInMethod
});

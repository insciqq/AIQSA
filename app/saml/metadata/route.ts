import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveSamlSignInMethod } from "@/lib/server/auth/saml/defaultSaml";
import { createSamlMetadataHandler } from "@/lib/server/auth/saml/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createSamlMetadataHandler({
  getConfig: () => getAuthConfig(),
  resolveMethod: resolveSamlSignInMethod
});

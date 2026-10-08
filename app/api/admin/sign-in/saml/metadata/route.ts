import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminSamlMetadataHandler } from "@/lib/server/auth/saml/adminMetadata";
import { fetchSamlMetadata } from "@/lib/server/auth/saml/metadataFetch";

export const runtime = "nodejs";

export const POST = createAdminSamlMetadataHandler({
  fetchMetadata: fetchSamlMetadata,
  resolveAuth: resolveRequestAuth
});

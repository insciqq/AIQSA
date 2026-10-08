import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminTrustedHeaderProbeHandler } from "@/lib/server/auth/trustedHeader/handlers";

export const runtime = "nodejs";

export const GET = createAdminTrustedHeaderProbeHandler({
  getConfig: () => getAuthConfig(),
  resolveAuth: resolveRequestAuth
});

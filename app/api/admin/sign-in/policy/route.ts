import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminSignInPolicyHandler } from "@/lib/server/auth/signInSettings/handlers";
import { signInSettingsService } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const PUT = createAdminSignInPolicyHandler({
  resolveAuth: resolveRequestAuth,
  service: signInSettingsService
});

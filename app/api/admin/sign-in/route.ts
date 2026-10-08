import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminSignInReadHandler } from "@/lib/server/auth/signInSettings/handlers";
import { signInSettingsService } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const GET = createAdminSignInReadHandler({
  resolveAuth: resolveRequestAuth,
  service: signInSettingsService
});

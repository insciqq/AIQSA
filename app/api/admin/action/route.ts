import { getAuthConfig } from "@/lib/server/auth/config";
import { createAdminActionHandler } from "@/lib/server/auth/adminHandlers";
import { adminRepository, authMailer, resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const POST = createAdminActionHandler({
  getConfig: () => getAuthConfig(),
  mailer: authMailer,
  repository: adminRepository,
  resolveAuth: resolveRequestAuth
});

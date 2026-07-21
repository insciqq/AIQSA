import { getAuthConfig } from "@/lib/server/auth/config";
import { createAdminDashboardHandler } from "@/lib/server/auth/adminHandlers";
import { adminRepository, resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const GET = createAdminDashboardHandler({
  getConfig: () => getAuthConfig(),
  repository: adminRepository,
  resolveAuth: resolveRequestAuth
});

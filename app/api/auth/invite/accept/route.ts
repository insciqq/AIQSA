import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter, authRegistrationRepository } from "@/lib/server/auth/defaultAuth";
import { createInviteAcceptanceHandler } from "@/lib/server/auth/registrationHandlers";

export const runtime = "nodejs";

export const POST = createInviteAcceptanceHandler({
  getConfig: () => getAuthConfig(),
  inviteAcceptanceRateLimiter: authRateLimiter,
  repository: authRegistrationRepository
});

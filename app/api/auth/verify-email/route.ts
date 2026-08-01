import { authRateLimiter, authRegistrationRepository } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { createEmailVerificationHandler } from "@/lib/server/auth/registrationHandlers";

export const runtime = "nodejs";

export const POST = createEmailVerificationHandler({
  getConfig: () => getAuthConfig(),
  repository: authRegistrationRepository,
  verificationRateLimiter: authRateLimiter
});

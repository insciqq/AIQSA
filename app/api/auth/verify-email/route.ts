import { authRateLimiter, authRegistrationRepository } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { createEmailVerificationHandler } from "@/lib/server/auth/registrationHandlers";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const POST = createEmailVerificationHandler({
  getConfig: () => getAuthConfig(),
  repository: authRegistrationRepository,
  verificationRateLimiter: authRateLimiter,
  signInPolicy: readSignInPolicy
});

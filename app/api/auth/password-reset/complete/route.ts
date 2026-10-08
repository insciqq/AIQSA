import { authRateLimiter, passwordAuthRepository } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { createPasswordResetCompleteHandler } from "@/lib/server/auth/handlers";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const POST = createPasswordResetCompleteHandler({
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  repository: passwordAuthRepository,
  resetCompleteRateLimiter: authRateLimiter,
  signInPolicy: readSignInPolicy
});

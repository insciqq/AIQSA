import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter, passwordAuthRepository } from "@/lib/server/auth/defaultAuth";
import { createPasswordLoginHandler } from "@/lib/server/auth/handlers";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

export const POST = createPasswordLoginHandler({
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  repository: passwordAuthRepository,
  signInPolicy: readSignInPolicy
});

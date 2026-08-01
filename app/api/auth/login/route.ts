import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter, passwordAuthRepository } from "@/lib/server/auth/defaultAuth";
import { createPasswordLoginHandler } from "@/lib/server/auth/handlers";

export const runtime = "nodejs";

export const POST = createPasswordLoginHandler({
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  repository: passwordAuthRepository
});

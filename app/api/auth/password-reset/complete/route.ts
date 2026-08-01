import { authRateLimiter, passwordAuthRepository } from "@/lib/server/auth/defaultAuth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { createPasswordResetCompleteHandler } from "@/lib/server/auth/handlers";

export const runtime = "nodejs";

export const POST = createPasswordResetCompleteHandler({
  getConfig: () => getAuthConfig(),
  repository: passwordAuthRepository,
  resetCompleteRateLimiter: authRateLimiter
});

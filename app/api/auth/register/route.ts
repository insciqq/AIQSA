import { getAuthConfig } from "@/lib/server/auth/config";
import {
  authMailer,
  authRateLimiter,
  authRegistrationRepository
} from "@/lib/server/auth/defaultAuth";
import { createRegisterHandler } from "@/lib/server/auth/registrationHandlers";

export const runtime = "nodejs";

export const POST = createRegisterHandler({
  getConfig: () => getAuthConfig(),
  mailer: authMailer,
  registrationRateLimiter: authRateLimiter,
  repository: authRegistrationRepository
});

import { getAuthConfig } from "@/lib/server/auth/config";
import { authMailer, passwordAuthRepository } from "@/lib/server/auth/defaultAuth";
import { createPasswordResetRequestHandler } from "@/lib/server/auth/handlers";

export const runtime = "nodejs";

export const POST = createPasswordResetRequestHandler({
  getConfig: () => getAuthConfig(),
  mailer: authMailer,
  repository: passwordAuthRepository
});

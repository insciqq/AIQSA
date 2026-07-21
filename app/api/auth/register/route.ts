import { getAuthConfig } from "@/lib/server/auth/config";
import { authMailer, authRegistrationRepository } from "@/lib/server/auth/defaultAuth";
import { createRegisterHandler } from "@/lib/server/auth/registrationHandlers";

export const runtime = "nodejs";

export const POST = createRegisterHandler({
  getConfig: () => getAuthConfig(),
  mailer: authMailer,
  repository: authRegistrationRepository
});

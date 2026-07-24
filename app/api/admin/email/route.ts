import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminEmailService } from "@/lib/server/email/defaultEmail";
import {
  createAdminEmailActionHandler,
  createAdminEmailClearHandler,
  createAdminEmailReadHandler,
  createAdminEmailSaveHandler
} from "@/lib/server/email/handlers";

export const runtime = "nodejs";

const deps = {
  resolveAuth: resolveRequestAuth,
  service: adminEmailService
};

export const GET = createAdminEmailReadHandler(deps);
export const PUT = createAdminEmailSaveHandler(deps);
export const POST = createAdminEmailActionHandler(deps);
export const DELETE = createAdminEmailClearHandler(deps);

import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminModelPolicyService } from "@/lib/server/admin/providers/modelPolicyDefault";
import { createAdminModelPolicyHandlers } from "@/lib/server/admin/providers/modelPolicyHandlers";

const handlers = createAdminModelPolicyHandlers({
  resolveAuth: resolveRequestAuth,
  service: adminModelPolicyService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;

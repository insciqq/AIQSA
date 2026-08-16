import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminSystemModelPolicyService } from "@/lib/server/admin/providers/systemModelPolicyDefault";
import { createAdminSystemModelPolicyHandlers } from "@/lib/server/admin/providers/systemModelPolicyHandlers";

const handlers = createAdminSystemModelPolicyHandlers({
  resolveAuth: resolveRequestAuth,
  service: adminSystemModelPolicyService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
export const POST = handlers.POST;

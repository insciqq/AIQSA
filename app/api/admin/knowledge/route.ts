import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminKnowledgePolicyService } from "@/lib/server/admin/knowledge/policyDefault";
import { createAdminKnowledgePolicyHandlers } from "@/lib/server/admin/knowledge/policyHandlers";

const handlers = createAdminKnowledgePolicyHandlers({
  resolveAuth: resolveRequestAuth,
  service: adminKnowledgePolicyService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;

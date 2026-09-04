import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { workspacePolicyService } from "@/lib/server/workspace/defaultServices";
import { createWorkspacePolicyHandlers } from "@/lib/server/workspace/policyHandlers";

const handlers = createWorkspacePolicyHandlers({
  resolveAuth: resolveRequestAuth,
  service: workspacePolicyService
});

export const runtime = "nodejs";
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;

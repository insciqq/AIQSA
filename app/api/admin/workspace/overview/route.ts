import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { workspaceOverviewService } from "@/lib/server/workspace/defaultServices";
import { createWorkspaceOverviewHandler } from "@/lib/server/workspace/policyHandlers";

export const runtime = "nodejs";
export const GET = createWorkspaceOverviewHandler({
  resolveAuth: resolveRequestAuth,
  service: workspaceOverviewService
});

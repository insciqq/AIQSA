import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { workspaceAvailabilityService } from "@/lib/server/workspace/defaultServices";
import { createWorkspaceAvailabilityHandler } from "@/lib/server/workspace/availabilityHandlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createWorkspaceAvailabilityHandler({
  availability: workspaceAvailabilityService,
  resolveAuth: resolveRequestAuth
});

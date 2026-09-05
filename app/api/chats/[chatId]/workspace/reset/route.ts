import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { workspaceLifecycleForStorage } from "@/lib/server/workspace/defaultServices";
import { createWorkspaceLifecycleHandlers } from "@/lib/server/workspace/lifecycleHandlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const handlers = createWorkspaceLifecycleHandlers({
  resolveAuth: resolveRequestAuth,
  service: workspaceLifecycleForStorage(createS3StorageAdapter())
});

export const POST: AsyncRouteHandler<typeof handlers.reset> = handlers.reset;

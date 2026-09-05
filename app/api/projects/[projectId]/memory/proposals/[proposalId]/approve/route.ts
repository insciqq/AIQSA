import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectMemoryReviewHandler } from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createProjectMemoryReviewHandler>> = createProjectMemoryReviewHandler(defaultProjectMemoryHandlerDeps, true);

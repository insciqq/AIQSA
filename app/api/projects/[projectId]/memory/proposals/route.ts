import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectMemoryProposalHandler } from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createProjectMemoryProposalHandler>> = createProjectMemoryProposalHandler(defaultProjectMemoryHandlerDeps);

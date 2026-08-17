import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectMemoryReviewHandler } from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const POST = createProjectMemoryReviewHandler(defaultProjectMemoryHandlerDeps, true);

import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectResourcePreviewHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const POST = createProjectResourcePreviewHandler(defaultProjectHandlerDeps);

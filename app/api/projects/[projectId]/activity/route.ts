import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectActivityHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createProjectActivityHandler(defaultProjectHandlerDeps);

import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createCreateProjectHandler, createListProjectsHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createListProjectsHandler(defaultProjectHandlerDeps);
export const POST = createCreateProjectHandler(defaultProjectHandlerDeps);

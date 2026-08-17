import { defaultProjectHandlerDeps } from "@/lib/server/projects/defaultProjects";
import { createProjectCandidatesHandler } from "@/lib/server/projects/handlers";

export const runtime = "nodejs";

export const GET = createProjectCandidatesHandler(defaultProjectHandlerDeps);

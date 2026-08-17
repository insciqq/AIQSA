import { defaultProjectMemoryHandlerDeps } from "@/lib/server/projects/defaultProjects";
import {
  createProjectMemoryFactHandler,
  createProjectMemoryListHandler
} from "@/lib/server/projects/memoryHandlers";

export const runtime = "nodejs";

export const GET = createProjectMemoryListHandler(defaultProjectMemoryHandlerDeps);
export const POST = createProjectMemoryFactHandler(defaultProjectMemoryHandlerDeps);

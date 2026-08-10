import { defaultExplicitMemoryHandlerDeps } from "@/lib/server/memory/explicit/defaultExplicit";
import {
  createGetMemoryHandler,
  createUpdateMemoryHandler
} from "@/lib/server/memory/explicit/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryHandler(defaultExplicitMemoryHandlerDeps);
export const PATCH = createUpdateMemoryHandler(defaultExplicitMemoryHandlerDeps);

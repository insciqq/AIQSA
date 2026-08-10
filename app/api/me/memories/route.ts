import { defaultExplicitMemoryHandlerDeps } from "@/lib/server/memory/explicit/defaultExplicit";
import {
  createCreateMemoryHandler,
  createListMemoriesHandler
} from "@/lib/server/memory/explicit/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListMemoriesHandler(defaultExplicitMemoryHandlerDeps);
export const POST = createCreateMemoryHandler(defaultExplicitMemoryHandlerDeps);

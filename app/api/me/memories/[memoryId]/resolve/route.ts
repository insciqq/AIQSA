import { defaultExplicitMemoryHandlerDeps } from "@/lib/server/memory/explicit/defaultExplicit";
import { createResolveMemoryConflictHandler } from "@/lib/server/memory/explicit/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createResolveMemoryConflictHandler(defaultExplicitMemoryHandlerDeps);

import { defaultMemoryRebuildHandlerDeps } from "@/lib/server/memory/rebuild/defaultRebuild";
import { createGetMemoryRebuildHandler } from "@/lib/server/memory/rebuild/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryRebuildHandler(defaultMemoryRebuildHandlerDeps);

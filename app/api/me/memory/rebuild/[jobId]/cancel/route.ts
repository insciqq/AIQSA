import { defaultMemoryRebuildHandlerDeps } from "@/lib/server/memory/rebuild/defaultRebuild";
import { createCancelMemoryRebuildHandler } from "@/lib/server/memory/rebuild/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createCancelMemoryRebuildHandler(defaultMemoryRebuildHandlerDeps);

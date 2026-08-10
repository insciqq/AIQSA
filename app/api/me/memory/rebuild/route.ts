import { defaultMemoryRebuildHandlerDeps } from "@/lib/server/memory/rebuild/defaultRebuild";
import { createStartMemoryRebuildHandler } from "@/lib/server/memory/rebuild/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createStartMemoryRebuildHandler(defaultMemoryRebuildHandlerDeps);

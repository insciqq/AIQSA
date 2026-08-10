import { defaultMemoryLifecycleHandlerDeps } from "@/lib/server/memory/lifecycle/defaultLifecycle";
import { createGetMemoryDeletionHandler } from "@/lib/server/memory/lifecycle/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryDeletionHandler(defaultMemoryLifecycleHandlerDeps);

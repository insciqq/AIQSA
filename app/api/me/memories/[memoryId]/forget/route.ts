import { defaultMemoryLifecycleHandlerDeps } from "@/lib/server/memory/lifecycle/defaultLifecycle";
import { createForgetMemoryHandler } from "@/lib/server/memory/lifecycle/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createForgetMemoryHandler(defaultMemoryLifecycleHandlerDeps);

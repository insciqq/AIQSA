import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultMemoryConsumerHandlerDeps } from "@/lib/server/memory/consumer/defaultConsumer";
import { createForgetMemoryConsumerItemHandler } from "@/lib/server/memory/consumer/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createForgetMemoryConsumerItemHandler>> = createForgetMemoryConsumerItemHandler(defaultMemoryConsumerHandlerDeps);

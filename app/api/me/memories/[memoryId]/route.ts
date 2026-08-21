import { defaultMemoryConsumerHandlerDeps } from "@/lib/server/memory/consumer/defaultConsumer";
import { createEditMemoryConsumerItemHandler } from "@/lib/server/memory/consumer/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const PATCH = createEditMemoryConsumerItemHandler(defaultMemoryConsumerHandlerDeps);

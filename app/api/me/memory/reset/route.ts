import { defaultMemoryConsumerHandlerDeps } from "@/lib/server/memory/consumer/defaultConsumer";
import { createResetMemoryConsumerHandler } from "@/lib/server/memory/consumer/handlers";

// Reset admits only the bounded consumer confirmation contract.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createResetMemoryConsumerHandler(defaultMemoryConsumerHandlerDeps);

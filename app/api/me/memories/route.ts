import { defaultMemoryConsumerHandlerDeps } from "@/lib/server/memory/consumer/defaultConsumer";
import {
  createCreateMemoryConsumerItemHandler,
  createListMemoryConsumerItemsHandler
} from "@/lib/server/memory/consumer/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createListMemoryConsumerItemsHandler(defaultMemoryConsumerHandlerDeps);
export const POST = createCreateMemoryConsumerItemHandler(defaultMemoryConsumerHandlerDeps);

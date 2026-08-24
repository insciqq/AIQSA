import { defaultMemoryConsumerHandlerDeps } from "@/lib/server/memory/consumer/defaultConsumer";
import {
  createGetMemoryConsumerSettingsHandler,
  createPatchMemoryConsumerSettingsHandler
} from "@/lib/server/memory/consumer/handlers";

// This route is the client-safe consumer projection; legacy settings objects
// never cross the browser boundary directly.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryConsumerSettingsHandler(defaultMemoryConsumerHandlerDeps);
export const PATCH = createPatchMemoryConsumerSettingsHandler(defaultMemoryConsumerHandlerDeps);

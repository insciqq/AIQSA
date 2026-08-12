import { defaultMemoryProfileHandlerDependencies } from
  "@/lib/server/memory/profile/defaultProfile";
import { createGetMemoryProfileHandler } from "@/lib/server/memory/profile/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createGetMemoryProfileHandler(defaultMemoryProfileHandlerDependencies);

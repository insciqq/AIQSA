import { defaultMemoryHistorySearchHandlerDeps } from "@/lib/server/memory/history/search/defaultSearch";
import { createMemoryHistorySearchHandler } from "@/lib/server/memory/history/search/handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createMemoryHistorySearchHandler(
  defaultMemoryHistorySearchHandlerDeps
);

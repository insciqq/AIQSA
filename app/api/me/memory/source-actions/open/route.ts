import { defaultMemorySourceNavigationHandler } from "@/lib/server/memory/sources/actionHandlers";

// Navigation resolves opaque consumer references server-side.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defaultMemorySourceNavigationHandler;

import { defaultMemorySourceActionHandler } from "@/lib/server/memory/sources/actionHandlers";

// Mutations stay behind the client-safe source-action contract.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defaultMemorySourceActionHandler;

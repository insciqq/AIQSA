import { connectBrowserHandlers } from "@/lib/server/connect/defaults";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = connectBrowserHandlers.lookupPairing;
export const POST = connectBrowserHandlers.decidePairing;

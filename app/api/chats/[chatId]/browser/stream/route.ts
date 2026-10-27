import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { browserLiveHandlers } from "@/lib/server/workspace/browserLiveDefaults";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<typeof browserLiveHandlers.stream> = browserLiveHandlers.stream;

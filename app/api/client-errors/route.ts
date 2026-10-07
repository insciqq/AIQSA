import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createClientErrorHandler } from "@/lib/server/clientErrors/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = createClientErrorHandler({ resolveAuth: resolveRequestAuth });

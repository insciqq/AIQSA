import { twoFactorHandlerDeps } from "@/lib/server/auth/defaultTwoFactor";
import { createTwoFactorActionHandler } from "@/lib/server/auth/totpHandlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createTwoFactorActionHandler("start", twoFactorHandlerDeps);

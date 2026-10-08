import { twoFactorHandlerDeps } from "@/lib/server/auth/defaultTwoFactor";
import { createTwoFactorStatusHandler } from "@/lib/server/auth/totpHandlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = createTwoFactorStatusHandler(twoFactorHandlerDeps);

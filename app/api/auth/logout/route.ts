import { createLogoutHandler } from "@/lib/server/auth/handlers";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const POST = createLogoutHandler({
  getConfig: () => getAuthConfig(),
  sessions: authSessionStore
});

import { getAuthConfig } from "@/lib/server/auth/config";
import { createOAuthStartHandler } from "@/lib/server/auth/oauthHandlers";

export const runtime = "nodejs";

export const GET = createOAuthStartHandler({
  getConfig: () => getAuthConfig()
});

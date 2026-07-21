import { getAuthConfig } from "@/lib/server/auth/config";
import {
  authSessionStore,
  oauthIdentityRepository
} from "@/lib/server/auth/defaultAuth";
import { createOAuthCallbackHandler } from "@/lib/server/auth/oauthHandlers";

export const runtime = "nodejs";

export const GET = createOAuthCallbackHandler({
  getConfig: () => getAuthConfig(),
  repository: oauthIdentityRepository,
  sessions: authSessionStore
});

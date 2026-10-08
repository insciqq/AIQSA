import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminScimTokenHandlers } from "@/lib/server/auth/scim/adminHandlers";
import { scimTokenRepository } from "@/lib/server/auth/scim/default";

export const runtime = "nodejs";

const handlers = createAdminScimTokenHandlers({
  resolveAuth: resolveRequestAuth,
  tokens: scimTokenRepository
});

export const GET = handlers.GET;
export const POST = handlers.POST;

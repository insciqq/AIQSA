import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createWorkspaceSecretHandlers } from "@/lib/server/workspace/secrets/handlers";
import { createWorkspaceSecretStore } from "@/lib/server/workspace/secrets/store";

export const runtime = "nodejs";
export const { GET, POST } = createWorkspaceSecretHandlers({
  resolveAuth: resolveRequestAuth, store: createWorkspaceSecretStore(prisma)
});

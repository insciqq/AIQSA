import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { listSignInRefusals } from "@/lib/server/auth/signInRefusals";
import { createAdminSignInRefusalsHandler } from "@/lib/server/auth/signInRefusalsHandler";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createAdminSignInRefusalsHandler({
  read: (input) => listSignInRefusals(prisma, input),
  resolveAuth: resolveRequestAuth
});

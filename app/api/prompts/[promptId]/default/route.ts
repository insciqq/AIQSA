import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createSetDefaultPromptHandler } from "@/lib/server/prompts/handlers";
import { createPrismaPromptRepository } from "@/lib/server/prompts/prismaRepository";

export const runtime = "nodejs";

export const POST = createSetDefaultPromptHandler({
  repository: createPrismaPromptRepository(),
  resolveAuth: resolveRequestAuth
});

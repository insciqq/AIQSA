import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCreatePromptHandler } from "@/lib/server/prompts/handlers";
import { createPrismaPromptRepository } from "@/lib/server/prompts/prismaRepository";

export const runtime = "nodejs";

export const POST = createCreatePromptHandler({
  repository: createPrismaPromptRepository(),
  resolveAuth: resolveRequestAuth
});

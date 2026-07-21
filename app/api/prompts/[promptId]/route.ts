import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createDeletePromptHandler, createUpdatePromptHandler } from "@/lib/server/prompts/handlers";
import { createPrismaPromptRepository } from "@/lib/server/prompts/prismaRepository";

export const runtime = "nodejs";

export const PATCH = createUpdatePromptHandler({
  repository: createPrismaPromptRepository(),
  resolveAuth: resolveRequestAuth
});

export const DELETE = createDeletePromptHandler({
  repository: createPrismaPromptRepository(),
  resolveAuth: resolveRequestAuth
});

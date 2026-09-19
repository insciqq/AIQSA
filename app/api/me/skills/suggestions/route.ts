import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createSkillSuggestionHandler } from "@/lib/server/skills/suggestionHandler";
import { createPrismaSkillSuggestionService } from "@/lib/server/skills/suggestionService";

export const runtime = "nodejs";
export const POST = createSkillSuggestionHandler({ resolveAuth: resolveRequestAuth, suggest: createPrismaSkillSuggestionService(prisma) });

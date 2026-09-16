import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createInstructionPresetHandlers } from "@/lib/server/instructions/handlers";
import { createInstructionPresetStore } from "@/lib/server/instructions/store";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";
export const { GET, POST } = createInstructionPresetHandlers({ resolveAuth: resolveRequestAuth, store: createInstructionPresetStore(prisma) });

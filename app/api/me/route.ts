import { createUpdateAccountProfileHandler } from "@/lib/server/auth/accountHandlers";
import {
  createPrismaAccountProfileRepository,
  findAccountUserWithGroups
} from "@/lib/server/auth/accountRepository";
import { createMeHandler } from "@/lib/server/auth/handlers";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createMeHandler({
  findUserWithGroups: (userId) => findAccountUserWithGroups(prisma, userId),
  resolveAuth: resolveRequestAuth
});

export const PATCH = createUpdateAccountProfileHandler({
  repository: createPrismaAccountProfileRepository(prisma),
  resolveAuth: resolveRequestAuth
});

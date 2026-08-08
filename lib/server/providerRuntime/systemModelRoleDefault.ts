import { prisma } from "../prisma";
import { createSystemModelRoleResolver } from "./systemModelRole";

export const systemModelRoleResolver = createSystemModelRoleResolver(prisma);

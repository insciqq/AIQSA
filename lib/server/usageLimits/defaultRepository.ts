import { prisma } from "../prisma";
import { createUsageLimitsRepository } from "./repository";

export const usageLimitsRepository = createUsageLimitsRepository(prisma);

import { prisma } from "../../prisma";
import { createPrismaModelCheckUsageWriter } from "../providers/modelCheckUsage";
import { createAdminSearchService } from "./service";
import { createAdminSearchTester } from "./tester";

export const adminSearchService = createAdminSearchService({
  prisma,
  tester: createAdminSearchTester(prisma, { recordUsage: createPrismaModelCheckUsageWriter(prisma) })
});

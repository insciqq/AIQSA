import { prisma } from "../../prisma";
import { createAdminSearchService } from "./service";
import { createAdminSearchTester } from "./tester";

export const adminSearchService = createAdminSearchService({
  prisma,
  tester: createAdminSearchTester(prisma)
});

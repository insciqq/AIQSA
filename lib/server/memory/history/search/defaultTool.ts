import { prisma } from "../../../prisma";
import { defaultMemoryHistorySearchService } from "./defaultSearch";
import { createMemoryHistoryToolExecutor } from "./toolExecutor";

export const defaultMemoryHistoryToolExecutor = createMemoryHistoryToolExecutor({
  client: prisma,
  service: defaultMemoryHistorySearchService
});

import { prisma } from "../../prisma";
import { createAdminHealthQueuesService } from "./queues";
import { readAdminHealthQueueCounts } from "./queuesRepository";

/** Background queues over this installation's job tables. */
export const adminHealthQueuesService = createAdminHealthQueuesService({
  read: (queues, now) => readAdminHealthQueueCounts(prisma, { now, queues })
});

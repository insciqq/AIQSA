import { kickDefaultMemoryCoordinator } from "../../memory/coordinator/defaultCoordinator";
import { prisma } from "../../prisma";
import { createAdminMemoryEgressService } from "./egressService";

export const adminMemoryEgressService = createAdminMemoryEgressService(prisma, {
  onAcknowledged: kickDefaultMemoryCoordinator
});

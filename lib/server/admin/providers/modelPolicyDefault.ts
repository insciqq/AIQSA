import { prisma } from "../../prisma";
import { createAdminModelPolicyService } from "./modelPolicyService";

export const adminModelPolicyService = createAdminModelPolicyService(prisma);

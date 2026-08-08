import { prisma } from "../../prisma";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";

export const adminSystemModelPolicyService = createAdminSystemModelPolicyService(prisma);

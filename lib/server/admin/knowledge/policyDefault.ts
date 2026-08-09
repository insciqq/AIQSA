import { prisma } from "../../prisma";
import { createAdminKnowledgePolicyService } from "./policyService";

export const adminKnowledgePolicyService = createAdminKnowledgePolicyService(prisma);

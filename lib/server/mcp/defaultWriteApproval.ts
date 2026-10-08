import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createMcpApprovalHandlers } from "./writeApprovalHandlers";

export const mcpApprovalHandlers = createMcpApprovalHandlers({ prisma: () => prisma, resolveAuth: resolveRequestAuth });

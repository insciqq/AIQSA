import { listAnswerProblemReports } from "../../answerProblemReports/repository";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { createAdminHealthProblemReportsHandler } from "./problemReports";

export const adminHealthProblemReportsHandler = createAdminHealthProblemReportsHandler({
  read: (input) => listAnswerProblemReports(prisma, input),
  resolveAuth: resolveRequestAuth
});

import { isTestAuthEnabled } from "../auth/config";
import { prisma } from "../prisma";
import {
  createCapturedSmtpTransport,
  createEmailDispatcher,
  type EmailTestCapture
} from "./dispatcher";
import { createPrismaEmailRepository } from "./repository";
import { createAdminEmailService } from "./service";
import { createSmtpTransport } from "./smtpTransport";

export const emailRepository = createPrismaEmailRepository({ prisma });
export const smtpTransport = createSmtpTransport();
const testCapture: EmailTestCapture | undefined = isTestAuthEnabled(process.env)
  ? {
      async capture(message) {
        const { captureTestAuthEmail } = await import("../auth/testMailer");
        captureTestAuthEmail(message);
      }
    }
  : undefined;
const adminSmtpTransport = testCapture
  ? createCapturedSmtpTransport(testCapture)
  : smtpTransport;

export const adminEmailService = createAdminEmailService({
  repository: emailRepository,
  transport: adminSmtpTransport
});

export const emailDispatcher = createEmailDispatcher({
  repository: emailRepository,
  testCapture,
  transport: smtpTransport
});

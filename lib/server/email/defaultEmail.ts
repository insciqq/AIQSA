import { isTestAuthEnabled } from "../auth/config";
import { createTestEmailCapture } from "../auth/testMailer";
import { prisma } from "../prisma";
import {
  createCapturedSmtpTransport,
  createEmailDispatcher
} from "./dispatcher";
import { createPrismaEmailRepository } from "./repository";
import { createAdminEmailService } from "./service";
import { createSmtpTransport } from "./smtpTransport";

export const emailRepository = createPrismaEmailRepository({ prisma });
export const smtpTransport = createSmtpTransport();
const testCapture = isTestAuthEnabled(process.env) ? createTestEmailCapture() : undefined;
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

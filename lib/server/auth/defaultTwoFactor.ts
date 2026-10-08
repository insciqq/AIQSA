import { prisma } from "../prisma";
import { authRateLimiter, resolveRequestAuth } from "./defaultAuth";
import { getTotpKeys } from "./totp";
import type { TwoFactorHandlerDeps } from "./totpHandlers";
import { createPrismaTotpEnrolmentRepository } from "./totpRepository";

export const twoFactorHandlerDeps: TwoFactorHandlerDeps = {
  getKeys: () => getTotpKeys(),
  rateLimiter: authRateLimiter,
  repository: createPrismaTotpEnrolmentRepository(prisma),
  resolveAuth: resolveRequestAuth
};

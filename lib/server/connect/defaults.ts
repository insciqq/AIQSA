import { getAuthConfig } from "../auth/config";
import { resolveLoginRateLimitIdentity } from "../auth/clientIdentity";
import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import { prisma } from "../prisma";
import { createConnectAdminPolicyHandlers } from "./adminHandlers";
import { createConnectBrowserHandlers } from "./browserHandlers";
import { createConnectDeviceHandlers } from "./deviceHandlers";
import { createConnectPairingService } from "./pairingService";
import { getConnectPolicyGate } from "./policy";
import { createPrismaConnectPolicyRepository } from "./policyRepository";
import { getConnectRelay } from "./relay";
import { createPrismaConnectRepository } from "./repository";

/** Pairings a client address may start: a few retries of `aiqsa-connect login` behind one office address. */
export const CONNECT_PAIRING_CREATE_LIMIT = Object.freeze({ maxAttempts: 20, windowMs: 10 * 60_000 });
/** Polls a client address may send: one client polls every 2 seconds; this leaves room for a few. */
export const CONNECT_PAIRING_POLL_LIMIT = Object.freeze({ maxAttempts: 120, windowMs: 60_000 });
/** Code lookups and decisions an account may make: a typo or two per pairing, never enumeration. */
export const CONNECT_PAIRING_CODE_LIMIT = Object.freeze({ maxAttempts: 20, windowMs: 10 * 60_000 });

function limiter(limit: Readonly<{ maxAttempts: number; windowMs: number }>) {
  return createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    maxAttempts: limit.maxAttempts,
    prisma,
    windowMs: limit.windowMs
  });
}

function clientKey(request: Request): string | null {
  const identity = resolveLoginRateLimitIdentity(request, getAuthConfig());
  if (identity.status === "unavailable") return null;
  // Direct loopback has no remote identity; its requests share one budget.
  return identity.status === "available" ? identity.key : "local";
}

const repository = createPrismaConnectRepository(prisma);
const policy = getConnectPolicyGate();
const pairing = createConnectPairingService({
  codeSecret: () => getAuthConfig().sessionSecret,
  origin: () => new URL(getAuthConfig().appBaseUrl).origin,
  relay: getConnectRelay(),
  repository
});

export const connectDeviceHandlers = createConnectDeviceHandlers({
  clientKey,
  pairing,
  policy,
  rateLimits: { create: limiter(CONNECT_PAIRING_CREATE_LIMIT), poll: limiter(CONNECT_PAIRING_POLL_LIMIT) },
  relay: getConnectRelay(),
  repository
});

export const connectBrowserHandlers = createConnectBrowserHandlers({
  codeRateLimiter: limiter(CONNECT_PAIRING_CODE_LIMIT),
  pairing,
  policy,
  relay: getConnectRelay(),
  repository,
  resolveAuth: resolveRequestAuth
});

export const connectAdminPolicyHandlers = createConnectAdminPolicyHandlers({
  onUpdated(updated) {
    policy.remember(updated);
    if (!updated.enabled) getConnectRelay().disable();
  },
  repository: createPrismaConnectPolicyRepository(prisma),
  resolveAuth: resolveRequestAuth
});

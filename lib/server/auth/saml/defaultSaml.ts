import { prisma } from "../../prisma";
import { completeExternalSignIn } from "../externalIdentity";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import { resolveSignInMethods } from "../signInMethods";
import type { SamlMethodResolver, SamlSignInCompleter } from "./handlers";

/** The active SAML configuration, read like every method through `resolveSignInMethods()`. */
export const resolveSamlSignInMethod: SamlMethodResolver = async () => (await resolveSignInMethods()).saml ?? null;

/** Settles and issues the session in one transaction (`completeExternalSignIn`). */
export const completeSamlSignIn: SamlSignInCompleter = (input) => completeExternalSignIn(prisma, input);

/**
 * Starts per client in a window: generous for many people behind one address, small against
 * the request store's capacity, so one source cannot crowd out others' pending sign-ins.
 */
export const samlStartRateLimiter = createFixedWindowLoginRateLimiter({ maxAttempts: 120, windowMs: 10 * 60_000 });

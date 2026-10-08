import {
  isTrustedHeaderLoginOutcome,
  trustedHeaderSignInHref,
  type TrustedHeaderLoginOutcome
} from "@/lib/auth/trustedHeader";
import type { AuthConfig } from "../config";
import type { ResolvedSignInMethods } from "../signInMethods";
import { trustedHeaderModeAvailable } from "./method";

/**
 * Query parameters that keep the login page on screen: the `local` escape to the other sign-in
 * methods, an outcome to show, or a one-time link the page completes.
 */
const STAY_ON_LOGIN_PARAMETERS = ["invite", "local", "oauth", "reset", "trusted_header", "verify"] as const;

export type TrustedHeaderLoginState = {
  /** What the login page shows; absent while the method cannot sign anyone in. */
  login?: { outcome?: TrustedHeaderLoginOutcome };
  /** Where the login page sends a visitor without a session instead of rendering. */
  redirectTo: string | null;
};

/**
 * With the method active in trusted-proxy mode, a visitor without a session goes straight to
 * the trusted-header sign-in, unless a parameter keeps the page on screen.
 */
export async function trustedHeaderLoginState(input: {
  config: Pick<AuthConfig, "clientIdentityMode" | "configured">;
  hasSession(): Promise<boolean>;
  methods: ResolvedSignInMethods;
  nextPath: string;
  params: Readonly<Record<string, unknown>>;
}): Promise<TrustedHeaderLoginState> {
  if (!input.config.configured || !input.methods.trusted_header || !trustedHeaderModeAvailable(input.config)) {
    return { redirectTo: null };
  }
  const outcome = input.params.trusted_header;
  const login = isTrustedHeaderLoginOutcome(outcome) ? { outcome } : {};
  const stays = STAY_ON_LOGIN_PARAMETERS.some((name) => input.params[name] !== undefined);
  return {
    login,
    redirectTo: stays || (await input.hasSession()) ? null : trustedHeaderSignInHref(input.nextPath)
  };
}

/** Whether the browser's session cookie names a live session of an active account. */
export async function hasActiveSessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  // Loaded only here, so the login page opens the database only when the method is active.
  const [{ prisma }, { createPrismaAuthSessionStore }, { resolveAuthToken }] = await Promise.all([
    import("../../prisma"),
    import("../prismaSessions"),
    import("../requestAuth")
  ]);
  return (await resolveAuthToken(token, { sessions: createPrismaAuthSessionStore(prisma) })) !== null;
}

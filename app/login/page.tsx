import { AuthLogin } from "@/components/auth/AuthLogin";
import { safeInternalPath } from "@/lib/auth/internalPath";
import {
  isOAuthLoginOutcome,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS
} from "@/lib/auth/oauth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveSignInMethods, type ResolvedSignInMethods } from "@/lib/server/auth/signInMethods";
import type { SignInPolicySnapshot } from "@/lib/server/auth/signInPolicy";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in"
};

type LoginPageProps = {
  searchParams: Promise<{
    invite?: string;
    next?: string;
    oauth?: string;
    provider?: string;
    reason?: string;
    reset?: string;
    verify?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const config = getAuthConfig();
  const [methods, policy]: [ResolvedSignInMethods, SignInPolicySnapshot] = config.configured
    ? await Promise.all([resolveSignInMethods(), readSignInPolicy()])
    : [{}, { passwordLoginEnabled: true, registrationEnabled: true }];
  const oauthProviders = OAUTH_PROVIDER_IDS.filter((provider) => Boolean(methods[provider]));

  return (
    <AuthLogin
      directorySignIn={methods.ldap ? { loginUsesUsername: methods.ldap.config.loginUsesUsername } : undefined}
      inviteToken={params.invite}
      nextPath={safeInternalPath(params.next)}
      oauthOutcome={isOAuthLoginOutcome(params.oauth) ? params.oauth : undefined}
      oauthProvider={isOAuthProviderId(params.provider) ? params.provider : undefined}
      oauthProviders={oauthProviders}
      passwordLoginEnabled={policy.passwordLoginEnabled}
      registrationEnabled={policy.registrationEnabled}
      resetToken={params.reset}
      sessionExpired={params.reason === "session_expired"}
      verifyToken={params.verify}
    />
  );
}

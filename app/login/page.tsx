import { AuthLogin } from "@/components/auth/AuthLogin";
import { safeInternalPath } from "@/lib/auth/internalPath";
import {
  isOAuthLoginOutcome,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS
} from "@/lib/auth/oauth";
import { getAuthConfig } from "@/lib/server/auth/config";
import { oidcAutoRedirectPath } from "@/lib/server/auth/oidc/oidcLoginRedirect";
import { resolveSignInMethods, type ResolvedSignInMethods } from "@/lib/server/auth/signInMethods";
import type { SignInPolicySnapshot } from "@/lib/server/auth/signInPolicy";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign in"
};

type LoginPageProps = {
  searchParams: Promise<{
    invite?: string;
    local?: string;
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
  const nextPath = safeInternalPath(params.next);
  const oidcRedirect = oidcAutoRedirectPath({ config: methods.oidc?.config, nextPath, params });

  if (oidcRedirect) {
    redirect(oidcRedirect);
  }

  return (
    <AuthLogin
      inviteToken={params.invite}
      nextPath={nextPath}
      oauthOutcome={isOAuthLoginOutcome(params.oauth) ? params.oauth : undefined}
      oauthProvider={isOAuthProviderId(params.provider) ? params.provider : undefined}
      oauthProviders={oauthProviders}
      oidcButtonLabel={methods.oidc?.config.buttonLabel}
      passwordLoginEnabled={policy.passwordLoginEnabled}
      registrationEnabled={policy.registrationEnabled}
      resetToken={params.reset}
      sessionExpired={params.reason === "session_expired"}
      verifyToken={params.verify}
    />
  );
}

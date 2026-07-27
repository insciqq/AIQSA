import { AuthLogin } from "@/components/auth/AuthLogin";
import { safeInternalPath } from "@/lib/auth/internalPath";
import {
  isOAuthLoginOutcome,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS
} from "@/lib/auth/oauth";
import { getAuthConfig } from "@/lib/server/auth/config";

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
  const oauthProviders = config.configured
    ? OAUTH_PROVIDER_IDS.filter((provider) => Boolean(config.oauthProviders[provider]))
    : [];

  return (
    <AuthLogin
      inviteToken={params.invite}
      nextPath={safeInternalPath(params.next)}
      oauthOutcome={isOAuthLoginOutcome(params.oauth) ? params.oauth : undefined}
      oauthProvider={isOAuthProviderId(params.provider) ? params.provider : undefined}
      oauthProviders={oauthProviders}
      resetToken={params.reset}
      sessionExpired={params.reason === "session_expired"}
      verifyToken={params.verify}
    />
  );
}
